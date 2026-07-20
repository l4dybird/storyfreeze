import { describe, expect, it, vi } from 'vite-plus/test';
import {
  STORYFREEZE_ADDON_VERSION,
  STORYFREEZE_PREVIEW_PROTOCOL_VERSION,
  type StoryFreezePreviewStateV1,
} from '../shared/preview-protocol.js';
import { createStoryPreviewUrl, StoryNavigator } from './story-navigator.js';

function ready(storyId: string, requestId: string): StoryFreezePreviewStateV1 {
  return {
    protocolVersion: STORYFREEZE_PREVIEW_PROTOCOL_VERSION,
    addonVersion: STORYFREEZE_ADDON_VERSION,
    requestId,
    storyId,
    status: 'ready',
    options: { viewport: { width: 800, height: 600 } },
  };
}

describe(StoryNavigator, () => {
  it('creates an owned iframe URL and fails fast when a redirect drops its query', async () => {
    const url = createStoryPreviewUrl(new URL('https://example.test/storybook'), 'button--primary', '0-1');
    expect(url.href).toContain('/storybook/iframe.html?');
    expect(url.searchParams.get('id')).toBe('button--primary');
    expect(url.searchParams.get('storyfreezeRequestId')).toBe('0-1');

    const page = {
      goto: vi.fn(async () => {}),
      currentUrl: vi.fn(() => 'https://example.test/storybook/iframe'),
      evaluate: vi.fn(),
    };
    const navigator = new StoryNavigator(page as never, new URL('https://example.test/storybook'), 0);
    await expect(navigator.navigate('button--primary')).rejects.toThrow('query');
  });

  it('uses one initial navigation and then correlated Storybook story selection', async () => {
    let currentUrl = '';
    let state: StoryFreezePreviewStateV1 | undefined;
    const completeArguments: unknown[] = [];
    const page = {
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
        const parsed = new URL(url);
        state = ready(parsed.searchParams.get('id')!, parsed.searchParams.get('storyfreezeRequestId')!);
      }),
      currentUrl: () => currentUrl,
      evaluate: vi.fn(async (_fn: unknown, argument: any) => {
        if (typeof argument === 'string') return state;
        if (argument.method === 'selectStory') {
          state = ready(argument.argument.storyId, argument.argument.requestId);
          return { ...argument.argument, generation: 2 };
        }
        if (argument.method === 'completeCapture') {
          completeArguments.push(argument.argument);
          return undefined;
        }
        return true;
      }),
    };
    const navigator = new StoryNavigator(page as never, new URL('https://example.test'), 0);
    await navigator.navigate('button--primary');
    await expect(navigator.waitForReady(100)).resolves.toMatchObject({ viewport: { width: 800 } });
    await expect(navigator.detectWorkerSessionSupport()).resolves.toBe(true);
    await navigator.selectStory('button--secondary');
    await expect(navigator.waitForReady(100)).resolves.toMatchObject({ viewport: { width: 800 } });
    await navigator.completeCapture('focused');
    expect(page.goto).toHaveBeenCalledOnce();
    expect(completeArguments).toEqual([['0-2', 'focused']]);
  });

  it('rejects stale state, render errors, and missing managed addon state', async () => {
    let state: unknown = ready('wrong--story', '0-1');
    const page = {
      goto: vi.fn(async (url: string) => {
        page.currentUrl.mockReturnValue(url);
      }),
      currentUrl: vi.fn(() => ''),
      evaluate: vi.fn(async () => state),
    };
    const navigator = new StoryNavigator(page as never, new URL('https://example.test'), 0);
    await navigator.navigate('button--primary');
    await expect(navigator.waitForReady(100)).rejects.toThrow('Expected');

    state = {
      ...ready('button--secondary', '0-2'),
      status: 'error',
      error: { name: 'StoryRenderError', message: 'render failed' },
    };
    navigator.invalidateDocument();
    await navigator.navigate('button--secondary');
    await expect(navigator.waitForReady(100)).rejects.toThrow('render failed');

    state = undefined;
    navigator.invalidateDocument();
    await navigator.navigate('button--missing-addon');
    await expect(navigator.waitForReady(1)).rejects.toThrow('did not become ready');
  });

  it('aborts a pending managed readiness check', async () => {
    let currentUrl = '';
    const page = {
      goto: vi.fn(async (url: string) => (currentUrl = url)),
      currentUrl: () => currentUrl,
      evaluate: vi.fn(async () => undefined),
    };
    const navigator = new StoryNavigator(page as never, new URL('https://example.test'), 0);
    await navigator.navigate('button--primary');
    const controller = new AbortController();
    const waiting = navigator.waitForReady(10_000, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
  });
});
