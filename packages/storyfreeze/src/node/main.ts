import nanomatch from 'nanomatch';
import { availableParallelism, freemem } from 'node:os';
import { BaseBrowser, ChromiumNotFoundError } from './browser.js';
import { lazyPlaywrightBrowserBackend } from './playwright-backend-loader.js';
import type { BrowserBackend, BrowserSessionOptions } from './browser-backend.js';
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
import { createBaseScreenshotOptions } from '../shared/screenshot-options-helper.js';
import { browserDeviceDescriptors } from './browser-device-registry.js';
import { generateCaptureManifest } from './capture-manifest.js';
import { createCapturePlan } from './capture-plan.js';
import { toViewport } from './emulation-profile.js';
import { BrowserRuntimeOrchestrator, selectTopology } from './browser-topology.js';
import { raceAgainstTimeout } from './async-utils.js';
import { createExecutionWorkload, prepareExecutionPlan } from './execution-plan.js';

const workerCloseTimeoutMs = 5_000;

async function boundedRuntimeOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
  onTimeout: (error: Error) => unknown = () => {},
) {
  const result = await raceAgainstTimeout(operation, timeoutMs, signal);
  if (result.timedOut) {
    const error = new Error(`${label} did not settle within ${timeoutMs} msec.`);
    try {
      void Promise.resolve(onTimeout(error)).catch(() => {});
    } catch {
      // The timeout remains the primary runtime failure.
    }
    throw error;
  }
  return result.value;
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.');
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let onAbort = () => {};
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    onAbort = () =>
      finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.')));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
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
  boot(options?: BrowserSessionOptions): Promise<T>;
  close(): Promise<void>;
};

export async function bootCaptureWorkers<T extends BootableCaptureWorker<T>>(
  workers: T[],
  signal?: AbortSignal,
  sessionOptions: Array<BrowserSessionOptions | undefined> = [],
  operationTimeoutMs = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  throwIfAborted(signal);
  const boots = workers.map((worker, workerId) =>
    measureCaptureDiagnostic({ type: 'runtime-phase', phase: 'capture-worker-boot', workerId }, () =>
      worker.boot(sessionOptions[workerId]),
    ),
  );
  try {
    return await boundedRuntimeOperation(Promise.all(boots), operationTimeoutMs, 'Capture worker boot', signal);
  } catch (error) {
    await Promise.allSettled(
      workers.map(worker =>
        raceAgainstTimeout(
          Promise.resolve().then(() => worker.close()),
          workerCloseTimeoutMs,
        ).catch(() => undefined),
      ),
    );
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.');
    }
    throw error;
  }
}

async function bootCapturingBrowserAsWorkers(
  connection: ManagedStorybookConnection,
  opt: MainOptions,
  mode: RunMode,
  backend: BrowserBackend,
  sessionSourceForWorker?: (workerId: number) => BrowserSessionSource | undefined,
  initialSessionOptions: Array<BrowserSessionOptions | undefined> = [],
  workerCount = Math.max(opt.parallel, 1),
  initialWorkerCount = workerCount,
  operationTimeoutMs = Number.POSITIVE_INFINITY,
) {
  const browsers = [...new Array(workerCount).keys()].map(
    i => new CapturingBrowser(connection, opt, mode, i, backend, sessionSourceForWorker?.(i)),
  );
  await bootCaptureWorkers(
    browsers.slice(0, initialWorkerCount),
    opt.signal,
    initialSessionOptions.slice(0, initialWorkerCount),
    operationTimeoutMs,
  );
  opt.logger.debug(`Started ${initialWorkerCount} of ${browsers.length} capture browsers`);
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
  browserRuntime?: Pick<BrowserRuntimeOrchestrator, 'close'>;
  connection?: Pick<ManagedStorybookConnection, 'disconnect'>;
};

export async function disposeRuntimeResources(resources: RuntimeResources, logger: MainOptions['logger']) {
  const closeSafely = async (label: string, action: () => Promise<unknown>) => {
    try {
      const result = await raceAgainstTimeout(Promise.resolve().then(action), workerCloseTimeoutMs);
      if (result.timedOut) logger.debug(`Timed out while disposing ${label}.`);
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
  if (resources.browserRuntime) {
    await closeSafely('browser runtime', () => resources.browserRuntime!.close());
  } else if (resources.browserProcess) {
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
  const operationTimeoutMs = Math.max(60_000, mainOptions.captureTimeout * 2, mainOptions.captureTimeout + 30_000);
  const fileSystem = new FileSystem(mainOptions);
  let connection: ManagedStorybookConnection | undefined;
  let storiesBrowser: BaseBrowser | undefined;
  let browserProcess: BrowserProcessCoordinator | undefined;
  let browserRuntime: BrowserRuntimeOrchestrator | undefined;
  let workers: CapturingBrowser[] = [];

  try {
    // Start the browser while the managed server is becoming ready; index loading follows readiness.
    connection = new ManagedStorybookConnection(mainOptions.serverOptions, logger);
    browserProcess = new BrowserProcessCoordinator(browserBackend, browserOptions);
    storiesBrowser = new BaseBrowser(browserOptions, browserBackend, { role: 'story-index' }, browserProcess);
    const storyIndexProvider = new StorybookStoryIndexProvider();
    const startupController = new AbortController();
    const startupSignal = mainOptions.signal
      ? AbortSignal.any([mainOptions.signal, startupController.signal])
      : startupController.signal;
    const connectionPromise = measureRuntimePhase('storybook-connect', () => connection!.connect(startupSignal));
    const browserBootPromise = measureRuntimePhase('story-index-browser-boot', () =>
      boundedRuntimeOperation(
        storiesBrowser!.boot(),
        operationTimeoutMs,
        'Story index browser boot',
        startupSignal,
        error => startupController.abort(error),
      ),
    );
    const storyIndexPromise = connectionPromise.then(() => {
      throwIfAborted(startupSignal);
      return measureRuntimePhase('story-index-load', () =>
        boundedRuntimeOperation(
          storyIndexProvider.load(new URL(mainOptions.serverOptions.storybookUrl), startupSignal),
          operationTimeoutMs,
          'Story index load',
          startupSignal,
          error => startupController.abort(error),
        ),
      );
    });
    const startupTasks = [connectionPromise, browserBootPromise, storyIndexPromise] as const;
    let allStories: readonly StoryDescriptor[];
    try {
      [, , allStories] = await Promise.all(startupTasks);
    } catch (error) {
      startupController.abort(error);
      await Promise.allSettled(startupTasks);
      throw error;
    }
    throwIfAborted(mainOptions.signal);
    logger.debug('Created to connection.');
    logger.log('Executable Chromium path:', logger.color.magenta(storiesBrowser.executablePath));
    logger.debug('Ended to fetch stories metadata.');

    const stories = filterStories(allStories, mainOptions.include, mainOptions.exclude);

    if (stories.length === 0) {
      logger.warn('There is no matched story. Check your include/exclude options.');
      return 0;
    }

    // Auto mode probes the addon. Explicit modes validate their contract on the first real story.
    const mode =
      browserOptions.mode === 'auto'
        ? await measureRuntimePhase('preview-mode-detection', () =>
            abortable(detectRunMode(storiesBrowser!, browserOptions), mainOptions.signal),
          )
        : browserOptions.mode;
    if (mode === 'simple' && browserOptions.captureProtocol === 'story-session') {
      throw new Error('The persistent capture protocol requires the managed Preview and the StoryFreeze addon.');
    }
    if (browserOptions.mode !== 'auto') {
      logger.log('StoryFreeze runs with managed mode (StoryFreeze addon required; validated on first capture).');
    }
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

    const baseScreenshotOptions = createBaseScreenshotOptions(browserOptions);
    const shardedStoryIds = new Set(shardedStories.map(story => story.id));
    const manifest = generateCaptureManifest({
      stories: stories.filter(story => shardedStoryIds.has(story.id)),
      baseOptions: baseScreenshotOptions,
      deviceDescriptors: browserDeviceDescriptors,
      mode,
      freshContext: false,
    });
    for (const warning of manifest.warnings) logger.warn(warning);
    const capturePlan = createCapturePlan(manifest);
    const executionWorkload = createExecutionWorkload(capturePlan, mainOptions.captureProtocol ?? 'auto');
    const topologySelection = selectTopology(
      executionWorkload,
      { cpuCount: availableParallelism(), availableMemoryBytes: freemem() },
      Math.max(browserOptions.parallel, 1),
      browserIsolation,
    );
    const executionPlan = prepareExecutionPlan(executionWorkload, topologySelection.topology.workerCount);
    const workerPlans = executionPlan.workers;
    browserRuntime = new BrowserRuntimeOrchestrator(
      browserBackend,
      browserOptions,
      topologySelection.topology,
      workerPlans,
      browserProcess,
    );
    browserProcess = undefined;
    emitCaptureDiagnostic({
      type: 'browser-topology',
      ...topologySelection.topology,
      initialWorkerCount: topologySelection.initialWorkerCount,
      maximumParallel: browserOptions.parallel,
      reason: topologySelection.reason,
      requestedMode: browserIsolation,
      workerProcessIds: browserRuntime.workerProcessIds,
    });
    logger.debug('Browser topology:', topologySelection.topology, topologySelection.reason);
    const initialSessionOptions = workerPlans.map(worker => {
      const profile = worker.workItems[0]?.profile;
      return profile ? { viewport: toViewport(profile) } : undefined;
    });

    // Launch browser processes to capture each story.
    workers = await measureRuntimePhase('capture-workers-boot', () =>
      bootCapturingBrowserAsWorkers(
        connection!,
        browserOptions,
        mode,
        browserBackend,
        workerId => browserRuntime!.sessionSourceForWorker(workerId),
        initialSessionOptions,
        topologySelection.topology.workerCount,
        topologySelection.initialWorkerCount,
        operationTimeoutMs,
      ),
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
        executionPlan,
        initialWorkerCount: topologySelection.initialWorkerCount,
        // This deadlock watchdog also covers cold browser boot and recovery, so
        // keep it deliberately looser than the per-attempt capture deadline.
        operationTimeoutMs,
        bootWorker: async workerId => {
          await workers[workerId].boot(initialSessionOptions[workerId]);
        },
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
      disposeRuntimeResources({ workers, storiesBrowser, browserProcess, browserRuntime, connection }, logger),
    );
    logger.debug('Ended to dispose workers.');
    logger.debug('Ended to dispose connection.');
  }
}
