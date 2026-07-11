import type { HTTPRequest, Page } from 'puppeteer-core';

// Derived from storycrawler. Copyright (c) 2019 reg-viz, MIT licensed.
// https://github.com/reg-viz/storycap/tree/master/packages/storycrawler
// The implementation is intentionally request-based so repeated requests to the
// same URL cannot reuse an already-resolved completion promise.

type InFlightRequest = {
  resolved: Promise<void>;
  resolve: () => void;
};

const ignoredResourceTypes = new Set(['media', 'texttrack', 'websocket', 'eventsource', 'other']);

export class ResourceWatcher {
  private inFlight = new Map<HTTPRequest, InFlightRequest>();
  private requestedAssetUrls = new Set<string>();

  constructor(private page: Page) {}

  private onRequest = (request: HTTPRequest) => {
    const url = request.url();
    if (request.method() !== 'GET' || ignoredResourceTypes.has(request.resourceType()) || !url.startsWith('http')) {
      return;
    }

    let resolve = () => {};
    const resolved = new Promise<void>(done => (resolve = done));
    this.requestedAssetUrls.add(url);
    this.inFlight.set(request, { resolve, resolved });
  };

  private onRequestComplete = (request: HTTPRequest) => {
    const metadata = this.inFlight.get(request);
    if (!metadata) return;
    this.inFlight.delete(request);
    metadata.resolve();
  };

  init() {
    this.page.on('request', this.onRequest);
    this.page.on('requestfinished', this.onRequestComplete);
    this.page.on('requestfailed', this.onRequestComplete);
    return this;
  }

  dispose() {
    this.page.off('request', this.onRequest);
    this.page.off('requestfinished', this.onRequestComplete);
    this.page.off('requestfailed', this.onRequestComplete);
    this.clear();
  }

  clear() {
    this.inFlight.forEach(metadata => metadata.resolve());
    this.inFlight.clear();
    this.requestedAssetUrls.clear();
  }

  getRequestedUrls() {
    return [...this.requestedAssetUrls];
  }

  async waitForRequestsComplete() {
    const urls = this.getRequestedUrls();
    while (this.inFlight.size) {
      await Promise.all([...this.inFlight.values()].map(metadata => metadata.resolved));
    }
    return urls;
  }
}
