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

function booting(storyId: string, requestId: string): StoryFreezePreviewStateV1 {
  return {
    protocolVersion: STORYFREEZE_PREVIEW_PROTOCOL_VERSION,
    addonVersion: STORYFREEZE_ADDON_VERSION,
    requestId,
    storyId,
    status: 'booting',
  };
}

/**
 * Page double for the notification path. `onStateRead` runs before each state
 * read resolves, which is how the tests drive the exact interleavings that the
 * generation snapshot has to survive.
 */
function notifyingPage(options: {
  notifiesStateChanges: boolean;
  initialState: (storyId: string, requestId: string) => StoryFreezePreviewStateV1;
  onStateRead?: (readCount: number) => void;
}) {
  const holder: { navigator?: StoryNavigator; state?: StoryFreezePreviewStateV1; reads: number; url: string } = {
    reads: 0,
    url: '',
  };
  const page = {
    goto: vi.fn(async (url: string) => {
      holder.url = url;
      const parsed = new URL(url);
      holder.state = options.initialState(
        parsed.searchParams.get('id')!,
        parsed.searchParams.get('storyfreezeRequestId')!,
      );
    }),
    currentUrl: () => holder.url,
    evaluate: vi.fn(async (_fn: unknown, argument: any) => {
      if (typeof argument === 'string') {
        holder.reads += 1;
        // Snapshot before the hook runs: a read already in flight cannot observe
        // a state the Preview publishes while it is on the wire, which is the
        // interleaving these tests need to reproduce.
        const observed = holder.state;
        options.onStateRead?.(holder.reads);
        return observed;
      }
      if (argument?.method) return undefined;
      return { available: true, notifiesStateChanges: options.notifiesStateChanges };
    }),
  };
  return { holder, page };
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

  it('resolves from a Preview notification instead of polling the state global', async () => {
    const { holder, page } = notifyingPage({
      notifiesStateChanges: true,
      initialState: booting,
      onStateRead: readCount => {
        if (readCount !== 1) return;
        // The Preview publishes its terminal state a moment later, exactly as
        // finalizeScreenshot does after render and play complete.
        setTimeout(() => {
          holder.state = ready('button--primary', '0-1');
          holder.navigator!.notifyStateChanged('ready');
        }, 5);
      },
    });
    holder.navigator = new StoryNavigator(page as never, new URL('https://example.test'), 0);
    await holder.navigator.navigate('button--primary');
    await expect(holder.navigator.waitForReady(2_000)).resolves.toMatchObject({ viewport: { width: 800 } });
    // One read observed 'booting', the second observed 'ready'. A polling loop
    // would have needed many more within the same window.
    expect(holder.reads).toBe(2);
  });

  it('does not miss a terminal state published while the state read is in flight', async () => {
    const { holder, page } = notifyingPage({
      notifiesStateChanges: true,
      initialState: booting,
      onStateRead: readCount => {
        if (readCount !== 1) return;
        // Lands before the waiter is registered: only the generation snapshot
        // taken ahead of the read can save this.
        holder.state = ready('button--primary', '0-1');
        holder.navigator!.notifyStateChanged('ready');
      },
    });
    holder.navigator = new StoryNavigator(page as never, new URL('https://example.test'), 0);
    await holder.navigator.navigate('button--primary');
    // The timeout is shorter than the safety re-read interval, so a lost
    // notification would surface as a readiness timeout rather than a slow pass.
    await expect(holder.navigator.waitForReady(200)).resolves.toMatchObject({ viewport: { width: 800 } });
    expect(holder.reads).toBe(2);
  });

  it('ignores non-terminal notifications so booting transitions cost no extra read', async () => {
    const { holder, page } = notifyingPage({
      notifiesStateChanges: true,
      initialState: booting,
      onStateRead: readCount => {
        if (readCount !== 1) return;
        setTimeout(() => {
          // triggerScreenshot republishes 'booting' during render; that must not
          // wake the waiter.
          holder.navigator!.notifyStateChanged('booting');
          holder.navigator!.notifyStateChanged('booting');
          setTimeout(() => {
            holder.state = ready('button--primary', '0-1');
            holder.navigator!.notifyStateChanged('ready');
          }, 5);
        }, 5);
      },
    });
    holder.navigator = new StoryNavigator(page as never, new URL('https://example.test'), 0);
    await holder.navigator.navigate('button--primary');
    await expect(holder.navigator.waitForReady(2_000)).resolves.toMatchObject({ viewport: { width: 800 } });
    expect(holder.reads).toBe(2);
  });

  it('keeps polling a Preview that does not announce state changes', async () => {
    const { holder, page } = notifyingPage({
      notifiesStateChanges: false,
      initialState: booting,
      onStateRead: readCount => {
        if (readCount !== 3) return;
        holder.state = ready('button--primary', '0-1');
      },
    });
    holder.navigator = new StoryNavigator(page as never, new URL('https://example.test'), 0);
    await holder.navigator.navigate('button--primary');
    await expect(holder.navigator.waitForReady(2_000)).resolves.toMatchObject({ viewport: { width: 800 } });
    // Four reads prove the legacy 25 msec loop is still what drives this Preview.
    expect(holder.reads).toBe(4);
  });

  it('aborts a pending readiness notification wait', async () => {
    const { holder, page } = notifyingPage({ notifiesStateChanges: true, initialState: booting });
    holder.navigator = new StoryNavigator(page as never, new URL('https://example.test'), 0);
    await holder.navigator.navigate('button--primary');
    const controller = new AbortController();
    const waiting = holder.navigator.waitForReady(10_000, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
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
