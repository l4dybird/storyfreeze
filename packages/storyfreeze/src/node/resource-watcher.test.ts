import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BrowserRequest, RequestListeners } from './browser-backend.js';
import { ResourceWatcher } from './resource-watcher.js';

class FakePage {
  private listeners?: RequestListeners;

  finish(request: BrowserRequest) {
    this.listeners?.finished(request);
  }

  start(request: BrowserRequest) {
    this.listeners?.started(request);
  }

  subscribeRequests(listeners: RequestListeners) {
    this.listeners = listeners;
    return () => (this.listeners = undefined);
  }
}

function request(url: string): BrowserRequest {
  return { method: 'GET', resourceType: 'image', url };
}

describe(ResourceWatcher, () => {
  let page: FakePage;
  let watcher: ResourceWatcher;

  beforeEach(() => {
    page = new FakePage();
    watcher = new ResourceWatcher(page).init();
  });

  afterEach(() => {
    watcher.dispose();
    vi.useRealTimers();
  });

  it('waits for each request even when a URL is requested repeatedly', async () => {
    const first = request('https://example.test/image.png');
    page.start(first);
    page.finish(first);
    await watcher.waitForRequestsComplete({ quietMs: 0 });

    const second = request('https://example.test/image.png');
    page.start(second);
    let completed = false;
    const waiting = watcher.waitForRequestsComplete({ quietMs: 0 }).then(() => (completed = true));

    await Promise.resolve();
    expect(completed).toBe(false);

    page.finish(second);
    await waiting;
    expect(completed).toBe(true);
  });

  it('waits for concurrent requests to the same URL independently', async () => {
    const first = request('https://example.test/font.woff2');
    const second = request('https://example.test/font.woff2');
    page.start(first);
    page.start(second);

    expect(watcher.getDiagnosticSnapshot()).toEqual({
      pending: [first, second],
      requestedUrls: ['https://example.test/font.woff2'],
    });

    let completed = false;
    const waiting = watcher.waitForRequestsComplete({ quietMs: 0 }).then(() => (completed = true));
    page.finish(first);
    await Promise.resolve();
    expect(completed).toBe(false);

    page.finish(second);
    await waiting;
    expect(watcher.getRequestedUrls()).toEqual(['https://example.test/font.woff2']);
    expect(watcher.getDiagnosticSnapshot().pending).toEqual([]);
  });

  it('restarts the quiet window when a new request arrives', async () => {
    vi.useFakeTimers();
    const first = request('https://example.test/first.png');
    page.start(first);
    let completed = false;
    const waiting = watcher.waitForRequestsComplete({ quietMs: 100, timeoutMs: 1000 }).then(() => (completed = true));

    page.finish(first);
    await vi.advanceTimersByTimeAsync(99);
    expect(completed).toBe(false);

    const second = request('https://example.test/second.png');
    page.start(second);
    page.finish(second);
    await vi.advanceTimersByTimeAsync(99);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await waiting;
    expect(completed).toBe(true);
  });

  it('does not restart a quiet window that elapsed before the wait began', async () => {
    vi.useFakeTimers();
    watcher.clear();
    const completed = request('https://example.test/already-complete.png');
    page.start(completed);
    page.finish(completed);
    await vi.advanceTimersByTimeAsync(100);

    await expect(watcher.waitForRequestsComplete({ quietMs: 100, timeoutMs: 1000 })).resolves.toMatchObject({
      didTimeout: false,
      elapsedMs: 0,
      pending: [],
    });
  });

  it('does not wait when activity already advanced the expected generation', async () => {
    page.start(request('https://example.test/late.png'));

    await expect(
      (
        watcher as unknown as {
          waitForActivity(
            timeoutMs: number,
            signal: AbortSignal | undefined,
            expectedGeneration: number,
          ): Promise<{
            timedOut: boolean;
          }>;
        }
      ).waitForActivity(1000, undefined, 0),
    ).resolves.toMatchObject({ timedOut: false });
  });

  it('returns pending requests at the wall timeout and supports abort', async () => {
    vi.useFakeTimers();
    const pending = request('https://example.test/pending.png');
    page.start(pending);
    const waiting = watcher.waitForRequestsComplete({ quietMs: 100, timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    await expect(waiting).resolves.toMatchObject({ didTimeout: true, pending: [pending] });

    const controller = new AbortController();
    const aborted = watcher.waitForRequestsComplete({ quietMs: 100, timeoutMs: 1000, signal: controller.signal });
    controller.abort(new Error('interrupted'));
    await expect(aborted).rejects.toThrow('interrupted');
  });
});
