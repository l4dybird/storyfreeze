import { time } from './async-utils.js';
import type { FileSystem } from './file.js';
import type { Logger } from './logger.js';
import type { Story } from './story.js';
import type { VariantKey } from '../shared/types.js';
import {
  captureDiagnosticsEnabled,
  emitCaptureDiagnostic,
  measureCaptureDiagnostic,
  subscribeCaptureDiagnostics,
} from './capture-diagnostics.js';
import { createCaptureId } from './capture-manifest.js';
import { CaptureLeaseQueue } from './capture-lease-queue.js';
import { profileSwitchCost, type PlannedCapture } from './capture-plan.js';
import { sameEmulationProfile, type EmulationProfile } from './emulation-profile.js';
import { variantKeyIdentifier } from '../shared/screenshot-options-helper.js';
import {
  SessionOutputConsumedError,
  type SessionVariantExecutionResult,
  type SessionVariantOutput,
  type SessionVariantRequest,
} from './story-session.js';
import type { CaptureProtocolMode } from './types.js';
import type { PreparedExecutionPlan } from './execution-plan.js';

interface CaptureRequest {
  captureId: string;
  rid: string;
  story: Story;
  storyId: string;
  variantKey: VariantKey;
  count: number;
  queuedAt?: number;
  profile?: EmulationProfile;
  profileHint?: string;
  estimatedCostMs?: number;
  plannedCapture?: PlannedCapture;
  sessionId?: string;
  sessionVariants?: SessionVariantRequest[];
}

function createRequest({
  story,
  variantKey = { isDefault: true, keys: [] },
  count = 0,
  plannedCapture,
  sessionId,
  sessionVariants,
  profileHint,
}: {
  story: Story;
  variantKey?: VariantKey;
  count?: number;
  plannedCapture?: PlannedCapture;
  sessionId?: string;
  sessionVariants?: SessionVariantRequest[];
  profileHint?: string;
}): CaptureRequest {
  const effectiveVariantKey = plannedCapture
    ? { isDefault: plannedCapture.variantKey.length === 0, keys: [...plannedCapture.variantKey] }
    : variantKey;
  const base = encodeURIComponent(story.id);
  const rid = effectiveVariantKey.keys.length
    ? `${base}?keys=${encodeURIComponent(variantKeyIdentifier(effectiveVariantKey.keys))}`
    : base;
  return {
    captureId: plannedCapture?.captureId ?? createCaptureId(story.id, effectiveVariantKey.keys),
    rid,
    story,
    storyId: story.id,
    variantKey: effectiveVariantKey,
    count,
    queuedAt: captureDiagnosticsEnabled() ? performance.now() : undefined,
    ...(plannedCapture
      ? {
          plannedCapture,
          profile: plannedCapture.profile,
          estimatedCostMs: plannedCapture.estimatedCostMs,
          ...(plannedCapture.profileHint === undefined ? {} : { profileHint: plannedCapture.profileHint }),
        }
      : {}),
    ...(!plannedCapture && profileHint !== undefined ? { profileHint } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionVariants ? { sessionVariants } : {}),
  };
}

function percentileSummary(values: number[]) {
  if (values.length === 0) return { p50: null, p95: null };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (rank: number) => sorted[Math.max(0, Math.ceil(rank * sorted.length) - 1)];
  return { p50: at(0.5), p95: at(0.95) };
}

async function withOperationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout: () => unknown | Promise<unknown> = async () => {},
): Promise<T> {
  const effectiveTimeout = Math.min(2_147_483_647, Math.max(1, Math.floor(timeoutMs)));
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      try {
        void Promise.resolve(onTimeout()).catch(() => {});
        reject(new Error(`${label} did not settle within ${effectiveTimeout} msec.`));
      } catch (error) {
        reject(
          new AggregateError(
            [error],
            `${label} did not settle within ${effectiveTimeout} msec and its worker could not be closed.`,
          ),
        );
      }
    }, effectiveTimeout);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/** Executor to capture all stories. */
export interface ScreenshotService {
  /** Run the capture procedure and return the number of PNG files written. */
  execute(): Promise<number>;
}

export interface ScreenshotWorker {
  close?(): Promise<void>;
  screenshot(
    requestId: string,
    story: Story,
    variantKey: VariantKey,
    retryCount: number,
    logger: Logger,
    forwardConsoleLogs: boolean,
    trace: boolean,
    fileSystem: FileSystem,
    plannedCapture?: PlannedCapture,
  ): Promise<{
    buffer: Buffer | null;
    succeeded: boolean;
    variantKeysToPush: VariantKey[];
    defaultVariantSuffix?: string;
  }>;
  screenshotSessionVariants?(
    sessionId: string,
    story: Story,
    requests: SessionVariantRequest[],
    logger: Logger,
    forwardConsoleLogs: boolean,
    trace: boolean,
    fileSystem: FileSystem,
    protocolMode: Exclude<CaptureProtocolMode, 'strict'>,
    /** Takes ownership of a non-null output buffer when it begins consuming it. */
    onOutput?: (output: SessionVariantOutput) => Promise<void>,
  ): Promise<SessionVariantExecutionResult>;
}

/** Parameters for {@link createScreenshotService}. */
export type ScreenshotServiceOptions = {
  logger: Logger;
  workers: ScreenshotWorker[];
  fileSystem: FileSystem;
  stories: Story[];
  forwardConsoleLogs: boolean;
  trace: boolean;
  executionPlan?: PreparedExecutionPlan;
  initialWorkerCount?: number;
  bootWorker?: (workerId: number) => Promise<void>;
  operationTimeoutMs?: number;
};

function initialAssignments(
  stories: Story[],
  workers: ScreenshotWorker[],
  executionPlan?: PreparedExecutionPlan,
): { assignments: CaptureRequest[][]; plannedWorkerCostMs: number[] } {
  const assignments = Array.from({ length: workers.length }, () => [] as CaptureRequest[]);
  if (!executionPlan) {
    stories.forEach((story, index) => assignments[index % workers.length].push(createRequest({ story })));
    return { assignments, plannedWorkerCostMs: assignments.map(queue => queue.length * 500) };
  }
  if (executionPlan.workers.length !== workers.length) {
    throw new Error(`Execution plan has ${executionPlan.workers.length} workers, but ${workers.length} are available.`);
  }

  const storiesById = new Map(stories.map(story => [story.id, story]));
  for (const workerPlan of executionPlan.workers) {
    for (const item of workerPlan.workItems) {
      const story = storiesById.get(item.storyId);
      if (!story) throw new Error(`Execution plan refers to unknown story ${item.storyId}.`);
      const session = item.session;
      assignments[workerPlan.workerId].push(
        createRequest({
          story,
          plannedCapture: item.primaryCapture,
          ...(session
            ? {
                sessionId: session.sessionId,
                sessionVariants: session.variants.map(variant => ({
                  variantKey: {
                    isDefault: variant.capture.variantKey.length === 0,
                    keys: [...variant.capture.variantKey],
                  },
                  plannedCapture: variant.capture,
                })),
              }
            : {}),
        }),
      );
    }
  }
  return {
    assignments,
    plannedWorkerCostMs: executionPlan.workers.map(worker => worker.estimatedRemainingMs),
  };
}

/** Create an affinity-aware, duplicate-safe screenshot service. */
export function createScreenshotService({
  fileSystem,
  logger,
  stories,
  workers,
  forwardConsoleLogs,
  trace,
  executionPlan,
  initialWorkerCount = workers.length,
  bootWorker,
  operationTimeoutMs = 60_000,
}: ScreenshotServiceOptions): ScreenshotService {
  if (workers.length === 0) throw new Error('No screenshot workers are available.');
  if (!Number.isSafeInteger(initialWorkerCount) || initialWorkerCount < 1 || initialWorkerCount > workers.length) {
    throw new Error('initialWorkerCount must identify at least one available worker.');
  }
  if (initialWorkerCount < workers.length && !bootWorker) {
    throw new Error('bootWorker is required when capture workers are started lazily.');
  }
  if (!Number.isFinite(operationTimeoutMs) || operationTimeoutMs < 1) {
    throw new Error('operationTimeoutMs must be a positive finite number.');
  }
  const capturePlan = executionPlan?.capturePlan;
  const captureProtocol = executionPlan?.captureProtocol ?? 'strict';
  const { assignments, plannedWorkerCostMs } = initialAssignments(stories, workers, executionPlan);
  const queue = new CaptureLeaseQueue(assignments);
  const diagnosticsEnabled = captureDiagnosticsEnabled();
  const initialCaptureCount = assignments.reduce((total, requests) => total + requests.length, 0);
  const queueDiagnostics = diagnosticsEnabled
    ? {
        busyWorkerMs: 0,
        inFlight: 0,
        peakInFlight: 0,
        peakQueued: initialCaptureCount,
        queueWaits: [] as number[],
        settled: 0,
        totalEnqueued: initialCaptureCount,
        actualWorkerBusyMs: workers.map(() => 0),
        estimationErrors: [] as number[],
        expensiveProfileSwitchCount: 0,
        profileSwitchCount: 0,
      }
    : undefined;
  const planDiagnostics = capturePlan
    ? {
        manifestCaptureCount: capturePlan.captures.length,
        runtimeDiscoveryCaptureCount: capturePlan.captures.filter(
          capture => capture.executionMode === 'runtime-discovery',
        ).length,
        runtimeValidationCaptureCount: capturePlan.captures.filter(
          capture => capture.executionMode === 'runtime-validation',
        ).length,
      }
    : undefined;

  if (capturePlan && planDiagnostics) {
    emitCaptureDiagnostic({
      type: 'phase1-plan',
      ...planDiagnostics,
      profileCount: capturePlan.profileCount,
      plannedWorkerCostMs,
      storyCount: capturePlan.storyCount,
    });
  }

  return {
    execute: async () => {
      const startedAt = diagnosticsEnabled ? performance.now() : 0;
      let runtimeValidationMismatchCount = 0;
      let viewportTriggeredNavigationCount = 0;
      const unsubscribeDiagnostics = diagnosticsEnabled
        ? subscribeCaptureDiagnostics(event => {
            if (event.type === 'runtime-validation-mismatch') runtimeValidationMismatchCount += 1;
            if (event.type === 'viewport-triggered-navigation') viewportTriggeredNavigationCount += 1;
          })
        : () => false;
      const lastProfiles: Array<EmulationProfile | undefined> = workers.map(() => undefined);
      const lastProfileHints: Array<string | undefined> = workers.map(() => undefined);
      const lastStoryIds: Array<string | undefined> = workers.map(() => undefined);
      const outputCaptureIds = new Set<string>();
      let captured = 0;
      let firstFailure: { error: unknown } | undefined;
      let inFlightCount = 0;
      let lazyWorkerBootCount = 0;
      const workerStates = workers.map((_, workerId) =>
        workerId < initialWorkerCount ? ('ready' as const) : ('dormant' as const),
      ) as Array<'dormant' | 'booting' | 'ready' | 'failed'>;
      const activationResolvers: Array<(active: boolean) => void> = [];
      const activations = workers.map(
        (_, workerId) =>
          new Promise<boolean>(resolve => {
            activationResolvers[workerId] = resolve;
            if (workerId < initialWorkerCount) resolve(true);
          }),
      );

      const deactivateDormantWorkers = () => {
        workerStates.forEach((state, workerId) => {
          if (state !== 'dormant') return;
          workerStates[workerId] = 'failed';
          activationResolvers[workerId](false);
        });
      };

      const requestAdditionalWorkers = () => {
        const desiredWorkerCount = Math.min(
          workers.length,
          Math.max(initialWorkerCount, queue.pendingCount + inFlightCount),
        );
        let availableWorkerCount = workerStates.filter(state => state === 'ready' || state === 'booting').length;
        while (availableWorkerCount < desiredWorkerCount) {
          const workerId = workerStates.findIndex(state => state === 'dormant');
          if (workerId < 0) return;
          workerStates[workerId] = 'booting';
          lazyWorkerBootCount += 1;
          availableWorkerCount += 1;
          void measureCaptureDiagnostic({ type: 'runtime-phase', phase: 'lazy-worker-boot', workerId }, () =>
            withOperationTimeout(
              bootWorker!(workerId),
              operationTimeoutMs,
              `Capture worker ${workerId} boot`,
              () => workers[workerId].close?.() ?? Promise.resolve(),
            ),
          ).then(
            () => {
              workerStates[workerId] = 'ready';
              activationResolvers[workerId](true);
              queue.wakeAll();
            },
            error => {
              workerStates[workerId] = 'failed';
              if (firstFailure === undefined) firstFailure = { error };
              activationResolvers[workerId](false);
              deactivateDormantWorkers();
              queue.wakeAll();
            },
          );
        }
      };

      const enqueueCapture = (request: CaptureRequest) => {
        if (!queue.enqueue(request)) return false;
        if (queueDiagnostics) {
          queueDiagnostics.totalEnqueued += 1;
          queueDiagnostics.peakQueued = Math.max(queueDiagnostics.peakQueued, queue.pendingCount);
        }
        emitCaptureDiagnostic({
          type: 'capture-discovered',
          captureId: request.captureId,
          requestId: request.rid,
          storyId: request.story.id,
          variantKey: request.variantKey.keys,
        });
        requestAdditionalWorkers();
        return true;
      };

      const saveCaptureOutput = async (
        story: Story,
        variantKey: VariantKey,
        buffer: Buffer | null,
        durationMs: number,
        retryCount: number,
        defaultVariantSuffix?: string,
      ) => {
        if (!buffer) return;
        const captureId = createCaptureId(story.id, variantKey.keys);
        if (outputCaptureIds.has(captureId)) {
          fileSystem.releaseScreenshotBuffer?.(buffer);
          return;
        }
        outputCaptureIds.add(captureId);
        try {
          const suffix = variantKey.isDefault && defaultVariantSuffix ? [defaultVariantSuffix] : variantKey.keys;
          const logicalId = JSON.stringify({ storyId: story.id, variantKey });
          const outputController = new AbortController();
          const path = await withOperationTimeout(
            fileSystem.saveScreenshot(story.kind, story.story, suffix, buffer, logicalId, outputController.signal),
            operationTimeoutMs,
            `Screenshot output ${captureId}`,
            () => outputController.abort(new Error(`Screenshot output ${captureId} timed out.`)),
          );
          logger.log(`Screenshot stored: ${logger.color.magenta(path)} in ${durationMs} msec.`);
          emitCaptureDiagnostic({
            type: 'capture-output',
            durationMs,
            path,
            requestId: variantKey.keys.length
              ? `${encodeURIComponent(story.id)}?keys=${encodeURIComponent(variantKeyIdentifier(variantKey.keys))}`
              : encodeURIComponent(story.id),
            retryCount,
            storyId: story.id,
            variantKey: variantKey.keys,
          });
          captured += 1;
        } catch (error) {
          outputCaptureIds.delete(captureId);
          throw error;
        }
      };

      const runWorker = async (worker: ScreenshotWorker, workerId: number) => {
        if (!(await activations[workerId])) return;
        while (firstFailure === undefined) {
          const lease = queue.lease(
            workerId,
            lastProfiles[workerId],
            lastStoryIds[workerId],
            lastProfileHints[workerId],
          );
          if (!lease) {
            if (queue.isDrained()) {
              deactivateDormantWorkers();
              return;
            }
            await queue.waitForChange();
            continue;
          }

          const request = lease.capture;
          queue.markRunning(request.captureId);
          inFlightCount += 1;
          const taskStartedAt = diagnosticsEnabled ? performance.now() : 0;
          const queueWaitMs = request.queuedAt === undefined ? undefined : performance.now() - request.queuedAt;
          const previousProfile = lastProfiles[workerId];
          if (request.profile) {
            const switchCost = profileSwitchCost(previousProfile, request.profile);
            if (queueDiagnostics && previousProfile && !sameEmulationProfile(previousProfile, request.profile)) {
              queueDiagnostics.profileSwitchCount += 1;
              if (switchCost >= 350) queueDiagnostics.expensiveProfileSwitchCount += 1;
            }
            lastProfiles[workerId] = request.profile;
            lastProfileHints[workerId] = request.profileHint;
          }
          lastStoryIds[workerId] = request.story.id;

          if (queueDiagnostics) {
            queueDiagnostics.inFlight += 1;
            queueDiagnostics.peakInFlight = Math.max(queueDiagnostics.peakInFlight, queueDiagnostics.inFlight);
            queueDiagnostics.queueWaits.push(queueWaitMs!);
          }
          if (queueWaitMs !== undefined) {
            emitCaptureDiagnostic({
              type: 'queue-task',
              state: 'start',
              durationMs: queueWaitMs,
              inFlight: queueDiagnostics!.inFlight,
              queued: queue.pendingCount,
              requestId: request.rid,
              retryCount: request.count,
              storyId: request.story.id,
              variantKey: request.variantKey.keys,
              workerId,
              leaseOwnerWorkerId: lease.ownerWorkerId,
              stolen: lease.stolen,
            });
          }

          let requeued = false;
          try {
            const [result, elapsedTime] = await time(
              withOperationTimeout(
                worker.screenshot(
                  request.rid,
                  request.story,
                  request.variantKey,
                  request.count,
                  logger,
                  forwardConsoleLogs,
                  trace,
                  fileSystem,
                  request.plannedCapture,
                ),
                operationTimeoutMs,
                `Capture ${request.captureId}`,
                () => worker.close?.() ?? Promise.resolve(),
              ),
            );
            const { succeeded, buffer, variantKeysToPush, defaultVariantSuffix } = result;

            if (!succeeded) {
              const retry = createRequest({
                story: request.story,
                variantKey: request.variantKey,
                count: request.count + 1,
                plannedCapture: request.plannedCapture,
                sessionId: request.sessionId,
                sessionVariants: request.sessionVariants,
                profileHint: request.profileHint,
              });
              queue.requeue(request.captureId, retry, workerId);
              requeued = true;
              if (queueDiagnostics) {
                queueDiagnostics.totalEnqueued += 1;
                queueDiagnostics.peakQueued = Math.max(queueDiagnostics.peakQueued, queue.pendingCount);
              }
              await Promise.resolve();
              continue;
            }

            await saveCaptureOutput(
              request.story,
              request.variantKey,
              buffer,
              elapsedTime,
              request.count,
              defaultVariantSuffix,
            );

            let sessionCandidates: Map<string, SessionVariantRequest> | undefined;
            if ((request.sessionVariants?.length ?? 0) > 0 || variantKeysToPush.length > 0) {
              sessionCandidates = new Map();
              for (const candidate of request.sessionVariants ?? []) {
                sessionCandidates.set(createCaptureId(request.story.id, candidate.variantKey.keys), candidate);
              }
              for (const variantKey of variantKeysToPush) {
                const captureId = createCaptureId(request.story.id, variantKey.keys);
                if (!sessionCandidates.has(captureId)) sessionCandidates.set(captureId, { variantKey });
              }
            }

            if (
              captureProtocol !== 'strict' &&
              request.sessionId &&
              worker.screenshotSessionVariants &&
              sessionCandidates &&
              sessionCandidates.size > 0
            ) {
              const sessionResult = await withOperationTimeout(
                worker.screenshotSessionVariants(
                  request.sessionId,
                  request.story,
                  [...sessionCandidates.values()],
                  logger,
                  forwardConsoleLogs,
                  trace,
                  fileSystem,
                  captureProtocol,
                  output =>
                    saveCaptureOutput(request.story, output.variantKey, output.buffer, output.durationMs, 0).catch(
                      error => {
                        throw new SessionOutputConsumedError(error);
                      },
                    ),
                ),
                operationTimeoutMs * (sessionCandidates.size + 2),
                `Story session ${request.sessionId}`,
                () => worker.close?.() ?? Promise.resolve(),
              );
              for (const output of sessionResult.outputs) {
                await saveCaptureOutput(request.story, output.variantKey, output.buffer, output.durationMs, 0);
              }
              for (const fallback of sessionResult.strictFallbacks) {
                enqueueCapture(
                  createRequest({
                    story: request.story,
                    variantKey: fallback.variantKey,
                    plannedCapture: fallback.plannedCapture,
                    profileHint: request.profileHint,
                  }),
                );
              }
            } else {
              for (const candidate of sessionCandidates?.values() ?? []) {
                enqueueCapture(
                  createRequest({
                    story: request.story,
                    variantKey: candidate.variantKey,
                    plannedCapture: candidate.plannedCapture,
                    profileHint: request.profileHint,
                  }),
                );
              }
            }
            if (queueDiagnostics && request.estimatedCostMs !== undefined) {
              queueDiagnostics.estimationErrors.push(Math.abs(elapsedTime - request.estimatedCostMs));
            }
            queue.complete(request.captureId);
          } catch (error) {
            queue.fail(request.captureId);
            if (firstFailure === undefined) firstFailure = { error };
            deactivateDormantWorkers();
            queue.wakeAll();
          } finally {
            if (queueDiagnostics) {
              const busyWorkerMs = performance.now() - taskStartedAt;
              queueDiagnostics.busyWorkerMs += busyWorkerMs;
              queueDiagnostics.actualWorkerBusyMs[workerId] += busyWorkerMs;
              queueDiagnostics.inFlight -= 1;
              queueDiagnostics.settled += 1;
              emitCaptureDiagnostic({
                type: 'queue-task',
                state: 'end',
                durationMs: busyWorkerMs,
                inFlight: queueDiagnostics.inFlight,
                queued: queue.pendingCount,
                requestId: request.rid,
                retryCount: request.count,
                storyId: request.story.id,
                variantKey: request.variantKey.keys,
                workerId,
                requeued,
              });
            }
            inFlightCount -= 1;
          }
        }
      };

      try {
        requestAdditionalWorkers();
        const workerResults = await Promise.allSettled(
          workers.map((worker, workerId) =>
            runWorker(worker, workerId).catch(error => {
              if (firstFailure === undefined) firstFailure = { error };
              deactivateDormantWorkers();
              queue.wakeAll();
              throw error;
            }),
          ),
        );
        for (const result of workerResults) {
          if (result.status === 'rejected' && firstFailure === undefined) firstFailure = { error: result.reason };
        }
        let flushFailure: { error: unknown } | undefined;
        if (fileSystem.flush) {
          try {
            await withOperationTimeout(
              Promise.resolve().then(() => fileSystem.flush!()),
              operationTimeoutMs,
              'Screenshot output flush',
            );
          } catch (error) {
            flushFailure = { error };
          }
        }
        if (firstFailure !== undefined && flushFailure !== undefined) {
          throw new AggregateError(
            [firstFailure.error, flushFailure.error],
            'Capture execution and output flush both failed.',
          );
        }
        if (firstFailure !== undefined) throw firstFailure.error;
        if (flushFailure !== undefined) throw flushFailure.error;
        return captured;
      } finally {
        unsubscribeDiagnostics();
        if (queueDiagnostics) {
          const durationMs = performance.now() - startedAt;
          const leaseDiagnostics = queue.snapshot;
          const queueWait = percentileSummary(queueDiagnostics.queueWaits);
          const estimationError = percentileSummary(queueDiagnostics.estimationErrors);
          emitCaptureDiagnostic({
            type: 'queue-summary',
            busyWorkerMs: queueDiagnostics.busyWorkerMs,
            busyWorkerUtilization:
              durationMs === 0 || workers.length === 0
                ? 0
                : queueDiagnostics.busyWorkerMs / (durationMs * workers.length),
            durationMs,
            bootedWorkerCount: initialWorkerCount + lazyWorkerBootCount,
            initialWorkerCount,
            peakInFlight: queueDiagnostics.peakInFlight,
            peakQueued: queueDiagnostics.peakQueued,
            queueWaitP50Ms: queueWait.p50,
            queueWaitP95Ms: queueWait.p95,
            settled: queueDiagnostics.settled,
            totalEnqueued: queueDiagnostics.totalEnqueued,
            workerCount: workers.length,
          });
          emitCaptureDiagnostic({
            type: 'phase1-summary',
            actualWorkerBusyMs: queueDiagnostics.actualWorkerBusyMs,
            affinityHitCount: leaseDiagnostics.affinityHitCount,
            affinityMissCount: leaseDiagnostics.affinityMissCount,
            duplicateEnqueueCount: leaseDiagnostics.duplicateEnqueueCount,
            estimationErrorP50: estimationError.p50,
            estimationErrorP95: estimationError.p95,
            expensiveProfileSwitchCount: queueDiagnostics.expensiveProfileSwitchCount,
            manifestCaptureCount: planDiagnostics?.manifestCaptureCount ?? initialCaptureCount,
            plannedWorkerCostMs,
            profileSwitchCount: queueDiagnostics.profileSwitchCount,
            runtimeDiscoveryCaptureCount: planDiagnostics?.runtimeDiscoveryCaptureCount ?? 0,
            runtimeValidationMismatchCount,
            stealCount: leaseDiagnostics.stealCount,
            viewportTriggeredNavigationCount,
            workerIdleMs: queueDiagnostics.actualWorkerBusyMs.map(busy => Math.max(0, durationMs - busy)),
          });
        }
      }
    },
  };
}
