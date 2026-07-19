import { describe, expect, it, vi } from 'vite-plus/test';
import {
  STORYFREEZE_ADDON_VERSION,
  STORYFREEZE_PREVIEW_PROTOCOL_VERSION,
  type StoryFreezePreviewStateV1,
} from '../shared/preview-protocol.js';
import { detectPreviewMode, createStoryPreviewUrl, StoryNavigator } from './story-navigator.js';

function state(
  status: StoryFreezePreviewStateV1['status'],
  storyId = 'button--primary',
  requestId = '7-1',
): StoryFreezePreviewStateV1 {
  const base = {
    protocolVersion: STORYFREEZE_PREVIEW_PROTOCOL_VERSION,
    addonVersion: STORYFREEZE_ADDON_VERSION,
    storyId,
    requestId,
  };
  if (status === 'ready') return { ...base, status, options: { fullPage: true } };
  if (status === 'error') return { ...base, status, error: { name: 'RenderError', message: 'render failed' } };
  return { ...base, status };
}

function pageWithState(getState: () => unknown) {
  let currentUrl = 'about:blank';
  return {
    goto: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    evaluate: vi.fn(async () => getState()),
    currentUrl: vi.fn(() => currentUrl),
  };
}

function workerSessionPage() {
  let currentUrl = 'about:blank';
  let previewState: unknown = state('ready');
  const protocol = {
    protocolVersion: 1,
    selectStory: vi.fn(async ({ requestId, storyId }: { requestId: string; storyId: string }) => {
      previewState = state('ready', storyId, requestId);
      return { requestId, storyId, generation: 1 };
    }),
    completeCapture: vi.fn(),
  };
  const page = {
    goto: vi.fn(async (url: string) => {
      currentUrl = url;
      const parsed = new URL(url);
      previewState = state('ready', parsed.searchParams.get('id')!, parsed.searchParams.get('storyfreezeRequestId')!);
    }),
    evaluate: vi.fn(async (fn: (argument: any) => unknown, argument?: any) => {
      if (argument?.globalName === '__STORYFREEZE_WORKER_SESSION__') {
        return fn(argument);
      }
      return previewState;
    }),
    currentUrl: vi.fn(() => currentUrl),
  };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __STORYFREEZE_WORKER_SESSION__: protocol },
  });
  return {
    page,
    protocol,
    restore() {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}

describe(createStoryPreviewUrl, () => {
  it('preserves a base path and encodes the public Storybook iframe query', () => {
    const url = createStoryPreviewUrl(new URL('https://example.test/storybook?old=1'), 'button/primary value', '0-1');

    expect(url.pathname).toBe('/storybook/iframe.html');
    expect(url.searchParams.get('id')).toBe('button/primary value');
    expect(url.searchParams.get('viewMode')).toBe('story');
    expect(url.searchParams.get('storyfreezeRequestId')).toBe('0-1');
    expect(url.searchParams.has('storyfreezeRetryCount')).toBe(false);
    expect(url.searchParams.has('old')).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('omits an invalid retry count: %s', retryCount => {
    const url = createStoryPreviewUrl(new URL('https://example.test/storybook'), 'button--primary', '0-1', retryCount);

    expect(url.searchParams.has('storyfreezeRetryCount')).toBe(false);
  });
});

describe(detectPreviewMode, () => {
  it('detects the owned preview marker on the story iframe', async () => {
    const page = pageWithState(() => state('booting', 'button--primary', 'mode-detection'));

    await expect(
      detectPreviewMode(page, new URL('https://example.test/storybook'), 'button--primary', 100),
    ).resolves.toEqual({ mode: 'managed', reason: 'the StoryFreeze preview marker was detected' });
  });

  it('uses simple mode when the owned marker is absent', async () => {
    const page = pageWithState(() => undefined);

    await expect(detectPreviewMode(page, new URL('https://example.test'), 'button--primary', 0)).resolves.toEqual({
      mode: 'simple',
      reason: 'the StoryFreeze preview marker was not detected',
    });
  });

  it('bounds mode detection when preview evaluation never settles', async () => {
    const page = pageWithState(() => new Promise<never>(() => {}));

    await expect(detectPreviewMode(page, new URL('https://example.test'), 'button--primary', 10)).resolves.toEqual({
      mode: 'simple',
      reason: 'the StoryFreeze preview marker was not detected',
    });
  });

  it('uses an explicitly requested simple mode without waiting for a marker', async () => {
    const page = pageWithState(() => state('booting', 'button--primary', 'mode-detection'));

    await expect(
      detectPreviewMode(page, new URL('https://example.test'), 'button--primary', 100, 'simple'),
    ).resolves.toEqual({ mode: 'simple', reason: 'forced by --mode simple' });
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('rejects a missing marker when managed mode is required', async () => {
    const page = pageWithState(() => undefined);

    await expect(
      detectPreviewMode(page, new URL('https://example.test'), 'button--primary', 0, 'managed'),
    ).rejects.toThrow(/required by --mode managed.*preview marker was not found/);
  });

  it('stops mode detection when aborted', async () => {
    const page = pageWithState(() => undefined);
    const controller = new AbortController();
    controller.abort(new Error('interrupted by test'));

    await expect(
      detectPreviewMode(page, new URL('https://example.test'), 'button--primary', 100, 'auto', controller.signal),
    ).rejects.toThrow('interrupted by test');
  });

  it('rejects a redirect that discards the preview query before falling back to simple mode', async () => {
    const page = pageWithState(() => undefined);
    page.currentUrl.mockReturnValue('https://example.test/iframe');

    await expect(detectPreviewMode(page, new URL('https://example.test'), 'button--primary', 0)).rejects.toThrow(
      /lost its required query parameters after a redirect.*cleanUrls.*false/,
    );
  });
});

describe(StoryNavigator, () => {
  it('uses a new request ID for every direct navigation and returns ready options', async () => {
    let current: unknown = state('ready');
    const page = pageWithState(() => current);
    const navigator = new StoryNavigator(page, new URL('https://example.test/storybook'), 7);

    await navigator.navigate('button--primary');
    await expect(navigator.waitForReady(100)).resolves.toEqual({ fullPage: true });
    current = state('ready', 'button--primary', '7-2');
    await navigator.navigate('button--primary', 1234, 2);
    await expect(navigator.waitForReady(100)).resolves.toEqual({ fullPage: true });

    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(vi.mocked(page.goto).mock.calls[0][0]).toContain('storyfreezeRequestId=7-1');
    expect(vi.mocked(page.goto).mock.calls[1][0]).toContain('storyfreezeRequestId=7-2');
    expect(vi.mocked(page.goto).mock.calls[0][0]).not.toContain('storyfreezeRetryCount');
    expect(vi.mocked(page.goto).mock.calls[1][0]).toContain('storyfreezeRetryCount=2');
    expect(vi.mocked(page.goto).mock.calls.map(([, options]) => options?.timeout)).toEqual([60_000, 1234]);
  });

  it('switches stories in one preview document after the initial navigation', async () => {
    const fixture = workerSessionPage();
    try {
      const navigator = new StoryNavigator(fixture.page, new URL('https://example.test/storybook'), 7);
      await navigator.navigate('button--primary');
      await navigator.waitForReady(100);
      await navigator.selectStory('button--secondary');
      await expect(navigator.waitForReady(100)).resolves.toEqual({ fullPage: true });
      await navigator.completeCapture();

      expect(fixture.page.goto).toHaveBeenCalledOnce();
      expect(fixture.protocol.selectStory).toHaveBeenCalledWith({
        requestId: '7-2',
        storyId: 'button--secondary',
      });
      expect(fixture.protocol.completeCapture).toHaveBeenCalledWith('7-2');
    } finally {
      fixture.restore();
    }
  });

  it('keeps a protocol-unavailable document on the fresh-navigation path', async () => {
    const page = pageWithState(() => state('ready'));
    const navigator = new StoryNavigator(page, new URL('https://example.test/storybook'), 7);

    await navigator.navigate('button--primary');
    expect(navigator.canSelectStory).toBe(true);
    navigator.markWorkerSessionUnavailable();
    expect(navigator.canSelectStory).toBe(false);
    await navigator.navigate('button--secondary');
    expect(navigator.canSelectStory).toBe(false);
  });

  it.each([
    ['protocol version', { ...state('booting'), protocolVersion: 2 }, 'protocol mismatch'],
    ['addon version', { ...state('booting'), addonVersion: 'old' }, 'addon version mismatch'],
    ['story ID', state('booting', 'old-story'), 'state is stale'],
    ['request ID', state('booting', 'button--primary', '7-0'), 'state is stale'],
    ['ready options schema', { ...state('ready'), options: null }, 'ready.options must be an object'],
  ])('rejects a mismatched %s', async (_label, previewState, message) => {
    const page = pageWithState(() => previewState);
    const navigator = new StoryNavigator(page, new URL('https://example.test'), 7);
    await navigator.navigate('button--primary');

    await expect(navigator.waitForReady(100)).rejects.toThrow(message);
  });

  it('surfaces preview errors immediately', async () => {
    const page = pageWithState(() => state('error'));
    const navigator = new StoryNavigator(page, new URL('https://example.test'), 7);
    await navigator.navigate('button--primary');

    await expect(navigator.waitForReady(100)).rejects.toThrow('RenderError: render failed');
  });

  it('includes the URL, story, request, and last state in timeout diagnostics', async () => {
    const page = pageWithState(() => state('booting'));
    const navigator = new StoryNavigator(page, new URL('https://example.test'), 7);
    await navigator.navigate('button--primary');

    await expect(navigator.waitForReady(0)).rejects.toThrow(
      /URL: .*iframe\.html\?.*; storyId: button--primary; requestId: 7-1; lastState:/,
    );
  });

  it('bounds managed readiness when preview evaluation never settles', async () => {
    const page = pageWithState(() => new Promise<never>(() => {}));
    const navigator = new StoryNavigator(page, new URL('https://example.test'), 7);
    await navigator.navigate('button--primary');

    await expect(navigator.waitForReady(10)).rejects.toThrow(/did not become ready/);
  });

  it('rejects a redirect that changes the story or request query', async () => {
    const page = pageWithState(() => undefined);
    page.currentUrl.mockReturnValue('https://example.test/iframe.html?id=button--other&storyfreezeRequestId=7-1');
    const navigator = new StoryNavigator(page, new URL('https://example.test'), 7);

    await expect(navigator.navigate('button--primary')).rejects.toThrow(
      /Expected id="button--primary" and storyfreezeRequestId="7-1"/,
    );
  });

  it('accepts a rendered Storybook preview in simple mode', async () => {
    const page = pageWithState(() => ({ status: 'ready', bodyClassName: 'sb-show-main sb-main-padded' }));
    const navigator = new StoryNavigator(page, new URL('https://example.test'), 7);
    await navigator.navigate('button--primary');

    await expect(navigator.waitForSimpleReady(100)).resolves.toBeUndefined();
  });

  it.each([
    ['No Preview', { status: 'no-preview', bodyClassName: 'sb-show-nopreview' }, 'No Preview is visible'],
    [
      'error display',
      {
        status: 'error',
        bodyClassName: 'sb-show-errordisplay',
        message: 'Failed to render',
        stack: 'RenderError: fixture failed',
      },
      'Failed to render',
    ],
  ])('rejects the Storybook %s page in simple mode', async (_label, previewState, message) => {
    const page = pageWithState(() => previewState);
    const navigator = new StoryNavigator(page, new URL('https://example.test'), 7);
    await navigator.navigate('button--primary');

    await expect(navigator.waitForSimpleReady(100)).rejects.toThrow(message);
  });

  it('times out while Storybook is still preparing a simple preview', async () => {
    const page = pageWithState(() => ({ status: 'pending', bodyClassName: 'sb-show-preparing-story' }));
    const navigator = new StoryNavigator(page, new URL('https://example.test'), 7);
    await navigator.navigate('button--primary');

    await expect(navigator.waitForSimpleReady(0)).rejects.toThrow(
      /did not show a rendered preview.*body classes: "sb-show-preparing-story"/,
    );
  });

  it('bounds simple readiness when preview evaluation never settles', async () => {
    const page = pageWithState(() => new Promise<never>(() => {}));
    const navigator = new StoryNavigator(page, new URL('https://example.test'), 7);
    await navigator.navigate('button--primary');

    await expect(navigator.waitForSimpleReady(10)).rejects.toThrow(/did not show a rendered preview/);
  });
});
