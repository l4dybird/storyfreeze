import type { BrowserRequest, PlaywrightCapturePage } from './playwright-runtime.js';
import { raceAgainstTimeout } from './async-utils.js';

// Derived from storycrawler. Copyright (c) 2019 reg-viz, MIT licensed.
// https://github.com/reg-viz/storycap/tree/master/packages/storycrawler
// The implementation is intentionally request-based so repeated requests to the
// same URL cannot reuse an already-resolved completion promise.

const ignoredResourceTypes = new Set(['media', 'texttrack', 'websocket', 'eventsource', 'other']);

export class ResourceWatcher {
  private inFlight = new Set<BrowserRequest>();
  private unsubscribe?: () => void;
  private activityGeneration = 0;
  private activityWaiters = new Set<() => void>();

  constructor(private page: Pick<PlaywrightCapturePage, 'subscribeRequests'>) {}

  private onRequest = (request: BrowserRequest) => {
    if (ignoredResourceTypes.has(request.resourceType) || !request.url.startsWith('http')) {
      return;
    }

    this.inFlight.add(request);
    this.notifyActivity();
  };

  private onRequestComplete = (request: BrowserRequest) => {
    if (!this.inFlight.delete(request)) return;
    this.notifyActivity();
  };

  private notifyActivity() {
    this.activityGeneration += 1;
    for (const resolve of this.activityWaiters) resolve();
    this.activityWaiters.clear();
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
    this.notifyActivity();
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

  async waitForRequestsComplete(
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ didTimeout: boolean }> {
    const timeoutMs = options.timeoutMs ?? Number.POSITIVE_INFINITY;
    const deadline = Date.now() + timeoutMs;

    while (this.inFlight.size > 0) {
      const now = Date.now();
      if (now >= deadline) return { didTimeout: true };
      const activity = await this.waitForActivity(deadline - now, options.signal, this.activityGeneration);
      if (activity.timedOut) return { didTimeout: true };
    }
    return { didTimeout: false };
  }
}
