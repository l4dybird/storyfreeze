import nanomatch from 'nanomatch';
import { BaseBrowser, ChromiumNotFoundError, lazyPlaywrightBrowserBackend } from './browser.js';
import type { BrowserBackend } from './browser-backend.js';
import { BrowserProcessCoordinator, type BrowserSessionSource } from './browser-process-coordinator.js';
import type { Story } from './story.js';
import { CapturingBrowser } from './capturing-browser.js';
import type { MainOptions, RunMode } from './types.js';
import { FileSystem } from './file.js';
import { createScreenshotService } from './screenshot-service.js';
import { shardStories } from './shard-utilities.js';
import { ManagedStorybookConnection } from './managed-storybook-connection.js';
import { StorybookStoryIndexProvider, type StoryDescriptor } from './story-index-provider.js';
import { detectPreviewMode } from './story-navigator.js';
import { captureDiagnosticsEnabled, emitCaptureDiagnostic, measureCaptureDiagnostic } from './capture-diagnostics.js';

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.');
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.');
}

function measureRuntimePhase<T>(phase: string, action: () => Promise<T>) {
  return measureCaptureDiagnostic({ type: 'runtime-phase', phase }, action);
}

async function detectRunMode(storiesBrowser: BaseBrowser, opt: MainOptions) {
  const storyId = 'storyfreeze-probe--preview';
  const detection = await detectPreviewMode(
    storiesBrowser.page,
    new URL(opt.serverOptions.storybookUrl),
    storyId,
    5000,
    opt.mode,
    opt.signal,
  );
  opt.logger.log(`StoryFreeze runs with ${detection.mode} mode (${detection.reason}).`);
  return detection.mode;
}

type BootableCaptureWorker<T> = {
  boot(): Promise<T>;
  close(): Promise<void>;
};

export async function bootCaptureWorkers<T extends BootableCaptureWorker<T>>(
  workers: T[],
  signal?: AbortSignal,
): Promise<T[]> {
  throwIfAborted(signal);
  const results = await Promise.allSettled(
    workers.map((worker, workerId) =>
      measureCaptureDiagnostic({ type: 'runtime-phase', phase: 'capture-worker-boot', workerId }, () => worker.boot()),
    ),
  );
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  const interrupted = signal?.aborted
    ? signal.reason instanceof Error
      ? signal.reason
      : new Error('StoryFreeze was interrupted.')
    : undefined;

  if (failure || interrupted) {
    await Promise.allSettled(workers.map(worker => worker.close()));
    throw interrupted ?? failure!.reason;
  }

  return results.map(result => (result as PromiseFulfilledResult<T>).value);
}

async function bootCapturingBrowserAsWorkers(
  connection: ManagedStorybookConnection,
  opt: MainOptions,
  mode: RunMode,
  backend: BrowserBackend,
  sessionSource?: BrowserSessionSource,
) {
  const browsers = [...new Array(Math.max(opt.parallel, 1)).keys()].map(
    i => new CapturingBrowser(connection, opt, mode, i, backend, sessionSource),
  );
  await bootCaptureWorkers(browsers, opt.signal);
  opt.logger.debug(`Started ${browsers.length} capture browsers`);
  return browsers;
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

function toLegacyStory(descriptor: StoryDescriptor): Story {
  return { id: descriptor.id, kind: descriptor.title, story: descriptor.name, version: 'v5' };
}

type RuntimeResources = {
  workers: Array<Pick<CapturingBrowser, 'close'>>;
  storiesBrowser?: Pick<BaseBrowser, 'close'>;
  browserProcess?: Pick<BrowserProcessCoordinator, 'close'>;
  connection?: Pick<ManagedStorybookConnection, 'disconnect'>;
};

export async function disposeRuntimeResources(resources: RuntimeResources, logger: MainOptions['logger']) {
  const closeSafely = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      logger.debug(`Failed to dispose ${label}.`, error);
    }
  };

  await Promise.all(
    resources.workers.map((worker, index) => closeSafely(`capture worker ${index}`, () => worker.close())),
  );
  if (resources.storiesBrowser) {
    await closeSafely('stories browser', () => resources.storiesBrowser!.close());
  }
  if (resources.browserProcess) {
    await closeSafely('shared browser process', () => resources.browserProcess!.close());
  }
  if (resources.connection) {
    await closeSafely('Storybook connection', () => resources.connection!.disconnect());
  }
}

export interface MainDependencies {
  browserBackend: BrowserBackend;
}

const defaultMainDependencies: MainDependencies = {
  browserBackend: lazyPlaywrightBrowserBackend,
};

/**
 *
 * Run main process of StoryFreeze.
 *
 * @param mainOptions - Parameters for this procedure
 *
 **/
export async function main(mainOptions: MainOptions, overrides: Partial<MainDependencies> = {}) {
  const startupStartedAt = captureDiagnosticsEnabled() ? performance.now() : undefined;
  const { browserBackend } = { ...defaultMainDependencies, ...overrides };
  const logger = mainOptions.logger;
  const browserIsolation = mainOptions.trace ? 'process' : mainOptions.browserIsolation;
  const browserOptions =
    browserIsolation === mainOptions.browserIsolation ? mainOptions : { ...mainOptions, browserIsolation };
  const fileSystem = new FileSystem(mainOptions);
  let connection: ManagedStorybookConnection | undefined;
  let storiesBrowser: BaseBrowser | undefined;
  let browserProcess: BrowserProcessCoordinator | undefined;
  let workers: CapturingBrowser[] = [];

  try {
    // Wait for connection to Storybook server.
    connection = new ManagedStorybookConnection(mainOptions.serverOptions, logger);
    await measureRuntimePhase('storybook-connect', () => abortable(connection!.connect(), mainOptions.signal));
    logger.debug('Created to connection.');

    if (browserIsolation === 'context') {
      browserProcess = new BrowserProcessCoordinator(browserBackend, browserOptions);
    }

    // Launch a browser process and fetch names of all stories.
    storiesBrowser = new BaseBrowser(browserOptions, browserBackend, { role: 'story-index' }, browserProcess);
    await measureRuntimePhase('story-index-browser-boot', () => storiesBrowser!.boot());
    throwIfAborted(mainOptions.signal);
    logger.log('Executable Chromium path:', logger.color.magenta(storiesBrowser.executablePath));
    const storyIndexProvider = new StorybookStoryIndexProvider();
    const allStories = await measureRuntimePhase('story-index-load', () =>
      abortable(
        storyIndexProvider.load(new URL(mainOptions.serverOptions.storybookUrl), mainOptions.signal),
        mainOptions.signal,
      ),
    );
    logger.debug('Ended to fetch stories metadata.');

    const stories = filterStories(allStories, mainOptions.include, mainOptions.exclude);

    if (stories.length === 0) {
      logger.warn('There is no matched story. Check your include/exclude options.');
      return 0;
    }

    // Detect managed mode from StoryFreeze's owned preview protocol on the story iframe.
    const mode = await measureRuntimePhase('preview-mode-detection', () =>
      abortable(detectRunMode(storiesBrowser!, browserOptions), mainOptions.signal),
    );
    await measureRuntimePhase('story-index-browser-close', () => storiesBrowser!.close());
    storiesBrowser = undefined;

    const shardedStories = shardStories(
      stories.map(toLegacyStory),
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
        `Found ${logger.color.green(String(stories.length))} stories. ${logger.color.green(
          String(shardedStories.length),
        )} are being processed by this shard (number ${mainOptions.shard.shardNumber} of ${
          mainOptions.shard.totalShards
        }).`,
      );
    }

    // Launch browser processes to capture each story.
    workers = await measureRuntimePhase('capture-workers-boot', () =>
      bootCapturingBrowserAsWorkers(connection!, browserOptions, mode, browserBackend, browserProcess),
    );
    if (startupStartedAt !== undefined) {
      emitCaptureDiagnostic({
        type: 'runtime-phase',
        phase: 'startup-complete',
        state: 'end',
        durationMs: performance.now() - startupStartedAt,
      });
    }
    logger.debug('Created workers.');

    // Execution caputuring procedure.
    const captured = await measureRuntimePhase('capture-execution', () =>
      createScreenshotService({
        workers,
        stories: shardedStories,
        fileSystem,
        logger,
        forwardConsoleLogs: mainOptions.forwardConsoleLogs,
        trace: mainOptions.trace,
      }).execute(),
    );
    logger.debug('Ended ScreenshotService execution.');
    return captured;
  } catch (error) {
    if (error instanceof ChromiumNotFoundError) {
      throw new Error(
        'Chromium is not installed. Execute "npx playwright-core@1.61.1 install chromium" or set "--chromium-path" or "--chromium-channel".',
      );
    }
    throw error;
  } finally {
    // Shutdown workers and dispose connection.
    await measureRuntimePhase('runtime-dispose', () =>
      disposeRuntimeResources({ workers, storiesBrowser, browserProcess, connection }, logger),
    );
    logger.debug('Ended to dispose workers.');
    logger.debug('Ended to dispose connection.');
  }
}
