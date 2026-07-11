import { EventEmitter } from 'events';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { ResourceWatcher } from './resource-watcher.js';

class FakePage extends EventEmitter {}

function request(url: string): HTTPRequest {
  return {
    method: () => 'GET',
    resourceType: () => 'image',
    url: () => url,
  } as HTTPRequest;
}

describe(ResourceWatcher, () => {
  let page: FakePage;
  let watcher: ResourceWatcher;

  beforeEach(() => {
    page = new FakePage();
    watcher = new ResourceWatcher(page as unknown as Page).init();
  });

  afterEach(() => watcher.dispose());

  it('waits for each request even when a URL is requested repeatedly', async () => {
    const first = request('https://example.test/image.png');
    page.emit('request', first);
    page.emit('requestfinished', first);
    await watcher.waitForRequestsComplete();

    const second = request('https://example.test/image.png');
    page.emit('request', second);
    let completed = false;
    const waiting = watcher.waitForRequestsComplete().then(() => (completed = true));

    await Promise.resolve();
    expect(completed).toBe(false);

    page.emit('requestfinished', second);
    await waiting;
    expect(completed).toBe(true);
  });

  it('waits for concurrent requests to the same URL independently', async () => {
    const first = request('https://example.test/font.woff2');
    const second = request('https://example.test/font.woff2');
    page.emit('request', first);
    page.emit('request', second);

    let completed = false;
    const waiting = watcher.waitForRequestsComplete().then(() => (completed = true));
    page.emit('requestfinished', first);
    await Promise.resolve();
    expect(completed).toBe(false);

    page.emit('requestfailed', second);
    await waiting;
    expect(watcher.getRequestedUrls()).toEqual(['https://example.test/font.woff2']);
  });
});
