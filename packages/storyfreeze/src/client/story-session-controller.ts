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
  baseArgsHash?: string;
  baseDocumentFingerprint?: string;
  baseGlobalsHash?: string;
  baseScrollSnapshot?: ScrollSnapshot;
  baselineCaptured?: boolean;
};

type ActiveSession = OpenStorySessionRequest & {
  sessionGeneration: number;
  variantGeneration: number;
  runtime: RuntimeRegistration;
  state: 'ready' | 'applied' | 'poisoned';
  activeVariantId?: string;
};

type StorySessionWindow = typeof window & {
  [STORYFREEZE_STORY_SESSION_GLOBAL]?: StorySessionPreviewProtocol;
  __STORYFREEZE_STORY_SESSION_RUNTIME__?: RuntimeRegistration;
};

const functionIds = new WeakMap<Function, number>();
let nextFunctionId = 1;
const ignoredFunctionStateKeys = new Set(['arguments', 'caller', 'length', 'name', 'prototype']);

function functionIdentity(value: Function) {
  let id = functionIds.get(value);
  if (id === undefined) {
    id = nextFunctionId++;
    functionIds.set(value, id);
  }
  return id;
}

function functionStateKey(key: PropertyKey) {
  if (typeof key === 'string') return `string:${key}`;
  if (typeof key === 'symbol') return `symbol:${Symbol.keyFor(key) ?? key.description ?? ''}`;
  return `number:${key}`;
}

function functionStateEntries(value: Function, canonicalizeChild: (child: unknown) => unknown) {
  const isMockFunction = Object.getOwnPropertyDescriptor(value, '_isMockFunction')?.value === true;
  return Reflect.ownKeys(value)
    .filter(key => typeof key !== 'string' || !ignoredFunctionStateKeys.has(key))
    .map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return undefined;
      if ('value' in descriptor) {
        return [functionStateKey(key), canonicalizeChild(descriptor.value)] as const;
      }
      if (isMockFunction && key === 'mock' && descriptor.get) {
        try {
          return [functionStateKey(key), canonicalizeChild(descriptor.get.call(value))] as const;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Story session cannot inspect mock function state: ${reason}`);
        }
      }
      throw new Error(`Story session cannot safely fingerprint function accessor state at ${String(key)}.`);
    })
    .filter((entry): entry is readonly [string, unknown] => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
}

function cloneValue(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (typeof value === 'symbol') throw new Error('Story session cannot safely clone symbol state.');
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
    clone.lastIndex = value.lastIndex;
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
    const constructorName =
      typeof prototype.constructor === 'function' && prototype.constructor.name
        ? prototype.constructor.name
        : 'non-plain object';
    throw new Error(`Story session cannot safely clone ${constructorName} state.`);
  }

  const clone = Object.create(prototype) as Record<PropertyKey, unknown>;
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new Error('Story session cannot safely clone symbol-keyed state.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!('value' in descriptor)) throw new Error(`Story session cannot safely clone accessor state at ${key}.`);
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
  if (typeof value === 'symbol') return ['symbol', String(value.description ?? '')];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN'];
    if (!Number.isFinite(value)) return ['number', String(value)];
    if (Object.is(value, -0)) return ['number', '-0'];
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  if (ancestors.has(value)) return ['cycle'];
  const descendants = new Set(ancestors);
  descendants.add(value);
  if (typeof value === 'function') {
    return [
      'function',
      functionIdentity(value),
      functionStateEntries(value, child => canonicalizeForSort(child, descendants)),
    ];
  }
  if (Array.isArray(value)) return ['array', value.map(child => canonicalizeForSort(child, descendants))];
  if (value instanceof Date) {
    return ['date', Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString()];
  }
  if (value instanceof RegExp) return ['regexp', value.source, value.flags, value.lastIndex];
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
      .filter(([, child]) => typeof child !== 'symbol')
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
  if (typeof value === 'symbol') return ['symbol', String(value.description ?? '')];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN'];
    if (!Number.isFinite(value)) return ['number', String(value)];
    if (Object.is(value, -0)) return ['number', '-0'];
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  const existing = seen.get(value);
  if (existing !== undefined) return ['reference', existing];
  const id = seen.size;
  seen.set(value, id);
  if (typeof value === 'function') {
    return ['function', id, functionIdentity(value), functionStateEntries(value, child => canonicalize(child, seen))];
  }
  if (Array.isArray(value)) return ['array', id, value.map(child => canonicalize(child, seen))];
  if (value instanceof Date) {
    return ['date', id, Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString()];
  }
  if (value instanceof RegExp) return ['regexp', id, value.source, value.flags, value.lastIndex];
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
      .filter(([, child]) => typeof child !== 'symbol')
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
    runtime.baseArgsHash = fingerprint(baseArgs);
    runtime.baseGlobalsHash = fingerprint(baseGlobals);
    runtime.baseActiveElement = baseActiveElement;
    runtime.baseDocumentFingerprint = baseDocumentFingerprint;
    runtime.baseScrollSnapshot = baseScrollSnapshot;
    runtime.baselineCaptured = true;
    delete runtime.baselineError;
  } catch (error) {
    runtime.baseArgs = undefined;
    runtime.baseGlobals = undefined;
    runtime.baseArgsHash = undefined;
    runtime.baseGlobalsHash = undefined;
    runtime.baseActiveElement = undefined;
    runtime.baseDocumentFingerprint = undefined;
    runtime.baseScrollSnapshot = undefined;
    runtime.baselineCaptured = false;
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
      };
    },
    async closeSession() {
      active = undefined;
    },
  };
}
