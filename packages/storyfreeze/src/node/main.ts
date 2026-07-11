import nanomatch from 'nanomatch';
import { StoriesBrowser, sleep, ChromiumNotFoundError, type Story } from 'storycrawler';
import { CapturingBrowser } from './capturing-browser.js';
import type { MainOptions, RunMode } from './types.js';
import { FileSystem } from './file.js';
import { createScreenshotService } from './screenshot-service.js';
import { shardStories, sortStories } from './shard-utilities.js';
import { ManagedStorybookConnection } from './managed-storybook-connection.js';

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

async function detectRunMode(storiesBrowser: StoriesBrowser, opt: MainOptions) {
  // Reuse `storiesBrowser` instance to avoid cost of re-launching another Puppeteer process.
  await storiesBrowser.page.goto(opt.serverOptions.storybookUrl);
  await sleep(100);

  // We can check whether the secret value is set by `register.js` or not.
  const registered: boolean | undefined = await storiesBrowser.page.evaluate(
    () => (window as any).__STORYFREEZE_MANAGED_MODE_REGISTERED__,
  );
  const mode: RunMode = registered ? 'managed' : 'simple';
  opt.logger.log(`StoryFreeze runs with ${mode} mode`);
  return mode;
}

async function bootCapturingBrowserAsWorkers(
  connection: ManagedStorybookConnection,
  opt: MainOptions,
  mode: RunMode,
  onBoot: (browser: CapturingBrowser) => void,
) {
  const browsers = await Promise.all(
    [...new Array(Math.max(opt.parallel, 1)).keys()].map(async i => {
      const browser = await new CapturingBrowser(connection, opt, mode, i).boot();
      if (opt.signal?.aborted) {
        await browser.close();
        throw opt.signal.reason instanceof Error ? opt.signal.reason : new Error('StoryFreeze was interrupted.');
      }
      onBoot(browser);
      return browser;
    }),
  );
  opt.logger.debug(`Started ${browsers.length} capture browsers`);
  return browsers;
}

export function filterStories(flatStories: Story[], include: string[], exclude: string[]): Story[] {
  const conbined = flatStories.map(s => ({ ...s, name: s.kind + '/' + s.story }));
  const included = include.length
    ? conbined.filter(s => include.some(rule => nanomatch.isMatch(s.name, rule)))
    : conbined;
  const excluded = exclude.length
    ? included.filter(s => !exclude.some(rule => nanomatch.isMatch(s.name, rule)))
    : included;
  return excluded;
}

type RuntimeResources = {
  workers: Array<Pick<CapturingBrowser, 'close'>>;
  storiesBrowser?: Pick<StoriesBrowser, 'close'>;
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

/**
 *
 * Run main process of StoryFreeze.
 *
 * @param mainOptions - Parameters for this procedure
 *
 **/
export async function main(mainOptions: MainOptions) {
  const logger = mainOptions.logger;
  const fileSystem = new FileSystem(mainOptions);
  let connection: ManagedStorybookConnection | undefined;
  let storiesBrowser: StoriesBrowser | undefined;
  let workers: CapturingBrowser[] = [];

  try {
    // Wait for connection to Storybook server.
    connection = new ManagedStorybookConnection(mainOptions.serverOptions, logger);
    await abortable(connection.connect(), mainOptions.signal);
    logger.debug('Created to connection.');

    // Launch Puppeteer process and fetch names of all stories.
    storiesBrowser = new StoriesBrowser(connection, mainOptions, logger);
    await storiesBrowser.boot();
    throwIfAborted(mainOptions.signal);
    logger.log('Executable Chromium path:', logger.color.magenta(storiesBrowser.executablePath));
    const allStories = await abortable(storiesBrowser.getStories(), mainOptions.signal);
    logger.debug('Ended to fetch stories metadata.');

    // Mode(simple / managed) detection.
    const mode = await abortable(detectRunMode(storiesBrowser, mainOptions), mainOptions.signal);
    await storiesBrowser.close();
    storiesBrowser = undefined;

    const stories = filterStories(allStories, mainOptions.include, mainOptions.exclude);

    if (stories.length === 0) {
      logger.warn('There is no matched story. Check your include/exclude options.');
      return 0;
    }

    const sortedStories = sortStories(stories);
    const shardedStories = shardStories(sortedStories, mainOptions.shard.shardNumber, mainOptions.shard.totalShards);

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
    workers = await abortable(
      bootCapturingBrowserAsWorkers(connection, mainOptions, mode, browser => workers.push(browser)),
      mainOptions.signal,
    );
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
        `Chromium is not installed. Execute "npm i puppeteer" or install manually and set "--chromiumPath" option.`,
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
