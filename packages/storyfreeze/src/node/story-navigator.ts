import { raceAgainstTimeout, sleep } from './async-utils.js';
import type { PlaywrightCapturePage } from './playwright-runtime.js';
import {
  PreviewAddonVersionMismatchError,
  PreviewProtocolVersionError,
  PreviewReadyTimeoutError,
  PreviewRenderError,
  PreviewStateMismatchError,
  PreviewStateValidationError,
  PreviewUrlRedirectError,
} from './errors.js';
import {
  STORYFREEZE_ADDON_VERSION,
  STORYFREEZE_PREVIEW_PROTOCOL_VERSION,
  STORYFREEZE_PREVIEW_STATE_GLOBAL,
  STORYFREEZE_REQUEST_ID_PARAM,
  type NormalizedScreenshotOptions,
  type StoryFreezePreviewStateV1,
} from '../shared/preview-protocol.js';
import { WorkerSessionProtocolClient } from './worker-session-protocol.js';

type ExpectedPreviewState = { storyId: string; requestId: string };

const STORYFREEZE_RETRY_COUNT_PARAM = 'storyfreezeRetryCount';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createStoryPreviewUrl(baseUrl: URL, storyId: string, requestId: string, retryCount?: number): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/iframe.html`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('id', storyId);
  url.searchParams.set('viewMode', 'story');
  url.searchParams.set(STORYFREEZE_REQUEST_ID_PARAM, requestId);
  if (retryCount !== undefined && Number.isFinite(retryCount) && retryCount > 0) {
    url.searchParams.set(STORYFREEZE_RETRY_COUNT_PARAM, String(retryCount));
  }
  return url;
}

type NavigationPage = Pick<PlaywrightCapturePage, 'currentUrl' | 'evaluate' | 'goto'>;

function assertPreviewUrl(page: NavigationPage, expectedUrl: URL, expected: ExpectedPreviewState) {
  const actualUrl = page.currentUrl();
  let actual: URL;
  try {
    actual = new URL(actualUrl);
  } catch {
    throw new PreviewUrlRedirectError(expectedUrl.href, actualUrl, expected.storyId, expected.requestId);
  }
  if (
    actual.searchParams.get('id') !== expected.storyId ||
    actual.searchParams.get(STORYFREEZE_REQUEST_ID_PARAM) !== expected.requestId
  ) {
    throw new PreviewUrlRedirectError(expectedUrl.href, actualUrl, expected.storyId, expected.requestId);
  }
}

async function readPreviewState(page: NavigationPage): Promise<unknown> {
  return page.evaluate(
    globalName => (window as unknown as Record<string, unknown>)[globalName],
    STORYFREEZE_PREVIEW_STATE_GLOBAL,
  );
}

function validatePreviewState(raw: unknown, expected: ExpectedPreviewState): StoryFreezePreviewStateV1 {
  if (!isRecord(raw)) {
    throw new PreviewStateValidationError('state must be an object');
  }
  if (raw.protocolVersion !== STORYFREEZE_PREVIEW_PROTOCOL_VERSION) {
    throw new PreviewProtocolVersionError(STORYFREEZE_PREVIEW_PROTOCOL_VERSION, raw.protocolVersion);
  }
  if (raw.addonVersion !== STORYFREEZE_ADDON_VERSION) {
    throw new PreviewAddonVersionMismatchError(STORYFREEZE_ADDON_VERSION, raw.addonVersion);
  }
  if (raw.storyId !== expected.storyId || raw.requestId !== expected.requestId) {
    throw new PreviewStateMismatchError(expected, { storyId: raw.storyId, requestId: raw.requestId });
  }
  if (raw.status === 'ready') {
    if (!isRecord(raw.options)) {
      throw new PreviewStateValidationError('ready.options must be an object');
    }
    if (raw.rootOptions !== undefined && !isRecord(raw.rootOptions)) {
      throw new PreviewStateValidationError('ready.rootOptions must be an object when provided');
    }
  } else if (raw.status === 'error') {
    if (!isRecord(raw.error) || typeof raw.error.name !== 'string' || typeof raw.error.message !== 'string') {
      throw new PreviewStateValidationError('error must contain string name and message fields');
    }
  } else if (raw.status !== 'booting') {
    throw new PreviewStateValidationError(`unknown status ${JSON.stringify(raw.status)}`);
  }
  return raw as unknown as StoryFreezePreviewStateV1;
}

/**
 * How long the notification-driven wait goes without a state transition before
 * it re-reads the state global anyway.
 *
 * This is a safety net for a lost binding call, not the primary wake path, so it
 * is much coarser than the polling interval. It is still kept well under the
 * 5 s default capture deadline: if a notification is ever dropped, the interval
 * is the latency the capture inherits, and it must not be large enough to push
 * an otherwise healthy story past its deadline.
 */
const notifiedSafetyReadIntervalMs = 250;
const pollIntervalMs = 25;

export class StoryNavigator {
  private sequence = 0;
  private current?: ExpectedPreviewState;
  private _rootOptions?: NormalizedScreenshotOptions;
  private reusableDocument = false;
  private workerSessionSupport: 'unknown' | 'supported' | 'unsupported' = 'unknown';
  private notifiesStateChanges = false;
  private stateGeneration = 0;
  private readonly stateWaiters = new Set<() => void>();
  private readonly workerSession: WorkerSessionProtocolClient;

  constructor(
    private readonly page: NavigationPage,
    private readonly baseUrl: URL,
    private readonly workerId: number,
  ) {
    this.workerSession = new WorkerSessionProtocolClient(page);
  }

  get rootOptions() {
    return this._rootOptions;
  }

  get canSelectStory() {
    return this.reusableDocument && this.workerSessionSupport !== 'unsupported';
  }

  async detectWorkerSessionSupport(): Promise<boolean> {
    if (this.workerSessionSupport !== 'unknown') return this.workerSessionSupport === 'supported';
    const capabilities = await this.workerSession.capabilities();
    this.workerSessionSupport = capabilities.available ? 'supported' : 'unsupported';
    this.notifiesStateChanges = capabilities.notifiesStateChanges;
    return capabilities.available;
  }

  /**
   * Called from the Node-side binding the Preview invokes after every state
   * write. Only terminal transitions advance the generation: a waiter has
   * nothing to act on while the story is still booting, so waking it there
   * would only cost an extra state read.
   */
  notifyStateChanged(status: string): void {
    if (status !== 'ready' && status !== 'error') return;
    this.stateGeneration += 1;
    for (const resolve of this.stateWaiters) resolve();
    this.stateWaiters.clear();
  }

  async navigate(storyId: string, timeout = 60_000, retryCount = 0): Promise<void> {
    this.invalidateDocument();
    const requestId = `${this.workerId}-${++this.sequence}`;
    this.current = { storyId, requestId };
    this._rootOptions = undefined;
    const url = createStoryPreviewUrl(this.baseUrl, storyId, requestId, retryCount);
    await this.page.goto(url.href, { timeout, waitUntil: 'domcontentloaded' });
    assertPreviewUrl(this.page, url, this.current);
    this.reusableDocument = true;
    // Learn the Preview's capabilities before the first readiness wait so that
    // wait can already use notifications. The result is cached for the life of
    // this navigator (one browser context), so this costs no extra round trip.
    if (this.workerSessionSupport === 'unknown') await this.detectWorkerSessionSupport().catch(() => undefined);
  }

  async selectStory(storyId: string): Promise<void> {
    if (!this.reusableDocument) throw new Error('Story preview document is not ready for worker-session selection.');
    const requestId = `${this.workerId}-${++this.sequence}`;
    this.current = { storyId, requestId };
    this._rootOptions = undefined;
    await this.workerSession.selectStory(this.current);
    this.workerSessionSupport = 'supported';
  }

  async completeCapture(variantId: string): Promise<void> {
    await this.workerSession.completeCapture(variantId);
  }

  invalidateDocument(): void {
    this.reusableDocument = false;
    this.workerSession.invalidate();
  }

  /**
   * Waits until the Preview publishes a terminal state for the current request.
   *
   * A Preview that advertises `notifiesStateChanges` is awaited rather than
   * polled: the generation is snapshotted *before* each read so a transition
   * that lands between the read and the wait registration cannot be missed.
   * Previews without the capability keep the original 25 msec polling loop.
   */
  async waitForReady(timeout: number, signal?: AbortSignal): Promise<NormalizedScreenshotOptions> {
    if (!this.current) throw new Error('Story preview navigation has not started.');
    const deadline = Date.now() + timeout;
    const notified = this.notifiesStateChanges;
    let lastState: unknown;

    do {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.');
      }
      const observedGeneration = this.stateGeneration;
      const read = await raceAgainstTimeout(readPreviewState(this.page), deadline - Date.now(), signal);
      if (read.timedOut) break;
      lastState = read.value;
      if (lastState !== undefined) {
        const state = validatePreviewState(lastState, this.current);
        if (state.status === 'ready') {
          this._rootOptions = state.rootOptions ?? state.options;
          return state.options;
        }
        if (state.status === 'error') throw new PreviewRenderError(state.storyId, state.error);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      if (notified) {
        await this.waitForStateChange(Math.min(notifiedSafetyReadIntervalMs, remaining), signal, observedGeneration);
      } else {
        await sleep(pollIntervalMs);
      }
    } while (Date.now() < deadline);

    throw new PreviewReadyTimeoutError(timeout, this.page.currentUrl(), this.current, lastState);
  }

  private async waitForStateChange(timeoutMs: number, signal: AbortSignal | undefined, expectedGeneration: number) {
    let resolveChange = () => {};
    const change = new Promise<void>(resolve => {
      resolveChange = resolve;
      this.stateWaiters.add(resolve);
      // Closes the window between reading the state and registering the waiter.
      if (this.stateGeneration !== expectedGeneration) resolve();
    });
    try {
      await raceAgainstTimeout(change, timeoutMs, signal);
    } finally {
      this.stateWaiters.delete(resolveChange);
    }
  }
}
