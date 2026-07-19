import type { BrowserBackend, BrowserRuntimeOptions } from './browser-backend.js';
import { BrowserProcessCoordinator, type BrowserSessionSource } from './browser-process-coordinator.js';
import { profileAffinityKey, type CapturePlan, type WorkerPlan } from './capture-plan.js';
import type { ExecutionWorkerPlan, ExecutionWorkload } from './execution-plan.js';
import { compareDeterministicStrings } from './deterministic.js';

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

type SchedulablePlan = CapturePlan | ExecutionWorkload;
type SchedulableWorkerPlan = WorkerPlan | ExecutionWorkerPlan;

function plannedItems(plan: SchedulablePlan) {
  return 'workItems' in plan ? plan.workItems : plan.captures;
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

export function selectWorkerCount(plan: SchedulablePlan, maximumParallel: number) {
  assertPositiveInteger(maximumParallel, 'maximumParallel');
  const items = plannedItems(plan);
  const captureCount = items.length;
  if (captureCount === 0) return { initialWorkerCount: 0, workerCount: 0 };
  const initialWorkerCount = Math.min(maximumParallel, captureCount);
  const hasRuntimeDiscovery = items.some(item => item.executionMode === 'runtime-discovery');
  const hasAutoSessionFallback =
    'workItems' in plan &&
    plan.captureProtocol === 'auto' &&
    plan.workItems.some(item => item.kind === 'story-session');
  // Runtime discovery and auto-session validation can both expand one planned item into many strict captures.
  // Keep those slots dormant until queue depth requires them instead of permanently serializing the fallback.
  const workerCount =
    hasRuntimeDiscovery || hasAutoSessionFallback ? maximumParallel : Math.min(maximumParallel, captureCount);
  return { initialWorkerCount, workerCount };
}

export function selectTopology(
  plan: SchedulablePlan,
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
    const items = plannedItems(plan);
    const highCostRatio =
      items.filter(item =>
        'highCost' in item ? item.highCost : item.options.fullPage || item.profile.deviceScaleFactor > 1,
      ).length / items.length;
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
  workerPlans: readonly SchedulableWorkerPlan[],
  topology: BrowserTopology,
): number[] {
  validateBrowserTopology(topology);
  if (workerPlans.length !== topology.workerCount) {
    throw new Error(`Expected ${topology.workerCount} worker plans, received ${workerPlans.length}.`);
  }
  const ordered = [...workerPlans].sort((left, right) => {
    const leftProfile = 'workItems' in left ? left.workItems[0]?.profile : left.captures[0]?.profile;
    const rightProfile = 'workItems' in right ? right.workItems[0]?.profile : right.captures[0]?.profile;
    const leftHint = 'workItems' in left ? left.workItems[0]?.profileHint : left.captures[0]?.profileHint;
    const rightHint = 'workItems' in right ? right.workItems[0]?.profileHint : right.captures[0]?.profileHint;
    const profile = compareDeterministicStrings(
      leftProfile ? profileAffinityKey(leftProfile, leftHint) : '\uffff',
      rightProfile ? profileAffinityKey(rightProfile, rightHint) : '\uffff',
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
    workerPlans: readonly SchedulableWorkerPlan[],
    initialCoordinator?: BrowserProcessCoordinator,
  ) {
    validateBrowserTopology(topology);
    this.workerProcessIds = assignWorkersToBrowserProcesses(workerPlans, topology);
    if (initialCoordinator) {
      const retainedProcessId = this.workerProcessIds[0];
      if (retainedProcessId !== 0) {
        for (let index = 0; index < this.workerProcessIds.length; index += 1) {
          if (this.workerProcessIds[index] === 0) this.workerProcessIds[index] = retainedProcessId;
          else if (this.workerProcessIds[index] === retainedProcessId) this.workerProcessIds[index] = 0;
        }
      }
    }
    this.coordinators = Array.from({ length: topology.browserProcessCount }, (_, index) =>
      index === 0 && initialCoordinator ? initialCoordinator : new BrowserProcessCoordinator(backend, runtimeOptions),
    );
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
