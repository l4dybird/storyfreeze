import {
  STORYFREEZE_STORY_SESSION_GLOBAL,
  STORYFREEZE_STORY_SESSION_PROTOCOL_VERSION,
  type OpenStorySessionRequest,
  type ResetVerification,
  type SessionReady,
  type StorySessionPreviewProtocol,
  type VariantReady,
} from '../shared/preview-protocol.js';
import type { ScreenshotOptions, StorySessionResetContext } from '../shared/types.js';

type ResetHook = (context: StorySessionResetContext) => void | Promise<void>;

type ScrollSnapshot = {
  elements: Array<{ element: Element; left: number; top: number }>;
  windowX: number;
  windowY: number;
};

export type StorySessionContextLike = {
  args?: Record<string, unknown>;
  globals?: Record<string, unknown>;
};

type RuntimeRegistration = {
  storyId: string;
  reset?: ResetHook;
  args?: Record<string, unknown>;
  globals?: Record<string, unknown>;
  baselineError?: string;
  baseArgs?: Record<string, unknown>;
  baseGlobals?: Record<string, unknown>;
  baseActiveElement?: Element | null;
  baseDocumentFingerprint?: string;
  baseScrollSnapshot?: ScrollSnapshot;
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

function cloneValue(value: unknown, seen = new Map<object, unknown>()): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  if (typeof value === 'function') return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    value.forEach(item => clone.push(cloneValue(item, seen)));
    return clone;
  }
  if (value instanceof Date) {
    const clone = new Date(value.getTime());
    seen.set(value, clone);
    return clone;
  }
  if (value instanceof RegExp) {
    const clone = new RegExp(value.source, value.flags);
    seen.set(value, clone);
    return clone;
  }
  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();
    seen.set(value, clone);
    value.forEach((item, key) => clone.set(cloneValue(key, seen), cloneValue(item, seen)));
    return clone;
  }
  if (value instanceof Set) {
    const clone = new Set<unknown>();
    seen.set(value, clone);
    value.forEach(item => clone.add(cloneValue(item, seen)));
    return clone;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    try {
      const clone = structuredClone(value);
      if (Object.getPrototypeOf(clone) === prototype) {
        seen.set(value, clone);
        return clone;
      }
    } catch {
      // Report unsupported state below without changing strict capture behavior.
    }
    const constructorName =
      typeof prototype.constructor === 'function' && prototype.constructor.name
        ? prototype.constructor.name
        : 'non-plain object';
    throw new Error(`Story session cannot safely clone ${constructorName} state.`);
  }

  const clone = Object.create(prototype) as Record<PropertyKey, unknown>;
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) descriptor.value = cloneValue(descriptor.value, seen);
    Object.defineProperty(clone, key, descriptor);
  }
  return clone;
}

function cloneState(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value ? (cloneValue(value) as Record<string, unknown>) : undefined;
}

function restoreState(target: Record<string, unknown> | undefined, source: Record<string, unknown> | undefined) {
  if (!target || !source) return;
  for (const key of Object.keys(target)) {
    if (!Object.hasOwn(source, key)) delete target[key];
  }
  Object.assign(target, cloneState(source));
}

function canonicalizeForSort(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'bigint') return ['bigint', String(value)];
  if (typeof value === 'function' || typeof value === 'symbol') return ['ignored', typeof value];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN'];
    if (!Number.isFinite(value)) return ['number', String(value)];
    if (Object.is(value, -0)) return ['number', '-0'];
  }
  if (typeof value !== 'object' || value === null) return value;
  if (ancestors.has(value)) return ['cycle'];
  const descendants = new Set(ancestors);
  descendants.add(value);
  if (Array.isArray(value)) return ['array', value.map(child => canonicalizeForSort(child, descendants))];
  if (value instanceof Date) {
    return ['date', Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString()];
  }
  if (value instanceof RegExp) return ['regexp', value.source, value.flags];
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, child]) => [
      canonicalizeForSort(key, descendants),
      canonicalizeForSort(child, descendants),
    ]);
    entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return ['map', entries];
  }
  if (value instanceof Set) {
    const entries = [...value].map(child => canonicalizeForSort(child, descendants));
    entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return ['set', entries];
  }
  const constructorName = Object.getPrototypeOf(value)?.constructor?.name ?? '';
  return [
    'object',
    constructorName,
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => typeof child !== 'function' && typeof child !== 'symbol')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalizeForSort(child, descendants)]),
  ];
}

function canonicalSortKey(value: unknown) {
  return JSON.stringify(canonicalizeForSort(value));
}

function canonicalize(value: unknown, seen = new Map<object, number>()): unknown {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'bigint') return ['bigint', String(value)];
  if (typeof value === 'function' || typeof value === 'symbol') return ['ignored', typeof value];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN'];
    if (!Number.isFinite(value)) return ['number', String(value)];
    if (Object.is(value, -0)) return ['number', '-0'];
  }
  if (typeof value !== 'object' || value === null) return value;
  const existing = seen.get(value);
  if (existing !== undefined) return ['reference', existing];
  const id = seen.size;
  seen.set(value, id);
  if (Array.isArray(value)) return ['array', id, value.map(child => canonicalize(child, seen))];
  if (value instanceof Date) {
    return ['date', id, Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString()];
  }
  if (value instanceof RegExp) return ['regexp', id, value.source, value.flags];
  if (value instanceof Map) {
    const entries = [...value.entries()].sort((left, right) =>
      canonicalSortKey(left).localeCompare(canonicalSortKey(right)),
    );
    return ['map', id, entries.map(([key, child]) => [canonicalize(key, seen), canonicalize(child, seen)])];
  }
  if (value instanceof Set) {
    const entries = [...value].sort((left, right) => canonicalSortKey(left).localeCompare(canonicalSortKey(right)));
    return ['set', id, entries.map(child => canonicalize(child, seen))];
  }
  const constructorName = Object.getPrototypeOf(value)?.constructor?.name ?? '';
  return [
    'object',
    id,
    constructorName,
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => typeof child !== 'function' && typeof child !== 'symbol')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child, seen)]),
  ];
}

function fingerprint(value: unknown): string {
  const source = JSON.stringify(canonicalize(value)) ?? '';
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function serializeDomNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return null;
  const record = node as Record<string, any>;
  const nodeType = Number(record.nodeType);
  if (nodeType === 3) return ['text', String(record.nodeValue ?? '')];
  if (nodeType === 8) return ['comment', String(record.nodeValue ?? '')];

  const children = Array.from((record.childNodes ?? []) as ArrayLike<unknown>).map(serializeDomNode);
  if (nodeType !== 1) return ['node', nodeType, children];
  const attributes = Array.from((record.attributes ?? []) as ArrayLike<{ name: string; value: string }>)
    .map(attribute => [attribute.name, attribute.value])
    .sort(([left], [right]) => left.localeCompare(right));
  const liveState: Record<string, unknown> = {};
  for (const key of ['value', 'checked', 'selectedIndex', 'selected', 'open'] as const) {
    if (key in record && typeof record[key] !== 'function') liveState[key] = record[key];
  }
  return [
    'element',
    String(record.tagName ?? '').toLowerCase(),
    attributes,
    liveState,
    children,
    record.shadowRoot ? serializeDomNode(record.shadowRoot) : null,
  ];
}

function documentFingerprint(): string | undefined {
  const documentElement = document.documentElement as unknown as Record<string, unknown> | undefined;
  if (documentElement && typeof documentElement.nodeType === 'number') {
    return fingerprint(serializeDomNode(documentElement));
  }
  const body = document.body as unknown as { innerHTML?: string } | undefined;
  if (typeof body?.innerHTML === 'string') return fingerprint(body.innerHTML);
  return undefined;
}

function captureScrollSnapshot(): ScrollSnapshot {
  const elements = new Set<Element>();
  if (document.scrollingElement) elements.add(document.scrollingElement);
  for (const element of Array.from(document.querySelectorAll?.('*') ?? [])) {
    if (
      element.scrollLeft !== 0 ||
      element.scrollTop !== 0 ||
      element.scrollWidth > element.clientWidth ||
      element.scrollHeight > element.clientHeight
    ) {
      elements.add(element);
    }
  }
  const view = typeof window === 'undefined' ? undefined : window;
  return {
    elements: [...elements].map(element => ({ element, left: element.scrollLeft, top: element.scrollTop })),
    windowX: view?.scrollX ?? 0,
    windowY: view?.scrollY ?? 0,
  };
}

function restoreScrollSnapshot(snapshot: ScrollSnapshot | undefined) {
  if (!snapshot) return;
  for (const item of snapshot.elements) {
    if (item.element.isConnected === false) continue;
    item.element.scrollLeft = item.left;
    item.element.scrollTop = item.top;
  }
  if (typeof window !== 'undefined') window.scrollTo?.(snapshot.windowX, snapshot.windowY);
}

function scrollSnapshotMatches(snapshot: ScrollSnapshot | undefined) {
  if (!snapshot) return true;
  const view = typeof window === 'undefined' ? undefined : window;
  if ((view?.scrollX ?? 0) !== snapshot.windowX || (view?.scrollY ?? 0) !== snapshot.windowY) return false;
  return snapshot.elements.every(
    item =>
      item.element.isConnected !== false &&
      item.element.scrollLeft === item.left &&
      item.element.scrollTop === item.top,
  );
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

function snapshotBaseline(runtime: RuntimeRegistration) {
  try {
    const baseArgs = cloneState(runtime.args);
    const baseGlobals = cloneState(runtime.globals);
    const baseActiveElement = currentActiveElement();
    const baseDocumentFingerprint = documentFingerprint();
    const baseScrollSnapshot = captureScrollSnapshot();
    runtime.baseArgs = baseArgs;
    runtime.baseGlobals = baseGlobals;
    runtime.baseActiveElement = baseActiveElement;
    runtime.baseDocumentFingerprint = baseDocumentFingerprint;
    runtime.baseScrollSnapshot = baseScrollSnapshot;
    delete runtime.baselineError;
  } catch (error) {
    runtime.baseArgs = undefined;
    runtime.baseGlobals = undefined;
    runtime.baseActiveElement = undefined;
    runtime.baseDocumentFingerprint = undefined;
    runtime.baseScrollSnapshot = undefined;
    const reason = error instanceof Error ? error.message : String(error);
    runtime.baselineError = `Story session baseline is unsafe: ${reason}`;
  }
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
      if (runtime.baselineError) throw new Error(runtime.baselineError);
      if (
        (runtime.args !== undefined && runtime.baseArgs === undefined) ||
        (runtime.globals !== undefined && runtime.baseGlobals === undefined) ||
        runtime.baseActiveElement === undefined ||
        runtime.baseScrollSnapshot === undefined
      ) {
        snapshotBaseline(runtime);
      }
      if (runtime.baselineError) throw new Error(runtime.baselineError);
      if (runtime.baseDocumentFingerprint === undefined) {
        throw new Error('Story session cannot validate the preview document state.');
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
    async resetVariant(variantId): Promise<SessionReady> {
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
      restoreScrollSnapshot(runtime.baseScrollSnapshot);
      session.activeVariantId = undefined;
      return baseReady(session);
    },
    async verifyReset(): Promise<ResetVerification> {
      const session = requireActive();
      if (session.activeVariantId !== undefined) {
        throw new Error(`Story session variant ${session.activeVariantId} has not been reset.`);
      }
      const runtime = target.__STORYFREEZE_STORY_SESSION_RUNTIME__!;
      const restoredActiveElement = currentActiveElement();
      const currentDocumentFingerprint = documentFingerprint();
      return {
        ...baseReady(session),
        activeElement: activeElementIdentity(restoredActiveElement),
        activeElementMatchesBaseline: restoredActiveElement === (runtime.baseActiveElement ?? null),
        baseActiveElement: activeElementIdentity(runtime.baseActiveElement ?? null),
        ...(runtime.args ? { argsHash: fingerprint(runtime.args) } : {}),
        ...(runtime.baseArgs ? { baseArgsHash: fingerprint(runtime.baseArgs) } : {}),
        ...(runtime.globals ? { globalsHash: fingerprint(runtime.globals) } : {}),
        ...(runtime.baseGlobals ? { baseGlobalsHash: fingerprint(runtime.baseGlobals) } : {}),
        ...(runtime.baseDocumentFingerprint ? { baseDocumentFingerprint: runtime.baseDocumentFingerprint } : {}),
        ...(currentDocumentFingerprint ? { documentFingerprint: currentDocumentFingerprint } : {}),
        scrollPositionMatchesBaseline: scrollSnapshotMatches(runtime.baseScrollSnapshot),
      };
    },
    async closeSession() {
      active = undefined;
    },
  };
}
