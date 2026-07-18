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
import { assignCapturePlan, profileSwitchCost, type CapturePlan, type PlannedCapture } from './capture-plan.js';
import { sameEmulationProfile, type EmulationProfile } from './emulation-profile.js';
import {
  createStorySessionPlans,
  type CaptureProtocolMode,
  type SessionVariantExecutionResult,
  type SessionVariantRequest,
} from './story-session.js';

interface CaptureRequest {
  captureId: string;
  rid: string;
  story: Story;
  storyId: string;
  variantKey: VariantKey;
  count: number;
  queuedAt?: number;
  profile?: EmulationProfile;
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
}: {
  story: Story;
  variantKey?: VariantKey;
  count?: number;
  plannedCapture?: PlannedCapture;
  sessionId?: string;
  sessionVariants?: SessionVariantRequest[];
}): CaptureRequest {
  const effectiveVariantKey = plannedCapture
    ? { isDefault: plannedCapture.variantKey.length === 0, keys: [...plannedCapture.variantKey] }
    : variantKey;
  const base = encodeURIComponent(story.id);
  const rid = effectiveVariantKey.keys.length
    ? `${base}?keys=${encodeURIComponent(effectiveVariantKey.keys.join(','))}`
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
        }
      : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionVariants ? { sessionVariants } : {}),
  };
}

function percentile(values: number[], rank: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(rank * sorted.length) - 1)];
}

async function withOperationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout: () => Promise<unknown> = async () => {},
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
  capturePlan?: CapturePlan;
  captureProtocol?: CaptureProtocolMode;
  initialWorkerCount?: number;
  bootWorker?: (workerId: number) => Promise<void>;
  operationTimeoutMs?: number;
};

function initialAssignments(
  stories: Story[],
  workers: ScreenshotWorker[],
  capturePlan?: CapturePlan,
  captureProtocol: CaptureProtocolMode = 'strict',
): { assignments: CaptureRequest[][]; plannedWorkerCostMs: number[] } {
  const assignments = Array.from({ length: workers.length }, () => [] as CaptureRequest[]);
  if (!capturePlan) {
    stories.forEach((story, index) => assignments[index % workers.length].push(createRequest({ story })));
    return { assignments, plannedWorkerCostMs: assignments.map(queue => queue.length * 500) };
  }

  const storiesById = new Map(stories.map(story => [story.id, story]));
  const workerPlans = assignCapturePlan(capturePlan, workers.length);
  const workerByCaptureId = new Map(
    workerPlans.flatMap(workerPlan =>
      workerPlan.captures.map(capture => [capture.captureId, workerPlan.workerId] as const),
    ),
  );
  const sessionPlanning = createStorySessionPlans(capturePlan, captureProtocol);
  for (const capture of sessionPlanning.strictCaptures) {
    const story = storiesById.get(capture.storyId);
    if (!story) throw new Error(`Capture plan refers to unknown story ${capture.storyId}.`);
    assignments[workerByCaptureId.get(capture.captureId)!].push(createRequest({ story, plannedCapture: capture }));
  }
  for (const session of sessionPlanning.sessions) {
    const story = storiesById.get(session.storyId);
    if (!story) throw new Error(`Capture plan refers to unknown story ${session.storyId}.`);
    assignments[workerByCaptureId.get(session.baseCapture.captureId)!].push(
      createRequest({
        story,
        plannedCapture: session.baseCapture,
        sessionId: session.sessionId,
        sessionVariants: session.variants.map(variant => ({
          variantKey: {
            isDefault: variant.capture.variantKey.length === 0,
            keys: [...variant.capture.variantKey],
          },
          plannedCapture: variant.capture,
        })),
      }),
    );
  }
  return { assignments, plannedWorkerCostMs: workerPlans.map(worker => worker.estimatedRemainingMs) };
}

/** Create an affinity-aware, duplicate-safe screenshot service. */
export function createScreenshotService({
  fileSystem,
  logger,
  stories,
  workers,
  forwardConsoleLogs,
  trace,
  capturePlan,
  captureProtocol = 'strict',
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
  const { assignments, plannedWorkerCostMs } = initialAssignments(stories, workers, capturePlan, captureProtocol);
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

  if (capturePlan) {
    emitCaptureDiagnostic({
      type: 'phase1-plan',
      manifestCaptureCount: capturePlan.captures.length,
      runtimeDiscoveryCaptureCount: capturePlan.captures.filter(
        capture => capture.executionMode === 'runtime-discovery',
      ).length,
      runtimeValidationCaptureCount: capturePlan.captures.filter(
        capture => capture.executionMode === 'runtime-validation',
      ).length,
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
      const lastStoryIds: Array<string | undefined> = workers.map(() => undefined);
      const outputCaptureIds = new Set<string>();
      let captured = 0;
      let firstError: unknown;
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
              if (firstError === undefined) firstError = error;
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
        if (outputCaptureIds.has(captureId)) return;
        outputCaptureIds.add(captureId);
        const suffix = variantKey.isDefault && defaultVariantSuffix ? [defaultVariantSuffix] : variantKey.keys;
        const logicalId = JSON.stringify({ storyId: story.id, variantKey });
        const path = await fileSystem.saveScreenshot(story.kind, story.story, suffix, buffer, logicalId);
        logger.log(`Screenshot stored: ${logger.color.magenta(path)} in ${durationMs} msec.`);
        emitCaptureDiagnostic({
          type: 'capture-output',
          durationMs,
          path,
          requestId: variantKey.keys.length
            ? `${encodeURIComponent(story.id)}?keys=${encodeURIComponent(variantKey.keys.join(','))}`
            : encodeURIComponent(story.id),
          retryCount,
          storyId: story.id,
          variantKey: variantKey.keys,
        });
        captured += 1;
      };

      const runWorker = async (worker: ScreenshotWorker, workerId: number) => {
        if (!(await activations[workerId])) return;
        while (firstError === undefined) {
          const lease = queue.lease(workerId, lastProfiles[workerId], lastStoryIds[workerId]);
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
              });
              queue.requeue(request.captureId, retry, workerId);
              requeued = true;
              if (queueDiagnostics) {
                queueDiagnostics.totalEnqueued += 1;
                queueDiagnostics.peakQueued = Math.max(queueDiagnostics.peakQueued, queue.pendingCount);
              }
              requestAdditionalWorkers();
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

            const sessionCandidates = new Map<string, SessionVariantRequest>();
            for (const candidate of request.sessionVariants ?? []) {
              sessionCandidates.set(createCaptureId(request.story.id, candidate.variantKey.keys), candidate);
            }
            for (const variantKey of variantKeysToPush) {
              const captureId = createCaptureId(request.story.id, variantKey.keys);
              if (!sessionCandidates.has(captureId)) sessionCandidates.set(captureId, { variantKey });
            }

            if (
              captureProtocol !== 'strict' &&
              request.sessionId &&
              worker.screenshotSessionVariants &&
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
                ),
                operationTimeoutMs * Math.max(1, sessionCandidates.size),
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
                  }),
                );
              }
            } else {
              for (const candidate of sessionCandidates.values()) {
                enqueueCapture(
                  createRequest({
                    story: request.story,
                    variantKey: candidate.variantKey,
                    plannedCapture: candidate.plannedCapture,
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
            if (firstError === undefined) firstError = error;
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
        await Promise.all(workers.map(runWorker));
        if (firstError !== undefined) throw firstError;
        return captured;
      } finally {
        unsubscribeDiagnostics();
        if (queueDiagnostics) {
          const durationMs = performance.now() - startedAt;
          const leaseDiagnostics = queue.snapshot;
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
            queueWaitP50Ms: percentile(queueDiagnostics.queueWaits, 0.5),
            queueWaitP95Ms: percentile(queueDiagnostics.queueWaits, 0.95),
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
            estimationErrorP50: percentile(queueDiagnostics.estimationErrors, 0.5),
            estimationErrorP95: percentile(queueDiagnostics.estimationErrors, 0.95),
            expensiveProfileSwitchCount: queueDiagnostics.expensiveProfileSwitchCount,
            manifestCaptureCount: capturePlan?.captures.length ?? initialCaptureCount,
            plannedWorkerCostMs,
            profileSwitchCount: queueDiagnostics.profileSwitchCount,
            runtimeDiscoveryCaptureCount:
              capturePlan?.captures.filter(capture => capture.executionMode === 'runtime-discovery').length ?? 0,
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
