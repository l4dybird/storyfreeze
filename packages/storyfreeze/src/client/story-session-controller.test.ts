import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { STORYFREEZE_STORY_SESSION_GLOBAL } from '../shared/preview-protocol.js';
import {
  initializeStorySessionController,
  registerStorySessionRuntime,
  snapshotStorySessionRuntime,
} from './story-session-controller.js';

describe(initializeStorySessionController, () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });

  it('tracks generations and restores args, globals, and the post-play focus baseline', async () => {
    const body = {};
    const baseline = { id: 'field', tagName: 'INPUT', blur: vi.fn(), focus: vi.fn() };
    const variantFocus = { id: 'other', tagName: 'BUTTON', blur: vi.fn() };
    const documentLike = {
      activeElement: baseline,
      body,
      documentElement: {},
      getElementById: vi.fn(() => ({ innerHTML: '<button>Ready</button>' })),
    };
    baseline.blur.mockImplementation(() => (documentLike.activeElement = body as never));
    baseline.focus.mockImplementation(() => (documentLike.activeElement = baseline));
    variantFocus.blur.mockImplementation(() => (documentLike.activeElement = body as never));
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentLike });

    const target = {} as any;
    const args = { count: 1 };
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
    args.count = 2;
    globals.theme = 'dark';
    const verification = await protocol.resetVariant('hovered');
    expect(reset).toHaveBeenCalledWith({ storyId: 'button--primary', variantId: 'hovered' });
    expect(args).toEqual({ count: 1 });
    expect(globals).toEqual({ theme: 'light' });
    expect(variantFocus.blur).toHaveBeenCalledTimes(1);
    expect(baseline.blur).not.toHaveBeenCalled();
    expect(baseline.focus).toHaveBeenCalledTimes(1);
    expect(verification).toMatchObject({
      activeElement: '#field',
      activeElementMatchesBaseline: true,
      baseActiveElement: '#field',
      pendingRequestCount: 0,
      argsHash: verification.baseArgsHash,
      globalsHash: verification.baseGlobalsHash,
      rootFingerprint: verification.baseRootFingerprint,
    });

    await protocol.closeSession();
    await expect(protocol.applyVariant('focused')).rejects.toThrow('No StoryFreeze story session is open');
  });
});
