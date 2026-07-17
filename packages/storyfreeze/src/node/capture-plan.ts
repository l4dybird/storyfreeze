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

function compareWorkerCaptureOrder(left: PlannedCapture, right: PlannedCapture): number {
  const profile = compareDeterministicStrings(emulationProfileKey(left.profile), emulationProfileKey(right.profile));
  if (profile !== 0) return profile;
  const story = compareDeterministicStrings(left.storyId, right.storyId);
  if (story !== 0) return story;
  const dependency = left.variantKey.length - right.variantKey.length;
  if (dependency !== 0) return dependency;
  const cost = right.estimatedCostMs - left.estimatedCostMs;
  return cost !== 0 ? cost : compareDeterministicStrings(left.captureId, right.captureId);
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
    const worker = [...workers].sort(
      (left, right) => assignmentCost(left, capture) - assignmentCost(right, capture) || left.workerId - right.workerId,
    )[0];
    worker.captures.push(capture);
    worker.estimatedRemainingMs += capture.estimatedCostMs;
    worker.lastProfile = capture.profile;
    worker.lastStoryId = capture.storyId;
  }

  for (const worker of workers) worker.captures.sort(compareWorkerCaptureOrder);
  return workers;
}
