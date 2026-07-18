import { compareDeterministicStrings } from './capture-manifest.js';
import {
  profileSwitchCost,
  storySwitchCost,
  type CaptureExecutionMode,
  type CapturePlan,
  type PlannedCapture,
} from './capture-plan.js';
import { emulationProfileKey, type EmulationProfile } from './emulation-profile.js';
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
}

export interface PreparedExecutionPlan extends ExecutionWorkload {
  workers: ExecutionWorkerPlan[];
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
    profileCount: new Set(workItems.map(item => emulationProfileKey(item.profile))).size,
    estimatedCostMs: workItems.reduce((total, item) => total + item.estimatedCostMs, 0),
  };
}

function incrementalAssignmentCost(worker: ExecutionWorkerPlan, item: ExecutionWorkItem) {
  return profileSwitchCost(worker.lastProfile, item.profile) + storySwitchCost(worker.lastStoryId, item.storyId);
}

/** Assigns each executable unit once; the resulting order is the order consumed by the runtime. */
export function prepareExecutionPlan(workload: ExecutionWorkload, workerCount: number): PreparedExecutionPlan {
  if (!Number.isSafeInteger(workerCount) || workerCount < 1) throw new Error('workerCount must be at least one.');
  const workers: ExecutionWorkerPlan[] = Array.from({ length: workerCount }, (_, workerId) => ({
    workerId,
    workItems: [],
    estimatedRemainingMs: 0,
  }));
  const workItems = [...workload.workItems].sort(
    (left, right) => right.estimatedCostMs - left.estimatedCostMs || compareDeterministicStrings(left.id, right.id),
  );

  for (const item of workItems) {
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
    selected.estimatedRemainingMs += incrementalAssignmentCost(selected, item) + item.estimatedCostMs;
    selected.workItems.push(item);
    selected.lastProfile = item.profile;
    selected.lastStoryId = item.storyId;
  }

  return { ...workload, workers };
}
