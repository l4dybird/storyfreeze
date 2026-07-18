import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { STORYFREEZE_STORY_SESSION_GLOBAL } from '../shared/preview-protocol.js';
import {
  initializeStorySessionController,
  registerStorySessionRuntime,
  snapshotStorySessionRuntime,
} from './story-session-controller.js';

describe(initializeStorySessionController, () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('tracks generations and restores args, globals, and the post-play focus baseline', async () => {
    const body = { innerHTML: '<button>Ready</button>' };
    const baseline = { id: 'field', tagName: 'INPUT', blur: vi.fn(), focus: vi.fn() };
    const variantFocus = { id: 'other', tagName: 'BUTTON', blur: vi.fn() };
    const documentLike = {
      activeElement: baseline,
      body,
      documentElement: {},
    };
    baseline.blur.mockImplementation(() => (documentLike.activeElement = body as never));
    baseline.focus.mockImplementation(() => (documentLike.activeElement = baseline));
    variantFocus.blur.mockImplementation(() => (documentLike.activeElement = body as never));
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentLike });

    const target = {} as any;
    const onClick = () => {};
    const args = { count: 1, form: { value: 'before' }, onClick };
    const globals = { theme: 'light' };
    const reset = vi.fn(async () => {});
    initializeStorySessionController(target);
    registerStorySessionRuntime({ reset }, { id: 'button--primary', args, globals }, target);
    snapshotStorySessionRuntime('button--primary', target);
    const protocol = target[STORYFREEZE_STORY_SESSION_GLOBAL]!;

    const opened = await protocol.openSession({
      sessionId: 'button-desktop',
      storyId: 'button--primary',
      profileHash: 'desktop',
    });
    expect(opened).toEqual({ storyId: 'button--primary', sessionGeneration: 1, profileHash: 'desktop' });
    await expect(protocol.applyVariant('hovered')).resolves.toMatchObject({
      sessionGeneration: 1,
      variantGeneration: 1,
      variantId: 'hovered',
    });

    documentLike.activeElement = variantFocus;
    const rerenderedArgs = { count: 2, form: { value: 'after' }, onClick };
    const rerenderedGlobals = { theme: 'dark' };
    registerStorySessionRuntime(
      { reset },
      { id: 'button--primary', args: rerenderedArgs, globals: rerenderedGlobals },
      target,
    );
    await expect(protocol.resetVariant('hovered')).resolves.toEqual({
      storyId: 'button--primary',
      sessionGeneration: 1,
      profileHash: 'desktop',
    });
    expect(reset).toHaveBeenCalledWith({ storyId: 'button--primary', variantId: 'hovered' });
    expect(rerenderedArgs).toEqual({ count: 1, form: { value: 'before' }, onClick });
    expect(rerenderedGlobals).toEqual({ theme: 'light' });
    expect(variantFocus.blur).toHaveBeenCalledTimes(1);
    expect(baseline.blur).not.toHaveBeenCalled();
    expect(baseline.focus).toHaveBeenCalledTimes(1);
    const verification = await protocol.verifyReset();
    expect(verification).toMatchObject({
      activeElement: '#field',
      activeElementMatchesBaseline: true,
      baseActiveElement: '#field',
      argsHash: verification.baseArgsHash,
      globalsHash: verification.baseGlobalsHash,
      documentFingerprint: verification.baseDocumentFingerprint,
      scrollPositionMatchesBaseline: true,
    });

    await protocol.closeSession();
    await expect(protocol.applyVariant('focused')).rejects.toThrow('No StoryFreeze story session is open');
  });

  it('restores scroll and fingerprints portals, live form state, and open shadow DOM after settling', async () => {
    const shadowText = { nodeType: 3, nodeValue: 'ready' };
    const shadowRoot = { nodeType: 11, childNodes: [shadowText] };
    const input = {
      nodeType: 1,
      tagName: 'INPUT',
      attributes: [{ name: 'type', value: 'text' }],
      childNodes: [],
      value: 'before',
    };
    const portalClass = { name: 'class', value: 'light' };
    const portal = {
      nodeType: 1,
      tagName: 'DIV',
      attributes: [portalClass],
      childNodes: [input],
      shadowRoot,
    };
    const scroller = {
      nodeType: 1,
      tagName: 'DIV',
      attributes: [],
      childNodes: [],
      clientHeight: 100,
      clientWidth: 100,
      isConnected: true,
      scrollHeight: 500,
      scrollLeft: 3,
      scrollTop: 7,
      scrollWidth: 500,
    };
    const body = { nodeType: 1, tagName: 'BODY', attributes: [], childNodes: [portal, scroller] };
    const documentElement = { nodeType: 1, tagName: 'HTML', attributes: [], childNodes: [body] };
    const documentLike = {
      activeElement: body,
      body,
      documentElement,
      querySelectorAll: vi.fn(() => [portal, input, scroller]),
      scrollingElement: scroller,
    };
    const windowLike = {
      scrollX: 10,
      scrollY: 20,
      scrollTo: vi.fn((x: number, y: number) => {
        windowLike.scrollX = x;
        windowLike.scrollY = y;
      }),
    };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentLike });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: windowLike });

    const reset = vi.fn(async () => {
      input.value = 'before';
      portalClass.value = 'light';
      shadowText.nodeValue = 'ready';
    });
    const target = {} as any;
    initializeStorySessionController(target);
    registerStorySessionRuntime({ reset }, { id: 'portal--story' }, target);
    snapshotStorySessionRuntime('portal--story', target);
    const protocol = target[STORYFREEZE_STORY_SESSION_GLOBAL]!;
    await protocol.openSession({ sessionId: 'portal', storyId: 'portal--story', profileHash: 'desktop' });
    await protocol.applyVariant('changed');

    input.value = 'after';
    portalClass.value = 'dark';
    shadowText.nodeValue = 'changed';
    scroller.scrollLeft = 30;
    scroller.scrollTop = 70;
    windowLike.scrollX = 100;
    windowLike.scrollY = 200;

    await expect(protocol.resetVariant('changed')).resolves.toMatchObject({ storyId: 'portal--story' });
    await expect(protocol.verifyReset()).resolves.toMatchObject({
      activeElementMatchesBaseline: true,
      documentFingerprint: expect.any(String),
      scrollPositionMatchesBaseline: true,
    });
    expect(scroller).toMatchObject({ scrollLeft: 3, scrollTop: 7 });
    expect(windowLike).toMatchObject({ scrollX: 10, scrollY: 20 });

    input.value = 'late mutation';
    const lateVerification = await protocol.verifyReset();
    expect(lateVerification.documentFingerprint).not.toBe(lateVerification.baseDocumentFingerprint);
  });

  it('canonicalizes equivalent Map and Set args independently of insertion order', async () => {
    const body = { innerHTML: '<button>Ready</button>' };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: body, body, documentElement: {} },
    });
    const target = {} as any;
    const onClick = () => {};
    const baselineArgs = {
      map: new Map<unknown, unknown>([
        ['second', new Set([undefined, onClick])],
        ['first', 1],
      ]),
      set: new Set<unknown>([onClick, undefined, 'value']),
    };
    initializeStorySessionController(target);
    registerStorySessionRuntime({}, { id: 'collections--story', args: baselineArgs }, target);
    snapshotStorySessionRuntime('collections--story', target);
    const protocol = target[STORYFREEZE_STORY_SESSION_GLOBAL]!;
    await protocol.openSession({ sessionId: 'collections', storyId: 'collections--story', profileHash: 'desktop' });

    const rerenderedArgs = {
      map: new Map<unknown, unknown>([
        ['first', 1],
        ['second', new Set([onClick, undefined])],
      ]),
      set: new Set<unknown>(['value', undefined, onClick]),
    };
    registerStorySessionRuntime({}, { id: 'collections--story', args: rerenderedArgs }, target);

    const verification = await protocol.verifyReset();
    expect(verification.argsHash).toBe(verification.baseArgsHash);
  });

  it('detects mutable state retained by function-valued args after reset', async () => {
    const body = { innerHTML: '<button>Ready</button>' };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: body, body, documentElement: {} },
    });
    const target = {} as any;
    const handler = Object.assign(() => {}, { calls: [] as string[] });
    const args = { handler };
    initializeStorySessionController(target);
    registerStorySessionRuntime({}, { id: 'functions--story', args }, target);
    snapshotStorySessionRuntime('functions--story', target);
    const protocol = target[STORYFREEZE_STORY_SESSION_GLOBAL]!;
    await protocol.openSession({ sessionId: 'functions', storyId: 'functions--story', profileHash: 'desktop' });
    await protocol.applyVariant('clicked');

    handler.calls.push('clicked');
    await protocol.resetVariant('clicked');

    const verification = await protocol.verifyReset();
    expect(verification.argsHash).not.toBe(verification.baseArgsHash);
    expect(handler.calls).toEqual(['clicked']);
  });

  it('detects mutable prototype state retained by function-valued args after reset', async () => {
    const body = { innerHTML: '<button>Ready</button>' };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: body, body, documentElement: {} },
    });
    const target = {} as any;
    function handler() {}
    const args = { handler };
    initializeStorySessionController(target);
    registerStorySessionRuntime({}, { id: 'function-prototype--story', args }, target);
    snapshotStorySessionRuntime('function-prototype--story', target);
    const protocol = target[STORYFREEZE_STORY_SESSION_GLOBAL]!;
    await protocol.openSession({
      sessionId: 'function-prototype',
      storyId: 'function-prototype--story',
      profileHash: 'desktop',
    });
    await protocol.applyVariant('clicked');

    handler.prototype.retained = 'clicked';
    await protocol.resetVariant('clicked');

    const verification = await protocol.verifyReset();
    expect(verification.argsHash).not.toBe(verification.baseArgsHash);
    expect(handler.prototype.retained).toBe('clicked');
  });

  it('detects call history retained by Storybook-style mock args', async () => {
    const body = { innerHTML: '<button>Ready</button>' };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: body, body, documentElement: {} },
    });
    const target = {} as any;
    const onClick = vi.fn();
    initializeStorySessionController(target);
    registerStorySessionRuntime({}, { id: 'mock--story', args: { onClick } }, target);
    snapshotStorySessionRuntime('mock--story', target);
    const protocol = target[STORYFREEZE_STORY_SESSION_GLOBAL]!;
    await protocol.openSession({ sessionId: 'mock', storyId: 'mock--story', profileHash: 'desktop' });
    await protocol.applyVariant('clicked');

    onClick('clicked');
    await protocol.resetVariant('clicked');

    const verification = await protocol.verifyReset();
    expect(verification.argsHash).not.toBe(verification.baseArgsHash);
  });

  it('fails closed for class instances with private state without corrupting strict capture args', async () => {
    class Model {
      #value: string;

      constructor(value: string) {
        this.#value = value;
      }

      label() {
        return `model:${this.#value}`;
      }
    }

    const body = { innerHTML: '<button>Ready</button>' };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: body, body, documentElement: {} },
    });
    const target = {} as any;
    const model = new Model('before');
    initializeStorySessionController(target);
    expect(() => registerStorySessionRuntime({}, { id: 'model--story', args: { model } }, target)).not.toThrow();
    expect(() => snapshotStorySessionRuntime('model--story', target)).not.toThrow();
    const protocol = target[STORYFREEZE_STORY_SESSION_GLOBAL]!;
    await expect(
      protocol.openSession({ sessionId: 'model', storyId: 'model--story', profileHash: 'desktop' }),
    ).rejects.toThrow('Story session baseline is unsafe: Story session cannot safely clone Model state.');
    expect(model.label()).toBe('model:before');
  });

  it('fails closed for native objects whose hidden state cannot be fingerprinted', async () => {
    const body = { innerHTML: '<button>Ready</button>' };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: body, body, documentElement: {} },
    });
    const target = {} as any;
    initializeStorySessionController(target);
    registerStorySessionRuntime({}, { id: 'error--story', args: { error: new Error('before') } }, target);
    snapshotStorySessionRuntime('error--story', target);
    const protocol = target[STORYFREEZE_STORY_SESSION_GLOBAL]!;

    await expect(
      protocol.openSession({ sessionId: 'error', storyId: 'error--story', profileHash: 'desktop' }),
    ).rejects.toThrow('Story session cannot safely clone Error state');
  });

  it('fails closed for accessor state instead of sharing its closure with the baseline', async () => {
    const body = { innerHTML: '<button>Ready</button>' };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: body, body, documentElement: {} },
    });
    let shared = 'before';
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => shared });
    const target = {} as any;
    initializeStorySessionController(target);
    registerStorySessionRuntime({}, { id: 'accessor--story', args: { accessor } }, target);
    snapshotStorySessionRuntime('accessor--story', target);
    shared = 'after';
    const protocol = target[STORYFREEZE_STORY_SESSION_GLOBAL]!;

    await expect(
      protocol.openSession({ sessionId: 'accessor', storyId: 'accessor--story', profileHash: 'desktop' }),
    ).rejects.toThrow('Story session cannot safely clone accessor state');
  });
});
