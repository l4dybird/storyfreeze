import type { BrowserBackend, BrowserRuntimeOptions } from './browser-backend.js';
import { BrowserProcessCoordinator, type BrowserSessionSource } from './browser-process-coordinator.js';
import type { CapturePlan, WorkerPlan } from './capture-plan.js';
import { emulationProfileKey } from './emulation-profile.js';
import { compareDeterministicStrings } from './capture-manifest.js';

export type BrowserTopologyMode = 'process' | 'context' | 'hybrid' | 'auto';

export interface BrowserTopology {
  browserProcessCount: number;
  contextsPerBrowser: number;
  workerCount: number;
}

export interface RuntimeCapacity {
  cpuCount: number;
  availableMemoryBytes?: number;
}

export interface TopologySelection {
  topology: BrowserTopology;
  initialWorkerCount: number;
  reason: string;
}

function assertPositiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
}

export function validateBrowserTopology(topology: BrowserTopology): void {
  assertPositiveInteger(topology.browserProcessCount, 'browserProcessCount');
  assertPositiveInteger(topology.contextsPerBrowser, 'contextsPerBrowser');
  assertPositiveInteger(topology.workerCount, 'workerCount');
  if (topology.browserProcessCount * topology.contextsPerBrowser < topology.workerCount) {
    throw new Error('Browser topology does not provide enough context slots for its workers.');
  }
}

export function selectWorkerCount(plan: CapturePlan, maximumParallel: number) {
  assertPositiveInteger(maximumParallel, 'maximumParallel');
  const captureCount = plan.captures.length;
  if (captureCount === 0) return { initialWorkerCount: 0, workerCount: 0 };
  const runnableProfileGroupCount = Math.max(1, plan.profileCount);
  const initialWorkerCount = Math.min(maximumParallel, captureCount, runnableProfileGroupCount);
  const hasRuntimeDiscovery = plan.captures.some(capture => capture.executionMode === 'runtime-discovery');
  // Runtime-discovery plans reserve dormant slots because variants can expand the queue after the default capture.
  // Known plans preserve the configured compatibility capacity while still booting workers lazily.
  const workerCount = hasRuntimeDiscovery ? maximumParallel : Math.min(maximumParallel, captureCount);
  return { initialWorkerCount, workerCount };
}

export function selectTopology(
  plan: CapturePlan,
  capacity: RuntimeCapacity,
  maximumParallel: number,
  mode: BrowserTopologyMode,
): TopologySelection {
  assertPositiveInteger(capacity.cpuCount, 'capacity.cpuCount');
  const { initialWorkerCount, workerCount } = selectWorkerCount(plan, maximumParallel);
  if (workerCount === 0) throw new Error('Cannot select a browser topology for an empty capture plan.');

  let topology: BrowserTopology;
  let reason: string;
  if (mode === 'process') {
    topology = { browserProcessCount: workerCount, contextsPerBrowser: 1, workerCount };
    reason = 'process compatibility preset';
  } else if (mode === 'context') {
    topology = { browserProcessCount: 1, contextsPerBrowser: workerCount, workerCount };
    reason = 'context compatibility preset';
  } else if (mode === 'hybrid') {
    const browserProcessCount = Math.min(2, workerCount);
    topology = {
      browserProcessCount,
      contextsPerBrowser: Math.ceil(workerCount / browserProcessCount),
      workerCount,
    };
    reason = 'explicit hybrid preset';
  } else {
    const memoryConstrained =
      capacity.availableMemoryBytes !== undefined && capacity.availableMemoryBytes < 2 * 1024 ** 3;
    const highCostRatio =
      plan.captures.filter(capture => capture.options.fullPage || capture.profile.deviceScaleFactor > 1).length /
      plan.captures.length;
    if (workerCount <= 2 || memoryConstrained) {
      topology = { browserProcessCount: 1, contextsPerBrowser: workerCount, workerCount };
      reason = memoryConstrained ? 'auto: available memory favors process consolidation' : 'auto: small plan';
    } else {
      const browserProcessCount =
        highCostRatio >= 0.5 ? workerCount : Math.min(2, workerCount, Math.max(1, Math.floor(capacity.cpuCount / 2)));
      topology = {
        browserProcessCount,
        contextsPerBrowser: Math.ceil(workerCount / browserProcessCount),
        workerCount,
      };
      reason =
        highCostRatio >= 0.5
          ? 'auto: high-cost captures use separate browser processes'
          : 'auto: balanced hybrid topology';
    }
  }
  validateBrowserTopology(topology);
  return { topology, initialWorkerCount, reason };
}

/** Assigns profile-adjacent workers to the same process without exceeding context capacity. */
export function assignWorkersToBrowserProcesses(
  workerPlans: readonly WorkerPlan[],
  topology: BrowserTopology,
): number[] {
  validateBrowserTopology(topology);
  if (workerPlans.length !== topology.workerCount) {
    throw new Error(`Expected ${topology.workerCount} worker plans, received ${workerPlans.length}.`);
  }
  const ordered = [...workerPlans].sort((left, right) => {
    const leftProfile = left.captures[0]?.profile;
    const rightProfile = right.captures[0]?.profile;
    const profile = compareDeterministicStrings(
      leftProfile ? emulationProfileKey(leftProfile) : '\uffff',
      rightProfile ? emulationProfileKey(rightProfile) : '\uffff',
    );
    return profile || right.estimatedRemainingMs - left.estimatedRemainingMs || left.workerId - right.workerId;
  });
  const mapping = Array(topology.workerCount).fill(-1) as number[];
  ordered.forEach((worker, index) => {
    mapping[worker.workerId] = Math.min(
      topology.browserProcessCount - 1,
      Math.floor(index / topology.contextsPerBrowser),
    );
  });
  return mapping;
}

/** Owns the selected browser-process generations and maps workers to isolated contexts. */
export class BrowserRuntimeOrchestrator {
  readonly coordinators: BrowserProcessCoordinator[];
  readonly workerProcessIds: number[];
  private closePromise?: Promise<void>;

  constructor(
    backend: BrowserBackend,
    runtimeOptions: BrowserRuntimeOptions,
    readonly topology: BrowserTopology,
    workerPlans: readonly WorkerPlan[],
    initialCoordinator?: BrowserProcessCoordinator,
  ) {
    validateBrowserTopology(topology);
    this.coordinators = Array.from({ length: topology.browserProcessCount }, (_, index) =>
      index === 0 && initialCoordinator ? initialCoordinator : new BrowserProcessCoordinator(backend, runtimeOptions),
    );
    this.workerProcessIds = assignWorkersToBrowserProcesses(workerPlans, topology);
  }

  sessionSourceForWorker(workerId: number): BrowserSessionSource {
    const processId = this.workerProcessIds[workerId];
    const coordinator = this.coordinators[processId];
    if (!coordinator) throw new Error(`No browser process is assigned to worker ${workerId}.`);
    return coordinator;
  }

  close(): Promise<void> {
    this.closePromise ??= Promise.allSettled(this.coordinators.map(coordinator => coordinator.close())).then(
      results => {
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) throw failure.reason;
      },
    );
    return this.closePromise;
  }
}
