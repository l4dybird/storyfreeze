import { compareDeterministicStrings } from './capture-manifest.js';
import {
  profileAffinityKey,
  profileAffinitySwitchCost,
  storySwitchCost,
  type CaptureExecutionMode,
  type CapturePlan,
  type PlannedCapture,
} from './capture-plan.js';
import type { EmulationProfile } from './emulation-profile.js';
import { createStorySessionPlans, type CaptureProtocolMode, type StorySessionPlan } from './story-session.js';

export interface ExecutionWorkItem {
  id: string;
  kind: 'strict' | 'story-session';
  storyId: string;
  profile: EmulationProfile;
  primaryCapture: PlannedCapture;
  captures: readonly PlannedCapture[];
  session?: StorySessionPlan;
  estimatedCostMs: number;
  executionMode: CaptureExecutionMode;
  profileHint?: string;
  highCost: boolean;
}

export interface ExecutionWorkload {
  capturePlan: CapturePlan;
  captureProtocol: CaptureProtocolMode;
  workItems: readonly ExecutionWorkItem[];
  profileCount: number;
  estimatedCostMs: number;
}

export interface ExecutionWorkerPlan {
  workerId: number;
  workItems: ExecutionWorkItem[];
  estimatedRemainingMs: number;
  lastProfile?: EmulationProfile;
  lastStoryId?: string;
  lastProfileHint?: string;
}

export interface PreparedExecutionPlan extends ExecutionWorkload {
  workers: ExecutionWorkerPlan[];
}

interface AffinityGroup {
  key: string;
  workItems: ExecutionWorkItem[];
  estimatedCostMs: number;
}

function workItemExecutionMode(captures: readonly PlannedCapture[]): CaptureExecutionMode {
  if (captures.some(capture => capture.executionMode === 'runtime-discovery')) return 'runtime-discovery';
  if (captures.some(capture => capture.executionMode === 'runtime-validation')) return 'runtime-validation';
  return 'manifest';
}

function toWorkItem(capture: PlannedCapture): ExecutionWorkItem {
  return {
    id: `capture:${capture.captureId}`,
    kind: 'strict',
    storyId: capture.storyId,
    profile: capture.profile,
    primaryCapture: capture,
    captures: [capture],
    estimatedCostMs: capture.estimatedCostMs,
    executionMode: capture.executionMode,
    highCost: capture.options.fullPage || capture.profile.deviceScaleFactor > 1,
    ...(capture.profileHint === undefined ? {} : { profileHint: capture.profileHint }),
  };
}

function toSessionWorkItem(session: StorySessionPlan): ExecutionWorkItem {
  const captures = [session.baseCapture, ...session.variants.map(variant => variant.capture)];
  return {
    id: `session:${session.sessionId}`,
    kind: 'story-session',
    storyId: session.storyId,
    profile: session.profile,
    primaryCapture: session.baseCapture,
    captures,
    session,
    estimatedCostMs: captures.reduce((total, capture) => total + capture.estimatedCostMs, 0),
    executionMode: workItemExecutionMode(captures),
    highCost: captures.some(capture => capture.options.fullPage || capture.profile.deviceScaleFactor > 1),
    ...(session.baseCapture.profileHint === undefined ? {} : { profileHint: session.baseCapture.profileHint }),
  };
}

/** Converts capture metadata into the actual strict/session units that the runtime schedules. */
export function createExecutionWorkload(
  capturePlan: CapturePlan,
  captureProtocol: CaptureProtocolMode,
): ExecutionWorkload {
  const sessionPlanning = createStorySessionPlans(capturePlan, captureProtocol);
  const workItems = [
    ...sessionPlanning.strictCaptures.map(toWorkItem),
    ...sessionPlanning.sessions.map(toSessionWorkItem),
  ].sort((left, right) => compareDeterministicStrings(left.id, right.id));
  return {
    capturePlan,
    captureProtocol,
    workItems,
    profileCount: new Set(workItems.map(item => profileAffinityKey(item.profile, item.profileHint))).size,
    estimatedCostMs: workItems.reduce((total, item) => total + item.estimatedCostMs, 0),
  };
}

function incrementalAssignmentCost(worker: ExecutionWorkerPlan, item: ExecutionWorkItem) {
  return (
    profileAffinitySwitchCost(worker.lastProfile, worker.lastProfileHint, item.profile, item.profileHint) +
    storySwitchCost(worker.lastStoryId, item.storyId)
  );
}

function assignWorkItem(worker: ExecutionWorkerPlan, item: ExecutionWorkItem) {
  worker.estimatedRemainingMs += incrementalAssignmentCost(worker, item) + item.estimatedCostMs;
  worker.workItems.push(item);
  worker.lastProfile = item.profile;
  worker.lastProfileHint = item.profileHint;
  worker.lastStoryId = item.storyId;
}

function selectWorker(workers: readonly ExecutionWorkerPlan[], item: ExecutionWorkItem) {
  let selected = workers[0];
  let selectedCost = selected.estimatedRemainingMs + incrementalAssignmentCost(selected, item);
  for (let index = 1; index < workers.length; index += 1) {
    const candidate = workers[index];
    const candidateCost = candidate.estimatedRemainingMs + incrementalAssignmentCost(candidate, item);
    if (candidateCost < selectedCost || (candidateCost === selectedCost && candidate.workerId < selected.workerId)) {
      selected = candidate;
      selectedCost = candidateCost;
    }
  }
  return selected;
}

function createAffinityGroups(workItems: readonly ExecutionWorkItem[]): AffinityGroup[] {
  const byKey = new Map<string, ExecutionWorkItem[]>();
  for (const item of workItems) {
    const key = profileAffinityKey(item.profile, item.profileHint);
    const items = byKey.get(key) ?? [];
    items.push(item);
    byKey.set(key, items);
  }
  return [...byKey].map(([key, items]) => ({
    key,
    workItems: items.sort(
      (left, right) => right.estimatedCostMs - left.estimatedCostMs || compareDeterministicStrings(left.id, right.id),
    ),
    estimatedCostMs: items.reduce((total, item) => total + item.estimatedCostMs, 0),
  }));
}

/** Assigns each executable unit once; the resulting order is the order consumed by the runtime. */
export function prepareExecutionPlan(workload: ExecutionWorkload, workerCount: number): PreparedExecutionPlan {
  if (!Number.isSafeInteger(workerCount) || workerCount < 1) throw new Error('workerCount must be at least one.');
  const workers: ExecutionWorkerPlan[] = Array.from({ length: workerCount }, (_, workerId) => ({
    workerId,
    workItems: [],
    estimatedRemainingMs: 0,
  }));
  const groups = createAffinityGroups(workload.workItems).sort(
    (left, right) => right.estimatedCostMs - left.estimatedCostMs || compareDeterministicStrings(left.key, right.key),
  );
  if (groups.length === 0) return { ...workload, workers };

  if (!workload.workItems.some(item => item.profileHint !== undefined)) {
    const workItems = [...workload.workItems].sort(
      (left, right) => right.estimatedCostMs - left.estimatedCostMs || compareDeterministicStrings(left.id, right.id),
    );
    for (const item of workItems) assignWorkItem(selectWorker(workers, item), item);
    return { ...workload, workers };
  }

  if (groups.length <= workers.length) {
    const groupWorkers = new Map<string, ExecutionWorkerPlan[]>();
    groups.forEach((group, index) => groupWorkers.set(group.key, [workers[index]]));
    for (let workerId = groups.length; workerId < workers.length; workerId += 1) {
      const selectedGroup = [...groups].sort((left, right) => {
        const leftCount = groupWorkers.get(left.key)!.length;
        const rightCount = groupWorkers.get(right.key)!.length;
        const ratio = right.estimatedCostMs / rightCount - left.estimatedCostMs / leftCount;
        return ratio || compareDeterministicStrings(left.key, right.key);
      })[0];
      groupWorkers.get(selectedGroup.key)!.push(workers[workerId]);
    }
    for (const group of groups) {
      const candidates = groupWorkers.get(group.key)!;
      for (const item of group.workItems) assignWorkItem(selectWorker(candidates, item), item);
    }
  } else {
    for (const group of groups) {
      const selected = selectWorker(workers, group.workItems[0]);
      for (const item of group.workItems) assignWorkItem(selected, item);
    }
  }

  return { ...workload, workers };
}
