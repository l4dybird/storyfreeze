import nanomatch from 'nanomatch';
import { CapturingBrowser } from './capturing-browser.js';
import { ChromiumNotFoundError, type BrowserSessionOptions } from './playwright-runtime.js';
import type { MainOptions } from './types.js';
import type { Story } from './story.js';
import { FileSystem } from './file.js';
import { createScreenshotService, type ScreenshotWorker } from './screenshot-service.js';
import { shardStories } from './shard-utilities.js';
import { ManagedStorybookConnection } from './managed-storybook-connection.js';
import { StorybookStoryIndexProvider, type StoryDescriptor } from './story-index-provider.js';
import { raceAgainstTimeout } from './async-utils.js';

const workerCloseTimeoutMs = 5_000;

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.');
}

type BootableCaptureWorker<T> = {
  boot(options?: BrowserSessionOptions, signal?: AbortSignal): Promise<T>;
  close(): Promise<void>;
};

export async function bootCaptureWorkers<T extends BootableCaptureWorker<T>>(
  workers: T[],
  signal?: AbortSignal,
): Promise<T[]> {
  throwIfAborted(signal);
  let firstFailure: { reason: unknown } | undefined;
  let closing: Promise<void> | undefined;
  const closeWorkers = () => {
    closing ??= Promise.allSettled(workers.map(worker => Promise.resolve().then(() => worker.close()))).then(
      () => undefined,
    );
    return closing;
  };
  const onAbort = () => {
    void closeWorkers();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const boots = workers.map(worker =>
    Promise.resolve()
      .then(() => worker.boot(undefined, signal))
      .catch(error => {
        firstFailure ??= { reason: error };
        void closeWorkers();
        throw error;
      }),
  );
  try {
    // close() invalidates an in-flight runtime generation and waits for any
    // late browser process before doing a second cleanup pass. Start that work
    // as soon as one boot fails or the caller aborts, but do not return until
    // every fixed worker and its cleanup have settled.
    const settled = await Promise.allSettled(boots);
    throwIfAborted(signal);
    if (firstFailure) throw firstFailure.reason;
    return settled.map(result => (result as PromiseFulfilledResult<T>).value);
  } catch (error) {
    await closeWorkers();
    if (signal?.aborted) throwIfAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function filterStories(
  flatStories: readonly StoryDescriptor[],
  include: string[],
  exclude: string[],
): StoryDescriptor[] {
  const combined = flatStories.map(story => ({ story, matchName: `${story.title}/${story.name}` }));
  const included = include.length
    ? combined.filter(({ matchName }) => include.some(rule => nanomatch.isMatch(matchName, rule)))
    : combined;
  const excluded = exclude.length
    ? included.filter(({ matchName }) => !exclude.some(rule => nanomatch.isMatch(matchName, rule)))
    : included;
  return excluded.map(({ story }) => story);
}

function toStory(descriptor: StoryDescriptor): Story {
  return {
    id: descriptor.id,
    kind: descriptor.title,
    story: descriptor.name,
    version: 'v5',
    ...(descriptor.viewportProfileHint ? { viewportProfileHint: descriptor.viewportProfileHint } : {}),
  };
}

export interface CaptureWorker extends ScreenshotWorker, BootableCaptureWorker<CaptureWorker> {
  readonly executablePath: string;
}

export type CaptureWorkerFactory = (
  connection: ManagedStorybookConnection,
  options: MainOptions,
  workerId: number,
) => CaptureWorker;

export interface MainDependencies {
  createCaptureWorker: CaptureWorkerFactory;
}

const defaultMainDependencies: MainDependencies = {
  createCaptureWorker: (connection, options, workerId) => new CapturingBrowser(connection, options, workerId),
};

export async function disposeRuntimeResources(
  workers: Array<Pick<CaptureWorker, 'close'>>,
  connection: Pick<ManagedStorybookConnection, 'disconnect'> | undefined,
  logger: MainOptions['logger'],
) {
  const closeSafely = async (label: string, action: () => Promise<unknown>) => {
    try {
      const result = await raceAgainstTimeout(Promise.resolve().then(action), workerCloseTimeoutMs);
      if (result.timedOut) logger.debug(`Timed out while disposing ${label}.`);
    } catch (error) {
      logger.debug(`Failed to dispose ${label}.`, error);
    }
  };
  await Promise.all(workers.map((worker, index) => closeSafely(`capture worker ${index}`, () => worker.close())));
  if (connection) await closeSafely('Storybook connection', () => connection.disconnect());
}

/** Run StoryFreeze against an externally hosted Storybook 10 static build. */
export async function main(mainOptions: MainOptions, overrides: Partial<MainDependencies> = {}) {
  const startedAt = performance.now();
  const dependencies = { ...defaultMainDependencies, ...overrides };
  const logger = mainOptions.logger;
  const fileSystem = new FileSystem(mainOptions);
  const operationTimeoutMs = Math.max(60_000, mainOptions.captureTimeout * 2);
  let connection: ManagedStorybookConnection | undefined;
  let workers: CaptureWorker[] = [];

  try {
    connection = new ManagedStorybookConnection(mainOptions.serverOptions, logger);
    const storyIndexProvider = new StorybookStoryIndexProvider();
    await connection.connect(mainOptions.signal);
    const allStories = await storyIndexProvider.load(new URL(connection.url), mainOptions.signal, operationTimeoutMs);
    throwIfAborted(mainOptions.signal);

    const stories = filterStories(allStories, mainOptions.include, mainOptions.exclude);
    if (stories.length === 0) {
      logger.warn('There is no matched story. Check your include/exclude options.');
      return 0;
    }
    const shardedStories = shardStories(
      stories.map(toStory),
      mainOptions.shard.shardNumber,
      mainOptions.shard.totalShards,
    );
    if (shardedStories.length === 0) {
      logger.log('This shard has no stories to screenshot.');
      return 0;
    }

    if (mainOptions.shard.totalShards === 1) {
      logger.log(`Found ${logger.color.green(String(stories.length))} stories.`);
    } else {
      logger.log(
        `Found ${logger.color.green(String(stories.length))} stories. ${logger.color.green(String(shardedStories.length))} are being processed by shard ${mainOptions.shard.shardNumber}/${mainOptions.shard.totalShards}.`,
      );
    }

    const workerCount = Math.min(Math.max(1, mainOptions.parallel), shardedStories.length);
    workers = Array.from({ length: workerCount }, (_, workerId) =>
      dependencies.createCaptureWorker(connection!, mainOptions, workerId),
    );
    await bootCaptureWorkers(workers, mainOptions.signal);
    logger.log('Executable Chromium path:', logger.color.magenta(workers[0].executablePath));
    logger.debug(`Started ${workers.length} persistent capture workers.`);

    const captured = await createScreenshotService({
      workers,
      stories: shardedStories,
      fileSystem,
      logger,
      forwardConsoleLogs: mainOptions.forwardConsoleLogs,
    }).execute();
    logger.log(`Captured ${captured} PNGs in ${Math.round(performance.now() - startedAt)} msec.`);
    return captured;
  } catch (error) {
    if (error instanceof ChromiumNotFoundError) {
      throw new Error(
        'Chromium is not installed. Execute "npx playwright-core@1.61.1 install chromium" or set "--chromium-path" or "--chromium-channel".',
      );
    }
    throw error;
  } finally {
    await disposeRuntimeResources(workers, connection, logger);
  }
}
