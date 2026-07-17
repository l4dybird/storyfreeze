import {
  STORYFREEZE_STORY_SESSION_GLOBAL,
  STORYFREEZE_STORY_SESSION_PROTOCOL_VERSION,
  type OpenStorySessionRequest,
  type ResetVerification,
  type StorySessionPreviewProtocol,
  type VariantReady,
} from '../shared/preview-protocol.js';
import type { ScreenshotOptions, StorySessionResetContext } from '../shared/types.js';

type ResetHook = (context: StorySessionResetContext) => void | Promise<void>;

export type StorySessionContextLike = {
  args?: Record<string, unknown>;
  globals?: Record<string, unknown>;
};

type RuntimeRegistration = {
  storyId: string;
  reset?: ResetHook;
  args?: Record<string, unknown>;
  globals?: Record<string, unknown>;
  baseArgs?: Record<string, unknown>;
  baseGlobals?: Record<string, unknown>;
  baseActiveElement?: Element | null;
  baseRootFingerprint?: string;
};

type ActiveSession = OpenStorySessionRequest & {
  sessionGeneration: number;
  variantGeneration: number;
  activeVariantId?: string;
};

type StorySessionWindow = typeof window & {
  [STORYFREEZE_STORY_SESSION_GLOBAL]?: StorySessionPreviewProtocol;
  __STORYFREEZE_STORY_SESSION_RUNTIME__?: RuntimeRegistration;
};

function cloneState(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return { ...value };
  }
}

function restoreState(target: Record<string, unknown> | undefined, source: Record<string, unknown> | undefined) {
  if (!target || !source) return;
  for (const key of Object.keys(target)) {
    if (!Object.hasOwn(source, key)) delete target[key];
  }
  Object.assign(target, cloneState(source));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => typeof child !== 'function' && typeof child !== 'symbol')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function fingerprint(value: unknown): string {
  const source = JSON.stringify(canonicalize(value));
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function currentActiveElement(): Element | null {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return null;
  return active as Element;
}

function activeElementIdentity(element: Element | null = currentActiveElement()): string | null {
  if (!element) return null;
  return element.id ? `#${element.id}` : element.tagName?.toLowerCase() || null;
}

function blurActiveElement() {
  const active = document.activeElement as (Element & { blur?: () => void }) | null;
  active?.blur?.();
}

export function registerStorySessionRuntime(
  screenshotOptions: ScreenshotOptions,
  context: StorySessionContextLike & { id?: string },
  target: StorySessionWindow | undefined = typeof window === 'undefined' ? undefined : (window as StorySessionWindow),
) {
  if (!target || !context.id) return;
  const existing = target.__STORYFREEZE_STORY_SESSION_RUNTIME__;
  if (existing?.storyId === context.id) {
    if (screenshotOptions.reset) existing.reset = screenshotOptions.reset;
    return;
  }
  target.__STORYFREEZE_STORY_SESSION_RUNTIME__ = {
    storyId: context.id,
    ...(screenshotOptions.reset ? { reset: screenshotOptions.reset } : {}),
    ...(context.args ? { args: context.args, baseArgs: cloneState(context.args) } : {}),
    ...(context.globals ? { globals: context.globals, baseGlobals: cloneState(context.globals) } : {}),
  };
}

/** Captures the post-render/play state that every same-document reset must restore. */
export function snapshotStorySessionRuntime(
  storyId: string,
  target: StorySessionWindow | undefined = typeof window === 'undefined' ? undefined : (window as StorySessionWindow),
) {
  const runtime = target?.__STORYFREEZE_STORY_SESSION_RUNTIME__;
  if (!runtime || runtime.storyId !== storyId) return;
  runtime.baseArgs = cloneState(runtime.args);
  runtime.baseGlobals = cloneState(runtime.globals);
  runtime.baseActiveElement = currentActiveElement();
  const root = document.getElementById?.('storybook-root');
  runtime.baseRootFingerprint = root ? fingerprint(root.innerHTML) : undefined;
}

export function initializeStorySessionController(
  target: StorySessionWindow | undefined = typeof window === 'undefined' ? undefined : (window as StorySessionWindow),
) {
  if (!target || target[STORYFREEZE_STORY_SESSION_GLOBAL]) return;
  let generation = 0;
  let active: ActiveSession | undefined;

  const requireActive = () => {
    if (!active) throw new Error('No StoryFreeze story session is open.');
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
      const runtime = target.__STORYFREEZE_STORY_SESSION_RUNTIME__;
      if (!runtime || runtime.storyId !== request.storyId) {
        throw new Error(
          `Story session expected ${request.storyId}, but the active story is ${runtime?.storyId ?? 'unknown'}.`,
        );
      }
      if (runtime.baseArgs === undefined && runtime.args) runtime.baseArgs = cloneState(runtime.args);
      if (runtime.baseGlobals === undefined && runtime.globals) runtime.baseGlobals = cloneState(runtime.globals);
      if (runtime.baseActiveElement === undefined) runtime.baseActiveElement = currentActiveElement();
      if (runtime.baseRootFingerprint === undefined) {
        const root = document.getElementById?.('storybook-root');
        runtime.baseRootFingerprint = root ? fingerprint(root.innerHTML) : undefined;
      }
      active = { ...request, sessionGeneration: ++generation, variantGeneration: 0 };
      return baseReady(active);
    },
    async applyVariant(variantId): Promise<VariantReady> {
      const session = requireActive();
      session.variantGeneration += 1;
      session.activeVariantId = variantId;
      return { ...baseReady(session), variantId, variantGeneration: session.variantGeneration };
    },
    async resetVariant(variantId): Promise<ResetVerification> {
      const session = requireActive();
      if (variantId !== '__base__' && session.activeVariantId !== variantId) {
        throw new Error(
          `Story session reset expected ${session.activeVariantId ?? 'no active variant'}, received ${variantId}.`,
        );
      }
      const runtime = target.__STORYFREEZE_STORY_SESSION_RUNTIME__!;
      const baseActiveElement = runtime.baseActiveElement ?? null;
      if (currentActiveElement() !== baseActiveElement) blurActiveElement();
      await runtime.reset?.({ storyId: session.storyId, variantId });
      restoreState(runtime.args, runtime.baseArgs);
      restoreState(runtime.globals, runtime.baseGlobals);
      if (baseActiveElement === null) {
        blurActiveElement();
      } else if (currentActiveElement() !== baseActiveElement && baseActiveElement.isConnected !== false) {
        (baseActiveElement as HTMLElement).focus?.({ preventScroll: true });
      }
      const restoredActiveElement = currentActiveElement();
      const root = document.getElementById?.('storybook-root');
      session.activeVariantId = undefined;
      return {
        ...baseReady(session),
        activeElement: activeElementIdentity(restoredActiveElement),
        activeElementMatchesBaseline: restoredActiveElement === baseActiveElement,
        baseActiveElement: activeElementIdentity(baseActiveElement),
        ...(runtime.args ? { argsHash: fingerprint(runtime.args) } : {}),
        ...(runtime.baseArgs ? { baseArgsHash: fingerprint(runtime.baseArgs) } : {}),
        ...(runtime.globals ? { globalsHash: fingerprint(runtime.globals) } : {}),
        ...(runtime.baseGlobals ? { baseGlobalsHash: fingerprint(runtime.baseGlobals) } : {}),
        pendingRequestCount: 0,
        ...(runtime.baseRootFingerprint ? { baseRootFingerprint: runtime.baseRootFingerprint } : {}),
        ...(root ? { rootFingerprint: fingerprint(root.innerHTML) } : {}),
      };
    },
    async closeSession() {
      active = undefined;
    },
  };
}
