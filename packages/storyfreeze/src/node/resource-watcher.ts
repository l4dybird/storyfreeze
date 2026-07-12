import type { BrowserRequest, CapturePage } from './browser-backend.js';

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
  private inFlight = new Map<BrowserRequest, InFlightRequest>();
  private requestedAssetUrls = new Set<string>();
  private unsubscribe?: () => void;

  constructor(private page: Pick<CapturePage, 'subscribeRequests'>) {}

  private onRequest = (request: BrowserRequest) => {
    const url = request.url;
    if (request.method !== 'GET' || ignoredResourceTypes.has(request.resourceType) || !url.startsWith('http')) {
      return;
    }

    let resolve = () => {};
    const resolved = new Promise<void>(done => (resolve = done));
    this.requestedAssetUrls.add(url);
    this.inFlight.set(request, { resolve, resolved });
  };

  private onRequestComplete = (request: BrowserRequest) => {
    const metadata = this.inFlight.get(request);
    if (!metadata) return;
    this.inFlight.delete(request);
    metadata.resolve();
  };

  init() {
    this.unsubscribe = this.page.subscribeRequests({
      finished: this.onRequestComplete,
      started: this.onRequest,
    });
    return this;
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
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

  getDiagnosticSnapshot() {
    return {
      pending: [...this.inFlight.keys()].map(request => ({
        method: request.method,
        resourceType: request.resourceType,
        url: request.url,
      })),
      requestedUrls: this.getRequestedUrls(),
    };
  }

  async waitForRequestsComplete() {
    const urls = this.getRequestedUrls();
    while (this.inFlight.size) {
      await Promise.all([...this.inFlight.values()].map(metadata => metadata.resolved));
    }
    return urls;
  }
}
