import nanomatch from 'nanomatch';
import { BaseBrowser, ChromiumNotFoundError, puppeteerBrowserBackend } from './browser.js';
import type { BrowserBackend } from './browser-backend.js';
import type { Story } from './story.js';
import { CapturingBrowser } from './capturing-browser.js';
import type { MainOptions, RunMode } from './types.js';
import { FileSystem } from './file.js';
import { createScreenshotService } from './screenshot-service.js';
import { shardStories } from './shard-utilities.js';
import { ManagedStorybookConnection } from './managed-storybook-connection.js';
import { StorybookStoryIndexProvider, type StoryDescriptor } from './story-index-provider.js';
import { detectPreviewMode } from './story-navigator.js';

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

async function detectRunMode(storiesBrowser: BaseBrowser, opt: MainOptions) {
  const storyId = 'storyfreeze-probe--preview';
  const mode = await detectPreviewMode(
    storiesBrowser.page,
    new URL(opt.serverOptions.storybookUrl),
    storyId,
    5000,
    opt.signal,
  );
  opt.logger.log(`StoryFreeze runs with ${mode} mode`);
  return mode;
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
  const results = await Promise.allSettled(workers.map(worker => worker.boot()));
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
) {
  const browsers = [...new Array(Math.max(opt.parallel, 1)).keys()].map(
    i => new CapturingBrowser(connection, opt, mode, i, backend),
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
  if (resources.connection) {
    await closeSafely('Storybook connection', () => resources.connection!.disconnect());
  }
}

export interface MainDependencies {
  browserBackend: BrowserBackend;
}

const defaultMainDependencies: MainDependencies = {
  browserBackend: puppeteerBrowserBackend,
};

/**
 *
 * Run main process of StoryFreeze.
 *
 * @param mainOptions - Parameters for this procedure
 *
 **/
export async function main(mainOptions: MainOptions, overrides: Partial<MainDependencies> = {}) {
  const { browserBackend } = { ...defaultMainDependencies, ...overrides };
  const logger = mainOptions.logger;
  const fileSystem = new FileSystem(mainOptions);
  let connection: ManagedStorybookConnection | undefined;
  let storiesBrowser: BaseBrowser | undefined;
  let workers: CapturingBrowser[] = [];

  try {
    // Wait for connection to Storybook server.
    connection = new ManagedStorybookConnection(mainOptions.serverOptions, logger);
    await abortable(connection.connect(), mainOptions.signal);
    logger.debug('Created to connection.');

    // Launch Puppeteer process and fetch names of all stories.
    storiesBrowser = new BaseBrowser(mainOptions, browserBackend);
    await storiesBrowser.boot();
    throwIfAborted(mainOptions.signal);
    logger.log('Executable Chromium path:', logger.color.magenta(storiesBrowser.executablePath));
    const storyIndexProvider = new StorybookStoryIndexProvider();
    const allStories = await abortable(
      storyIndexProvider.load(new URL(mainOptions.serverOptions.storybookUrl), mainOptions.signal),
      mainOptions.signal,
    );
    logger.debug('Ended to fetch stories metadata.');

    const stories = filterStories(allStories, mainOptions.include, mainOptions.exclude);

    if (stories.length === 0) {
      logger.warn('There is no matched story. Check your include/exclude options.');
      return 0;
    }

    // Detect managed mode from StoryFreeze's owned preview protocol on the story iframe.
    const mode = await abortable(detectRunMode(storiesBrowser, mainOptions), mainOptions.signal);
    await storiesBrowser.close();
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

    // Launch Puppeteer processes to capture each story.
    workers = await bootCapturingBrowserAsWorkers(connection, mainOptions, mode, browserBackend);
    logger.debug('Created workers.');

    // Execution caputuring procedure.
    const captured = await abortable(
      createScreenshotService({
        workers,
        stories: shardedStories,
        fileSystem,
        logger,
        forwardConsoleLogs: mainOptions.forwardConsoleLogs,
        trace: mainOptions.trace,
      }).execute(),
      mainOptions.signal,
    );
    logger.debug('Ended ScreenshotService execution.');
    return captured;
  } catch (error) {
    if (error instanceof ChromiumNotFoundError) {
      throw new Error(
        `Chromium is not installed. Execute "npm i puppeteer" or install manually and set "--chromium-path" option.`,
      );
    }
    throw error;
  } finally {
    // Shutdown workers and dispose connection.
    await disposeRuntimeResources({ workers, storiesBrowser, connection }, logger);
    logger.debug('Ended to dispose workers.');
    logger.debug('Ended to dispose connection.');
  }
}
