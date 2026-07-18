import {
  compareDeterministicStrings,
  type EmulationProfile,
  type ManifestCapture,
  type ManifestEligibility,
  type NormalizedCaptureOptions,
  type StoryFreezeManifest,
} from './capture-manifest.js';
import { emulationProfileKey, sameEmulationProfile } from './emulation-profile.js';

export type CaptureExecutionMode = 'manifest' | 'runtime-validation' | 'runtime-discovery';

export interface PlannedCapture {
  captureId: string;
  storyId: string;
  variantKey: string[];
  profile: EmulationProfile;
  options: NormalizedCaptureOptions;
  estimatedCostMs: number;
  executionMode: CaptureExecutionMode;
}

export interface CapturePlan {
  manifest: StoryFreezeManifest;
  captures: PlannedCapture[];
  profileCount: number;
  storyCount: number;
  estimatedCostMs: number;
}

export interface WorkerPlan {
  workerId: number;
  captures: PlannedCapture[];
  estimatedRemainingMs: number;
  lastProfile?: EmulationProfile;
  lastStoryId?: string;
}

function toExecutionMode(eligibility: ManifestEligibility): CaptureExecutionMode {
  return eligibility === 'static' ? 'manifest' : eligibility;
}

function toPlannedCapture(capture: ManifestCapture): PlannedCapture {
  return {
    captureId: capture.captureId,
    storyId: capture.storyId,
    variantKey: [...capture.variantKey],
    profile: { ...capture.profile },
    options: { ...capture.options, viewport: { ...capture.options.viewport } },
    estimatedCostMs: capture.planning.estimatedCostMs ?? 500,
    executionMode: toExecutionMode(capture.planning.eligibility),
  };
}

export function createCapturePlan(manifest: StoryFreezeManifest): CapturePlan {
  const captures = manifest.captures.map(toPlannedCapture);
  return {
    manifest,
    captures,
    profileCount: new Set(captures.map(capture => emulationProfileKey(capture.profile))).size,
    storyCount: new Set(captures.map(capture => capture.storyId)).size,
    estimatedCostMs: captures.reduce((total, capture) => total + capture.estimatedCostMs, 0),
  };
}

export function profileSwitchCost(current: EmulationProfile | undefined, next: EmulationProfile): number {
  if (!current || sameEmulationProfile(current, next)) return 0;
  if (current.isMobile !== next.isMobile || current.hasTouch !== next.hasTouch) return 350;
  if (current.deviceScaleFactor !== next.deviceScaleFactor || current.isLandscape !== next.isLandscape) return 100;
  return 15;
}

export function storySwitchCost(currentStoryId: string | undefined, nextStoryId: string): number {
  return !currentStoryId || currentStoryId === nextStoryId ? 0 : 25;
}

export function assignmentCost(worker: WorkerPlan, capture: PlannedCapture): number {
  return (
    worker.estimatedRemainingMs +
    profileSwitchCost(worker.lastProfile, capture.profile) +
    storySwitchCost(worker.lastStoryId, capture.storyId)
  );
}

/** Deterministically combines profile affinity with longest-processing-time load balancing. */
export function assignCapturePlan(plan: CapturePlan, workerCount: number): WorkerPlan[] {
  if (!Number.isSafeInteger(workerCount) || workerCount < 1) throw new Error('workerCount must be at least one.');
  const workers: WorkerPlan[] = Array.from({ length: workerCount }, (_, workerId) => ({
    workerId,
    captures: [],
    estimatedRemainingMs: 0,
  }));
  const captures = [...plan.captures].sort(
    (left, right) =>
      right.estimatedCostMs - left.estimatedCostMs || compareDeterministicStrings(left.captureId, right.captureId),
  );

  for (const capture of captures) {
    let worker = workers[0];
    let cost = assignmentCost(worker, capture);
    for (let index = 1; index < workers.length; index += 1) {
      const candidate = workers[index];
      const candidateCost = assignmentCost(candidate, capture);
      if (candidateCost < cost || (candidateCost === cost && candidate.workerId < worker.workerId)) {
        worker = candidate;
        cost = candidateCost;
      }
    }
    const transitionCost =
      profileSwitchCost(worker.lastProfile, capture.profile) + storySwitchCost(worker.lastStoryId, capture.storyId);
    worker.captures.push(capture);
    worker.estimatedRemainingMs += transitionCost + capture.estimatedCostMs;
    worker.lastProfile = capture.profile;
    worker.lastStoryId = capture.storyId;
  }
  return workers;
}
