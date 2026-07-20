import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BrowserRequest, RequestListeners } from './playwright-runtime.js';
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

function request(url: string, resourceType = 'image'): BrowserRequest {
  return { resourceType, url };
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

  it('waits for repeated and concurrent request instances independently', async () => {
    const first = request('https://example.test/image.png');
    const second = request('https://example.test/image.png');
    page.start(first);
    page.start(second);

    let completed = false;
    const waiting = watcher.waitForRequestsComplete().then(() => (completed = true));
    page.finish(first);
    await Promise.resolve();
    expect(completed).toBe(false);
    page.finish(second);
    await waiting;
    expect(completed).toBe(true);
  });

  it('tracks HTTP fetches and ignores resources that cannot settle', async () => {
    const fetchRequest = request('https://example.test/data', 'fetch');
    page.start(request('data:image/png;base64,AA=='));
    page.start(request('https://example.test/live', 'websocket'));
    page.start(fetchRequest);
    const waiting = watcher.waitForRequestsComplete();
    page.finish(fetchRequest);
    await expect(waiting).resolves.toEqual({ didTimeout: false });
  });

  it('returns at the wall timeout when a request remains in flight', async () => {
    vi.useFakeTimers();
    page.start(request('https://example.test/pending.png'));
    const waiting = watcher.waitForRequestsComplete({ timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    await expect(waiting).resolves.toEqual({ didTimeout: true });
  });

  it('aborts a pending wait and clear releases it', async () => {
    page.start(request('https://example.test/pending.png'));
    const controller = new AbortController();
    const aborted = watcher.waitForRequestsComplete({ timeoutMs: 1000, signal: controller.signal });
    controller.abort(new Error('interrupted'));
    await expect(aborted).rejects.toThrow('interrupted');

    const released = watcher.waitForRequestsComplete({ timeoutMs: 1000 });
    watcher.clear();
    await expect(released).resolves.toEqual({ didTimeout: false });
  });
});
