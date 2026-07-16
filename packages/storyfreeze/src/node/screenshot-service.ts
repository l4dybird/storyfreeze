import { createExecutionService, time } from './async-utils.js';
import type { FileSystem } from './file.js';
import type { Logger } from './logger.js';
import type { Story } from './story.js';
import type { VariantKey } from '../shared/types.js';
import { captureDiagnosticsEnabled, emitCaptureDiagnostic } from './capture-diagnostics.js';

function createRequest({
  story,
  variantKey = { isDefault: true, keys: [] },
  count = 0,
}: {
  story: Story;
  variantKey?: VariantKey;
  count?: number;
}) {
  let rid;
  const base = encodeURIComponent(story.id);
  if (variantKey && variantKey.keys.length) {
    rid = `${base}?keys=${encodeURIComponent(variantKey.keys.join(','))}`;
  } else {
    rid = base;
  }
  return {
    rid,
    story,
    variantKey,
    count,
    queuedAt: captureDiagnosticsEnabled() ? performance.now() : undefined,
  };
}

function percentile(values: number[], rank: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(rank * sorted.length) - 1)];
}

/**
 *
 * Executor to capture all stories.
 *
 **/
export interface ScreenshotService {
  /**
   *
   * Run capturing procedure.
   *
   * @returns The number of captured images
   **/
  execute(): Promise<number>;
}

export interface ScreenshotWorker {
  screenshot(
    requestId: string,
    story: Story,
    variantKey: VariantKey,
    retryCount: number,
    logger: Logger,
    forwardConsoleLogs: boolean,
    trace: boolean,
    fileSystem: FileSystem,
  ): Promise<{
    buffer: Buffer | null;
    succeeded: boolean;
    variantKeysToPush: VariantKey[];
    defaultVariantSuffix?: string;
  }>;
}

/**
 *
 * Parameters for {@link createScreenshotService}.
 *
 **/
export type ScreenshotServiceOptions = {
  logger: Logger;
  workers: ScreenshotWorker[];
  fileSystem: FileSystem;
  stories: Story[];
  forwardConsoleLogs: boolean;
  trace: boolean;
};

/**
 *
 * Create an instance of {@link ScreenshotService}.
 *
 * @param options - {@link ScreenshotServiceOptions}
 * @returns A `ScreenshotService` instance
 *
 **/
export function createScreenshotService({
  fileSystem,
  logger,
  stories,
  workers,
  forwardConsoleLogs,
  trace,
}: ScreenshotServiceOptions): ScreenshotService {
  const queueDiagnostics = captureDiagnosticsEnabled()
    ? {
        busyWorkerMs: 0,
        inFlight: 0,
        peakInFlight: 0,
        peakQueued: stories.length,
        queued: stories.length,
        queueWaits: [] as number[],
        settled: 0,
        totalEnqueued: stories.length,
      }
    : undefined;
  const service = createExecutionService(
    workers,
    stories.map(story => createRequest({ story })),
    ({ rid, story, variantKey, count, queuedAt }, { push }) =>
      async worker => {
        const taskStartedAt = queueDiagnostics ? performance.now() : 0;
        const queueWaitMs = queuedAt === undefined ? undefined : performance.now() - queuedAt;
        if (queueDiagnostics) {
          queueDiagnostics.queued = Math.max(0, queueDiagnostics.queued - 1);
          queueDiagnostics.inFlight += 1;
          queueDiagnostics.peakInFlight = Math.max(queueDiagnostics.peakInFlight, queueDiagnostics.inFlight);
          queueDiagnostics.queueWaits.push(queueWaitMs!);
        }
        if (queuedAt !== undefined) {
          emitCaptureDiagnostic({
            type: 'queue-task',
            state: 'start',
            durationMs: queueWaitMs,
            inFlight: queueDiagnostics!.inFlight,
            queued: queueDiagnostics!.queued,
            requestId: rid,
            retryCount: count,
            storyId: story.id,
            variantKey: variantKey.keys,
          });
        }
        const enqueue = (request: ReturnType<typeof createRequest>) => {
          if (queueDiagnostics) {
            queueDiagnostics.queued += 1;
            queueDiagnostics.peakQueued = Math.max(queueDiagnostics.peakQueued, queueDiagnostics.queued);
            queueDiagnostics.totalEnqueued += 1;
          }
          push(request);
        };

        try {
          // Delegate the request to the worker.
          const [result, elapsedTime] = await time(
            worker.screenshot(rid, story, variantKey, count, logger, forwardConsoleLogs, trace, fileSystem),
          );

          const { succeeded, buffer, variantKeysToPush, defaultVariantSuffix } = result;

          // Queue retry requests while the worker reports a retryable timeout.
          // The worker throws after the configured retry limit is reached.
          if (!succeeded) {
            enqueue(createRequest({ story, variantKey, count: count + 1 }));
            return false;
          }

          // Queue screenshot requests for additional variants.
          variantKeysToPush.forEach(variantKey => enqueue(createRequest({ story, variantKey })));

          if (buffer) {
            const suffix = variantKey.isDefault && defaultVariantSuffix ? [defaultVariantSuffix] : variantKey.keys;
            const logicalId = JSON.stringify({ storyId: story.id, variantKey });
            const path = await fileSystem.saveScreenshot(story.kind, story.story, suffix, buffer, logicalId);
            logger.log(`Screenshot stored: ${logger.color.magenta(path)} in ${elapsedTime} msec.`);
            emitCaptureDiagnostic({
              type: 'capture-output',
              durationMs: elapsedTime,
              path,
              requestId: rid,
              retryCount: count,
              storyId: story.id,
              variantKey: variantKey.keys,
            });
            return true;
          }
          return false;
        } finally {
          if (queueDiagnostics) {
            const busyWorkerMs = performance.now() - taskStartedAt;
            queueDiagnostics.busyWorkerMs += busyWorkerMs;
            queueDiagnostics.inFlight -= 1;
            queueDiagnostics.settled += 1;
            emitCaptureDiagnostic({
              type: 'queue-task',
              state: 'end',
              durationMs: busyWorkerMs,
              inFlight: queueDiagnostics.inFlight,
              queued: queueDiagnostics.queued,
              requestId: rid,
              retryCount: count,
              storyId: story.id,
              variantKey: variantKey.keys,
            });
          }
        }
      },
  );
  return {
    execute: async () => {
      const startedAt = queueDiagnostics ? performance.now() : 0;
      try {
        const captured = await service.execute();
        return captured.filter(Boolean).length;
      } finally {
        if (queueDiagnostics) {
          const durationMs = performance.now() - startedAt;
          emitCaptureDiagnostic({
            type: 'queue-summary',
            busyWorkerMs: queueDiagnostics.busyWorkerMs,
            busyWorkerUtilization:
              durationMs === 0 || workers.length === 0
                ? 0
                : queueDiagnostics.busyWorkerMs / (durationMs * workers.length),
            durationMs,
            peakInFlight: queueDiagnostics.peakInFlight,
            peakQueued: queueDiagnostics.peakQueued,
            queueWaitP50Ms: percentile(queueDiagnostics.queueWaits, 0.5),
            queueWaitP95Ms: percentile(queueDiagnostics.queueWaits, 0.95),
            settled: queueDiagnostics.settled,
            totalEnqueued: queueDiagnostics.totalEnqueued,
            workerCount: workers.length,
          });
        }
      }
    },
  };
}
