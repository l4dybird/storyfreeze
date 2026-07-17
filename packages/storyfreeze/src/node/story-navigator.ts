import { sleep } from './async-utils.js';
import type { CapturePage } from './browser-backend.js';
import type { PreviewMode, RunMode } from './types.js';
import {
  PreviewAddonVersionMismatchError,
  PreviewModeRequiredError,
  PreviewProtocolVersionError,
  PreviewReadyTimeoutError,
  PreviewRenderError,
  PreviewStateMismatchError,
  PreviewStateValidationError,
  PreviewUrlRedirectError,
  SimplePreviewReadyTimeoutError,
  SimplePreviewRenderError,
} from './errors.js';
import {
  STORYFREEZE_ADDON_VERSION,
  STORYFREEZE_PREVIEW_PROTOCOL_VERSION,
  STORYFREEZE_PREVIEW_STATE_GLOBAL,
  STORYFREEZE_REQUEST_ID_PARAM,
  type NormalizedScreenshotOptions,
  type PreviewRuntimeMetadata,
  type StoryFreezePreviewStateV1,
} from '../shared/preview-protocol.js';

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

type NavigationPage = Pick<CapturePage, 'currentUrl' | 'evaluate' | 'goto'>;

export type PreviewModeDetection = {
  mode: RunMode;
  reason: string;
};

type SimplePreviewState =
  | { status: 'ready'; bodyClassName: string }
  | { status: 'pending'; bodyClassName: string }
  | { status: 'no-preview'; bodyClassName: string }
  | { status: 'error'; bodyClassName: string; message: string; stack: string };

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

async function readSimplePreviewState(page: NavigationPage): Promise<SimplePreviewState> {
  return page.evaluate(() => {
    const bodyClassName = document.body?.className ?? '';
    const bodyClasses = document.body?.classList;
    if (bodyClasses?.contains('sb-show-nopreview')) {
      return { status: 'no-preview' as const, bodyClassName };
    }
    if (bodyClasses?.contains('sb-show-errordisplay')) {
      return {
        status: 'error' as const,
        bodyClassName,
        message: document.querySelector('#error-message')?.textContent?.trim() ?? '',
        stack: document.querySelector('#error-stack')?.textContent?.trim() ?? '',
      };
    }
    if (bodyClasses?.contains('sb-show-main')) {
      return { status: 'ready' as const, bodyClassName };
    }
    return { status: 'pending' as const, bodyClassName };
  });
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
    if (raw.runtime !== undefined) {
      if (
        !isRecord(raw.runtime) ||
        typeof raw.runtime.hasCustomReset !== 'boolean' ||
        typeof raw.runtime.hasRuntimeWaitFor !== 'boolean' ||
        !Array.isArray(raw.runtime.runtimeWaitForVariants) ||
        !raw.runtime.runtimeWaitForVariants.every(key => typeof key === 'string')
      ) {
        throw new PreviewStateValidationError('ready.runtime metadata is invalid');
      }
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

async function waitForMarker(
  page: NavigationPage,
  expected: ExpectedPreviewState,
  timeout: number,
  signal?: AbortSignal,
): Promise<StoryFreezePreviewStateV1 | undefined> {
  const deadline = Date.now() + timeout;
  do {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.');
    }
    const raw = await readPreviewState(page);
    if (raw !== undefined) return validatePreviewState(raw, expected);
    await sleep(25);
  } while (Date.now() < deadline);
  return undefined;
}

export async function detectPreviewMode(
  page: NavigationPage,
  baseUrl: URL,
  storyId: string,
  timeout: number,
  requestedMode: PreviewMode = 'auto',
  signal?: AbortSignal,
): Promise<PreviewModeDetection> {
  const requestId = 'mode-detection';
  const url = createStoryPreviewUrl(baseUrl, storyId, requestId);
  await page.goto(url.href, { timeout: 60000, waitUntil: 'domcontentloaded' });
  assertPreviewUrl(page, url, { storyId, requestId });
  if (requestedMode === 'simple') {
    return { mode: 'simple', reason: 'forced by --mode simple' };
  }
  if (await waitForMarker(page, { storyId, requestId }, timeout, signal)) {
    return { mode: 'managed', reason: 'the StoryFreeze preview marker was detected' };
  }
  if (requestedMode === 'managed') {
    throw new PreviewModeRequiredError(timeout, page.currentUrl());
  }
  return { mode: 'simple', reason: 'the StoryFreeze preview marker was not detected' };
}

export class StoryNavigator {
  private sequence = 0;
  private current?: ExpectedPreviewState;
  private _rootOptions?: NormalizedScreenshotOptions;
  private _runtimeMetadata?: PreviewRuntimeMetadata;

  constructor(
    private readonly page: NavigationPage,
    private readonly baseUrl: URL,
    private readonly workerId: number,
  ) {}

  get rootOptions() {
    return this._rootOptions;
  }

  get runtimeMetadata() {
    return this._runtimeMetadata;
  }

  async navigate(storyId: string, timeout = 60_000, retryCount = 0): Promise<void> {
    const requestId = `${this.workerId}-${++this.sequence}`;
    this.current = { storyId, requestId };
    this._rootOptions = undefined;
    this._runtimeMetadata = undefined;
    const url = createStoryPreviewUrl(this.baseUrl, storyId, requestId, retryCount);
    await this.page.goto(url.href, { timeout, waitUntil: 'domcontentloaded' });
    assertPreviewUrl(this.page, url, this.current);
  }

  async waitForReady(timeout: number, signal?: AbortSignal): Promise<NormalizedScreenshotOptions> {
    if (!this.current) throw new Error('Story preview navigation has not started.');
    const deadline = Date.now() + timeout;
    let lastState: unknown;

    do {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.');
      }
      lastState = await readPreviewState(this.page);
      if (lastState !== undefined) {
        const state = validatePreviewState(lastState, this.current);
        if (state.status === 'ready') {
          this._rootOptions = state.rootOptions ?? state.options;
          this._runtimeMetadata = state.runtime;
          return state.options;
        }
        if (state.status === 'error') throw new PreviewRenderError(state.storyId, state.error);
      }
      await sleep(25);
    } while (Date.now() < deadline);

    throw new PreviewReadyTimeoutError(timeout, this.page.currentUrl(), this.current, lastState);
  }

  async waitForSimpleReady(timeout: number, signal?: AbortSignal): Promise<void> {
    if (!this.current) throw new Error('Story preview navigation has not started.');
    const deadline = Date.now() + timeout;
    let lastState: SimplePreviewState = { status: 'pending', bodyClassName: '' };

    do {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.');
      }
      lastState = await readSimplePreviewState(this.page);
      if (lastState.status === 'ready') return;
      if (lastState.status === 'no-preview') {
        throw new SimplePreviewRenderError(this.current.storyId, this.page.currentUrl(), 'No Preview is visible.');
      }
      if (lastState.status === 'error') {
        const detail = [lastState.message || 'Storybook error display is visible.', lastState.stack]
          .filter(Boolean)
          .join('\n');
        throw new SimplePreviewRenderError(this.current.storyId, this.page.currentUrl(), detail);
      }
      await sleep(25);
    } while (Date.now() < deadline);

    throw new SimplePreviewReadyTimeoutError(
      timeout,
      this.current.storyId,
      this.page.currentUrl(),
      lastState.bodyClassName,
    );
  }
}
