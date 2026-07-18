import type { PlannedCapture } from './capture-plan.js';
import type { EmulationProfile } from './emulation-profile.js';
import { compareDeterministicStrings } from './capture-manifest.js';

export type CaptureProtocolMode = 'strict' | 'story-session' | 'auto';

export type BatchEligibility = { mode: 'safe' } | { mode: 'validated' } | { mode: 'strict'; reason: string };

export interface PlannedVariantCapture {
  capture: PlannedCapture;
}

export interface StorySessionPlan {
  sessionId: string;
  storyId: string;
  profile: EmulationProfile;
  baseCapture: PlannedCapture;
  variants: PlannedVariantCapture[];
}

export interface StorySessionPlanningResult {
  sessions: StorySessionPlan[];
  strictCaptures: PlannedCapture[];
}

export interface SessionVariantRequest {
  variantKey: { isDefault: boolean; keys: string[] };
  plannedCapture?: PlannedCapture;
}

export interface SessionVariantOutput {
  variantKey: { isDefault: boolean; keys: string[] };
  buffer: Buffer | null;
  durationMs: number;
}

export interface SessionVariantExecutionResult {
  outputs: SessionVariantOutput[];
  strictFallbacks: SessionVariantRequest[];
}

/** Signals that an output callback transferred buffer ownership before it failed. */
export class SessionOutputConsumedError extends Error {
  constructor(readonly outputError: unknown) {
    super('The story-session output consumer failed after taking ownership of the buffer.', {
      cause: outputError,
    });
    this.name = 'SessionOutputConsumedError';
  }
}

export function classifyBatchEligibility(
  capture: Pick<PlannedCapture, 'options'>,
  options: { hasCustomReset?: boolean; allowRuntimeValidation?: boolean } = {},
): BatchEligibility {
  if (capture.options.waitFor) return { mode: 'strict', reason: 'variant-specific waitFor requires fresh navigation' };
  if (capture.options.click) {
    return options.hasCustomReset || options.allowRuntimeValidation
      ? { mode: 'validated' }
      : { mode: 'strict', reason: 'click has no custom reset hook' };
  }
  return { mode: 'safe' };
}

function emulationClassKey(profile: EmulationProfile): string {
  return [
    profile.deviceScaleFactor,
    profile.isMobile ? 1 : 0,
    profile.hasTouch ? 1 : 0,
    profile.isLandscape ? 1 : 0,
  ].join(':');
}

function sessionId(storyId: string, profile: EmulationProfile): string {
  return `${encodeURIComponent(storyId)}::${emulationClassKey(profile)}`;
}

/**
 * Builds opt-in sessions around a default capture. Different mobile/touch/DPR/orientation classes
 * remain fresh-navigation boundaries; width/height-only transitions may share a session.
 */
export function createStorySessionPlans(plan: { captures: readonly PlannedCapture[] }, mode: CaptureProtocolMode) {
  const strictCaptures: PlannedCapture[] = [];
  const sessions: StorySessionPlan[] = [];
  if (mode === 'strict') return { sessions, strictCaptures: [...plan.captures] } satisfies StorySessionPlanningResult;

  const byStory = new Map<string, PlannedCapture[]>();
  for (const capture of plan.captures) {
    const captures = byStory.get(capture.storyId) ?? [];
    captures.push(capture);
    byStory.set(capture.storyId, captures);
  }
  for (const [storyId, storyCaptures] of [...byStory].sort(([left], [right]) =>
    compareDeterministicStrings(left, right),
  )) {
    const byClass = new Map<string, PlannedCapture[]>();
    for (const capture of [...storyCaptures].sort((left, right) =>
      compareDeterministicStrings(left.captureId, right.captureId),
    )) {
      const captures = byClass.get(emulationClassKey(capture.profile)) ?? [];
      captures.push(capture);
      byClass.set(emulationClassKey(capture.profile), captures);
    }

    for (const classCaptures of [...byClass.values()].sort((left, right) =>
      compareDeterministicStrings(emulationClassKey(left[0].profile), emulationClassKey(right[0].profile)),
    )) {
      const defaultCapture = classCaptures.find(capture => capture.variantKey.length === 0);
      const baseCapture =
        defaultCapture ??
        classCaptures.find(
          capture =>
            classifyBatchEligibility(capture, {
              allowRuntimeValidation: capture.executionMode !== 'manifest',
            }).mode !== 'strict',
        );
      if (!baseCapture) {
        const eligibility = classifyBatchEligibility(classCaptures[0]);
        if (mode === 'story-session' && eligibility.mode === 'strict') {
          throw new Error(
            `Capture ${classCaptures[0].captureId} is not eligible for story-session mode: ${eligibility.reason}.`,
          );
        }
        strictCaptures.push(...classCaptures);
        continue;
      }

      const plannedVariants: PlannedVariantCapture[] = [];
      for (const capture of classCaptures.filter(capture => capture !== baseCapture)) {
        const eligibility = classifyBatchEligibility(capture, {
          allowRuntimeValidation: capture.executionMode !== 'manifest',
        });
        if (eligibility.mode === 'strict') {
          if (mode === 'story-session') {
            throw new Error(
              `Capture ${capture.captureId} is not eligible for story-session mode: ${eligibility.reason}.`,
            );
          }
          strictCaptures.push(capture);
          continue;
        }
        plannedVariants.push({ capture });
      }

      // A runtime-discovery default is retained as a session seed even before its variants are known.
      if (plannedVariants.length > 0 || baseCapture.executionMode === 'runtime-discovery') {
        sessions.push({
          sessionId: sessionId(storyId, baseCapture.profile),
          storyId,
          profile: baseCapture.profile,
          baseCapture,
          variants: plannedVariants,
        });
      } else {
        strictCaptures.push(baseCapture);
      }
    }
  }

  return {
    sessions: sessions.sort((left, right) => compareDeterministicStrings(left.sessionId, right.sessionId)),
    strictCaptures: strictCaptures.sort((left, right) => compareDeterministicStrings(left.captureId, right.captureId)),
  } satisfies StorySessionPlanningResult;
}
