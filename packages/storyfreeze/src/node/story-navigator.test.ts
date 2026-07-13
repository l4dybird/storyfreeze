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
  return {
    goto: vi.fn(async () => null),
    evaluate: vi.fn(async () => getState()),
    currentUrl: vi.fn(() => 'https://example.test/storybook/iframe.html'),
  };
}

describe(createStoryPreviewUrl, () => {
  it('preserves a base path and encodes the public Storybook iframe query', () => {
    const url = createStoryPreviewUrl(new URL('https://example.test/storybook?old=1'), 'button/primary value', '0-1');

    expect(url.pathname).toBe('/storybook/iframe.html');
    expect(url.searchParams.get('id')).toBe('button/primary value');
    expect(url.searchParams.get('viewMode')).toBe('story');
    expect(url.searchParams.get('storyfreezeRequestId')).toBe('0-1');
    expect(url.searchParams.has('old')).toBe(false);
  });
});

describe(detectPreviewMode, () => {
  it('detects the owned preview marker on the story iframe', async () => {
    const page = pageWithState(() => state('booting', 'button--primary', 'mode-detection'));

    await expect(
      detectPreviewMode(page, new URL('https://example.test/storybook'), 'button--primary', 100),
    ).resolves.toBe('managed');
  });

  it('uses simple mode when the owned marker is absent', async () => {
    const page = pageWithState(() => undefined);

    await expect(detectPreviewMode(page, new URL('https://example.test'), 'button--primary', 0)).resolves.toBe(
      'simple',
    );
  });

  it('stops mode detection when aborted', async () => {
    const page = pageWithState(() => undefined);
    const controller = new AbortController();
    controller.abort(new Error('interrupted by test'));

    await expect(
      detectPreviewMode(page, new URL('https://example.test'), 'button--primary', 100, controller.signal),
    ).rejects.toThrow('interrupted by test');
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
    expect(vi.mocked(page.goto).mock.calls[0][0]).toContain('storyfreezeRetryCount=0');
    expect(vi.mocked(page.goto).mock.calls[1][0]).toContain('storyfreezeRetryCount=2');
    expect(vi.mocked(page.goto).mock.calls.map(([, options]) => options?.timeout)).toEqual([60_000, 1234]);
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
      /URL: .*iframe\.html; storyId: button--primary; requestId: 7-1; lastState:/,
    );
  });
});
