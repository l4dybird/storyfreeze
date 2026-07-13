import { sleep } from './async-utils.js';
import type { CapturePage } from './browser-backend.js';
import type { RunMode } from './types.js';
import {
  PreviewAddonVersionMismatchError,
  PreviewProtocolVersionError,
  PreviewReadyTimeoutError,
  PreviewRenderError,
  PreviewStateMismatchError,
  PreviewStateValidationError,
} from './errors.js';
import {
  STORYFREEZE_ADDON_VERSION,
  STORYFREEZE_PREVIEW_PROTOCOL_VERSION,
  STORYFREEZE_PREVIEW_STATE_GLOBAL,
  STORYFREEZE_REQUEST_ID_PARAM,
  type NormalizedScreenshotOptions,
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
  if (retryCount !== undefined) url.searchParams.set(STORYFREEZE_RETRY_COUNT_PARAM, String(retryCount));
  return url;
}

type NavigationPage = Pick<CapturePage, 'currentUrl' | 'evaluate' | 'goto'>;

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
  signal?: AbortSignal,
): Promise<RunMode> {
  const requestId = 'mode-detection';
  const url = createStoryPreviewUrl(baseUrl, storyId, requestId);
  await page.goto(url.href, { timeout: 60000, waitUntil: 'domcontentloaded' });
  return (await waitForMarker(page, { storyId, requestId }, timeout, signal)) ? 'managed' : 'simple';
}

export class StoryNavigator {
  private sequence = 0;
  private current?: ExpectedPreviewState;

  constructor(
    private readonly page: NavigationPage,
    private readonly baseUrl: URL,
    private readonly workerId: number,
  ) {}

  async navigate(storyId: string, timeout = 60_000, retryCount = 0): Promise<void> {
    const requestId = `${this.workerId}-${++this.sequence}`;
    this.current = { storyId, requestId };
    const url = createStoryPreviewUrl(this.baseUrl, storyId, requestId, retryCount);
    await this.page.goto(url.href, { timeout, waitUntil: 'domcontentloaded' });
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
        if (state.status === 'ready') return state.options;
        if (state.status === 'error') throw new PreviewRenderError(state.storyId, state.error);
      }
      await sleep(25);
    } while (Date.now() < deadline);

    throw new PreviewReadyTimeoutError(timeout, this.page.currentUrl(), this.current, lastState);
  }
}
