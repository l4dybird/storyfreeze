import {
  STORYFREEZE_STORY_SESSION_GLOBAL,
  STORYFREEZE_STORY_SESSION_PROTOCOL_VERSION,
  type OpenStorySessionRequest,
  type ResetVerification,
  type SessionReady,
  type StorySessionPreviewProtocol,
  type VariantReady,
} from '../shared/preview-protocol.js';
import type { ScreenshotOptions } from '../shared/types.js';
import {
  activeElementIdentity,
  blurActiveElement,
  currentActiveElement,
  documentFingerprint,
  fingerprint,
  restoreScrollSnapshot,
  restoreSelectionSnapshot,
  restoreState,
  scrollSnapshotMatches,
  selectionSnapshotMatches,
  snapshotBaseline,
  type ResetHook,
  type StorySessionRuntimeRegistration,
} from './story-session-state.js';

export type StorySessionContextLike = {
  args?: Record<string, unknown>;
  globals?: Record<string, unknown>;
};

type ActiveSession = OpenStorySessionRequest & {
  sessionGeneration: number;
  variantGeneration: number;
  runtime: StorySessionRuntimeRegistration;
  state: 'ready' | 'applied' | 'poisoned';
  activeVariantId?: string;
};

type StorySessionWindow = typeof window & {
  [STORYFREEZE_STORY_SESSION_GLOBAL]?: StorySessionPreviewProtocol;
  __STORYFREEZE_STORY_SESSION_RUNTIME__?: StorySessionRuntimeRegistration;
};

export function registerStorySessionRuntime(
  screenshotOptions: ScreenshotOptions,
  context: StorySessionContextLike & { id?: string },
  target: StorySessionWindow | undefined = typeof window === 'undefined' ? undefined : (window as StorySessionWindow),
) {
  if (!target || !context.id) return;
  const existing = target.__STORYFREEZE_STORY_SESSION_RUNTIME__;
  if (existing?.storyId === context.id) {
    if (screenshotOptions.reset) existing.reset = screenshotOptions.reset;
    existing.args = context.args;
    existing.globals = context.globals;
    return;
  }
  target.__STORYFREEZE_STORY_SESSION_RUNTIME__ = {
    storyId: context.id,
    ...(screenshotOptions.reset ? { reset: screenshotOptions.reset } : {}),
    ...(context.args ? { args: context.args } : {}),
    ...(context.globals ? { globals: context.globals } : {}),
  };
}

/** Replaces the reset hook after all screenshot-option fragments have been merged. */
export function setStorySessionReset(
  storyId: string,
  reset: ResetHook | undefined,
  target: StorySessionWindow | undefined = typeof window === 'undefined' ? undefined : (window as StorySessionWindow),
) {
  const runtime = target?.__STORYFREEZE_STORY_SESSION_RUNTIME__;
  if (runtime?.storyId === storyId) runtime.reset = reset;
}

/** Captures the post-render/play state that every same-document reset must restore. */
export function snapshotStorySessionRuntime(
  storyId: string,
  target: StorySessionWindow | undefined = typeof window === 'undefined' ? undefined : (window as StorySessionWindow),
) {
  const runtime = target?.__STORYFREEZE_STORY_SESSION_RUNTIME__;
  if (!runtime || runtime.storyId !== storyId) return;
  snapshotBaseline(runtime);
}

export function initializeStorySessionController(
  target: StorySessionWindow | undefined = typeof window === 'undefined' ? undefined : (window as StorySessionWindow),
) {
  if (!target || target[STORYFREEZE_STORY_SESSION_GLOBAL]) return;
  let generation = 0;
  let active: ActiveSession | undefined;

  const requireActive = (...states: ActiveSession['state'][]) => {
    if (!active) throw new Error('No StoryFreeze story session is open.');
    if (target.__STORYFREEZE_STORY_SESSION_RUNTIME__ !== active.runtime) {
      active.state = 'poisoned';
      throw new Error('The StoryFreeze story runtime changed during an active session.');
    }
    if (active.state === 'poisoned') throw new Error('The StoryFreeze story session is poisoned.');
    if (states.length > 0 && !states.includes(active.state)) {
      throw new Error(`StoryFreeze story session expected state ${states.join(' or ')}, received ${active.state}.`);
    }
    return active;
  };
  const baseReady = (session: ActiveSession) => ({
    storyId: session.storyId,
    sessionGeneration: session.sessionGeneration,
    profileHash: session.profileHash,
  });

  target[STORYFREEZE_STORY_SESSION_GLOBAL] = {
    protocolVersion: STORYFREEZE_STORY_SESSION_PROTOCOL_VERSION,
    async openSession(request) {
      if (active) throw new Error('A StoryFreeze story session is already open.');
      const runtime = target.__STORYFREEZE_STORY_SESSION_RUNTIME__;
      if (!runtime || runtime.storyId !== request.storyId) {
        throw new Error(
          `Story session expected ${request.storyId}, but the active story is ${runtime?.storyId ?? 'unknown'}.`,
        );
      }
      if (runtime.baselineError) throw new Error(runtime.baselineError);
      if (!runtime.baselineCaptured) snapshotBaseline(runtime);
      if (runtime.baselineError) throw new Error(runtime.baselineError);
      if (runtime.baseDocumentFingerprint === undefined) {
        throw new Error('Story session cannot validate the preview document state.');
      }
      active = { ...request, sessionGeneration: ++generation, variantGeneration: 0, runtime, state: 'ready' };
      return baseReady(active);
    },
    async applyVariant(variantId): Promise<VariantReady> {
      const session = requireActive('ready');
      session.variantGeneration += 1;
      session.activeVariantId = variantId;
      session.state = 'applied';
      return { ...baseReady(session), variantId, variantGeneration: session.variantGeneration };
    },
    async resetVariant(variantId): Promise<SessionReady> {
      const session = requireActive(variantId === '__base__' ? 'ready' : 'applied');
      if (variantId !== '__base__' && session.activeVariantId !== variantId) {
        throw new Error(
          `Story session reset expected ${session.activeVariantId ?? 'no active variant'}, received ${variantId}.`,
        );
      }
      const runtime = session.runtime;
      const baseActiveElement = runtime.baseActiveElement ?? null;
      try {
        if (currentActiveElement() !== baseActiveElement) blurActiveElement();
        await runtime.reset?.({ storyId: session.storyId, variantId });
        restoreState(runtime.args, runtime.baseArgs);
        restoreState(runtime.globals, runtime.baseGlobals);
        if (baseActiveElement === null) {
          blurActiveElement();
        } else if (currentActiveElement() !== baseActiveElement && baseActiveElement.isConnected !== false) {
          (baseActiveElement as HTMLElement).focus?.({ preventScroll: true });
        }
        restoreSelectionSnapshot(runtime.baseSelectionSnapshot);
        restoreScrollSnapshot(runtime.baseScrollSnapshot);
        session.activeVariantId = undefined;
        session.state = 'ready';
        return baseReady(session);
      } catch (error) {
        session.state = 'poisoned';
        throw error;
      }
    },
    async verifyReset(): Promise<ResetVerification> {
      const session = requireActive('ready');
      const runtime = session.runtime;
      const restoredActiveElement = currentActiveElement();
      const currentDocumentFingerprint = documentFingerprint();
      if (
        !runtime.baseArgsHash ||
        !runtime.baseGlobalsHash ||
        !runtime.baseDocumentFingerprint ||
        !currentDocumentFingerprint
      ) {
        session.state = 'poisoned';
        throw new Error('Story session baseline verification is incomplete.');
      }
      return {
        ...baseReady(session),
        activeElement: activeElementIdentity(restoredActiveElement),
        activeElementMatchesBaseline: restoredActiveElement === (runtime.baseActiveElement ?? null),
        baseActiveElement: activeElementIdentity(runtime.baseActiveElement ?? null),
        argsHash: fingerprint(runtime.args),
        baseArgsHash: runtime.baseArgsHash,
        globalsHash: fingerprint(runtime.globals),
        baseGlobalsHash: runtime.baseGlobalsHash,
        baseDocumentFingerprint: runtime.baseDocumentFingerprint,
        documentFingerprint: currentDocumentFingerprint,
        scrollPositionMatchesBaseline: scrollSnapshotMatches(runtime.baseScrollSnapshot),
        selectionMatchesBaseline: selectionSnapshotMatches(runtime.baseSelectionSnapshot),
      };
    },
    async closeSession() {
      active = undefined;
    },
  };
}
