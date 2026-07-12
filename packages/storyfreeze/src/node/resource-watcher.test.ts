import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
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

  afterEach(() => watcher.dispose());

  it('waits for each request even when a URL is requested repeatedly', async () => {
    const first = request('https://example.test/image.png');
    page.start(first);
    page.finish(first);
    await watcher.waitForRequestsComplete();

    const second = request('https://example.test/image.png');
    page.start(second);
    let completed = false;
    const waiting = watcher.waitForRequestsComplete().then(() => (completed = true));

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

    let completed = false;
    const waiting = watcher.waitForRequestsComplete().then(() => (completed = true));
    page.finish(first);
    await Promise.resolve();
    expect(completed).toBe(false);

    page.finish(second);
    await waiting;
    expect(watcher.getRequestedUrls()).toEqual(['https://example.test/font.woff2']);
  });
});
