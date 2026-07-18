import type { BrowserRequest, CapturePage } from './browser-backend.js';
import { raceAgainstTimeout } from './async-utils.js';

// Derived from storycrawler. Copyright (c) 2019 reg-viz, MIT licensed.
// https://github.com/reg-viz/storycap/tree/master/packages/storycrawler
// The implementation is intentionally request-based so repeated requests to the
// same URL cannot reuse an already-resolved completion promise.

const ignoredResourceTypes = new Set(['media', 'texttrack', 'websocket', 'eventsource', 'other']);

export class ResourceWatcher {
  private inFlight = new Set<BrowserRequest>();
  private requestedAssetUrls = new Set<string>();
  private unsubscribe?: () => void;
  private activityGeneration = 0;
  private lastActivityAt = Date.now();
  private activityWaiters = new Set<() => void>();

  constructor(private page: Pick<CapturePage, 'subscribeRequests'>) {}

  private onRequest = (request: BrowserRequest) => {
    const url = request.url;
    if (request.method !== 'GET' || ignoredResourceTypes.has(request.resourceType) || !url.startsWith('http')) {
      return;
    }

    this.requestedAssetUrls.add(url);
    this.inFlight.add(request);
    this.notifyActivity();
  };

  private onRequestComplete = (request: BrowserRequest) => {
    if (!this.inFlight.delete(request)) return;
    this.notifyActivity();
  };

  private notifyActivity() {
    this.activityGeneration += 1;
    this.lastActivityAt = Date.now();
    const waiters = [...this.activityWaiters];
    this.activityWaiters.clear();
    waiters.forEach(resolve => resolve());
  }

  init() {
    this.unsubscribe = this.page.subscribeRequests({
      finished: this.onRequestComplete,
      started: this.onRequest,
    });
    return this;
  }

  dispose() {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    try {
      unsubscribe?.();
    } finally {
      this.clear();
    }
  }

  clear() {
    this.inFlight.clear();
    this.requestedAssetUrls.clear();
    this.notifyActivity();
  }

  getRequestedUrls() {
    return [...this.requestedAssetUrls];
  }

  getDiagnosticSnapshot() {
    return {
      pending: [...this.inFlight].map(request => ({
        method: request.method,
        resourceType: request.resourceType,
        url: request.url,
      })),
      requestedUrls: this.getRequestedUrls(),
    };
  }

  private async waitForActivity(timeoutMs: number, signal?: AbortSignal, expectedGeneration = this.activityGeneration) {
    let resolveActivity = () => {};
    const activity = new Promise<void>(resolve => {
      resolveActivity = resolve;
      this.activityWaiters.add(resolve);
      if (this.activityGeneration !== expectedGeneration) resolve();
    });
    try {
      return await raceAgainstTimeout(activity, timeoutMs, signal);
    } finally {
      this.activityWaiters.delete(resolveActivity);
    }
  }

  async waitForRequestsComplete(options: { quietMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{
    didTimeout: boolean;
    elapsedMs: number;
    pending: ReturnType<ResourceWatcher['getDiagnosticSnapshot']>['pending'];
    requestedUrls: string[];
  }> {
    const quietMs = options.quietMs ?? 0;
    const timeoutMs = options.timeoutMs ?? Number.POSITIVE_INFINITY;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let quietStartedAt: number | undefined;
    let quietGeneration = -1;

    const result = (didTimeout: boolean) => ({
      didTimeout,
      elapsedMs: Date.now() - startedAt,
      pending: this.getDiagnosticSnapshot().pending,
      requestedUrls: this.getRequestedUrls(),
    });

    while (true) {
      const now = Date.now();
      if (this.inFlight.size === 0) {
        if (quietStartedAt === undefined || quietGeneration !== this.activityGeneration) {
          quietStartedAt = this.lastActivityAt;
          quietGeneration = this.activityGeneration;
        }
        const quietRemaining = quietMs - (now - quietStartedAt);
        if (quietRemaining <= 0) return result(false);
        if (now >= deadline) return result(true);
        await this.waitForActivity(Math.min(quietRemaining, deadline - now), options.signal, quietGeneration);
      } else {
        quietStartedAt = undefined;
        if (now >= deadline) return result(true);
        const activity = await this.waitForActivity(deadline - now, options.signal, this.activityGeneration);
        if (activity.timedOut) return result(true);
      }
    }
  }
}
