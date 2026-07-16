import type { ScreenshotOptions, Exposed, PreviewCaptureDiagnostic } from '../shared/types.js';
import {
  mergeScreenshotOptions,
  pickupWithVariantKey,
  expandViewportsOption,
} from '../shared/screenshot-options-helper.js';
import {
  STORYFREEZE_PREVIEW_STATE_GLOBAL,
  STORYFREEZE_REQUEST_ID_PARAM,
  createPreviewStateBase,
  type NormalizedScreenshotOptions,
  type SerializedError,
  type StoryFreezePreviewStateV1,
} from '../shared/preview-protocol.js';
import { waitForVisualCommitInPage } from '../shared/visual-commit.js';
import { applyViewportFromGlobals, type StoryContextLike } from './resolve-viewport-globals.js';

type Args<T> = T extends (...args: infer A) => any ? A : never;
type Return<T> = T extends (...args: any) => infer R ? R : never;

type ExposedFns = {
  [P in keyof Exposed]: (...args: Args<Exposed[P]>) => Promise<Return<Exposed[P]>>;
};

type StoryFreezeWindow = typeof window & {
  optionStore?: { [storyKey: string]: ScreenshotOptions[] };
  reportCaptureDiagnostic?: (event: PreviewCaptureDiagnostic) => Promise<void>;
  [STORYFREEZE_PREVIEW_STATE_GLOBAL]?: StoryFreezePreviewStateV1;
} & ExposedFns;

function getWindow(): StoryFreezeWindow | undefined {
  if (typeof window === 'undefined') return undefined;
  return window as StoryFreezeWindow;
}

function getCaptureIdentity() {
  if (typeof location === 'undefined') return undefined;
  const { searchParams } = new URL(location.href);
  const storyId = searchParams.get('id');
  const requestId = searchParams.get(STORYFREEZE_REQUEST_ID_PARAM);
  return storyId && requestId ? { storyId, requestId } : undefined;
}

function setState(win: StoryFreezeWindow, state: StoryFreezePreviewStateV1) {
  win[STORYFREEZE_PREVIEW_STATE_GLOBAL] = state;
}

export function initializePreviewState() {
  const win = getWindow();
  const identity = getCaptureIdentity();
  if (!win || !identity) return;
  setState(win, { ...createPreviewStateBase(identity.storyId, identity.requestId), status: 'booting' });
}

function waitForDelayTime(time: number = 0) {
  return new Promise(res => setTimeout(res, time));
}

function waitUserFunction(waitFor: undefined | null | string | (() => Promise<any>)) {
  if (!waitFor) return Promise.resolve();
  if (typeof waitFor === 'string') {
    const userDefinedFn = (window as unknown as Record<string, unknown>)[waitFor];
    return typeof userDefinedFn === 'function' ? Promise.resolve().then(() => userDefinedFn()) : Promise.resolve();
  }
  return typeof waitFor === 'function' ? waitFor() : Promise.resolve();
}

function pushOptions(win: StoryFreezeWindow, storyKey: string, opt: ScreenshotOptions) {
  if (!win.optionStore) win.optionStore = {};
  if (!win.optionStore[storyKey]) win.optionStore[storyKey] = [];
  win.optionStore[storyKey].push(opt);
}

function consumeOptions(win: StoryFreezeWindow, storyKey: string): ScreenshotOptions[] {
  const result = win.optionStore?.[storyKey] ?? [];
  if (win.optionStore) delete win.optionStore[storyKey];
  return result;
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  }
  return { name: 'Error', message: String(error) };
}

function normalizeOptions(options: ScreenshotOptions): NormalizedScreenshotOptions {
  const serializable = JSON.parse(JSON.stringify(options)) as NormalizedScreenshotOptions;
  delete (serializable as ScreenshotOptions).waitFor;
  return serializable;
}

/** Store screenshot parameters during Storybook's render phase. */
export function triggerScreenshot(
  screenshotOptions: ScreenshotOptions = {},
  context: StoryContextLike & { id?: string },
) {
  const win = getWindow();
  const identity = getCaptureIdentity();
  if (!win || !identity || !context.id) return;
  setState(win, { ...createPreviewStateBase(identity.storyId, identity.requestId), status: 'booting' });
  pushOptions(win, context.id, applyViewportFromGlobals(screenshotOptions, context));
}

/** Publish ready only from Storybook's project afterEach hook, after render and play complete. */
export async function finalizeScreenshot(context: { id?: string; abortSignal?: AbortSignal }) {
  const win = getWindow();
  const identity = getCaptureIdentity();
  if (!win || !identity || !context.id) return;
  if (!win.getBaseScreenshotOptions || !win.getCurrentVariantKey || !win.waitBrowserMetricsStable) return;
  if (context.abortSignal?.aborted) return;

  const baseState = createPreviewStateBase(identity.storyId, identity.requestId);
  try {
    if (context.id !== identity.storyId) {
      throw new Error(`StoryFreeze expected story ${identity.storyId}, but Storybook rendered ${context.id}.`);
    }
    const currentState = win[STORYFREEZE_PREVIEW_STATE_GLOBAL];
    if (currentState?.requestId === identity.requestId && currentState.status !== 'booting') return;
    const storedOptions = consumeOptions(win, context.id);
    if (storedOptions.length === 0) return;

    await win.waitBrowserMetricsStable();
    if (context.abortSignal?.aborted) return;
    const [baseScreenshotOptions, variantKey] = await Promise.all([
      win.getBaseScreenshotOptions(),
      win.getCurrentVariantKey(),
    ]);
    if (context.abortSignal?.aborted) return;
    const mergedOptions = storedOptions.reduce(
      (acc, opt) => mergeScreenshotOptions(acc, expandViewportsOption(opt)),
      baseScreenshotOptions,
    );
    const screenshotOptions = pickupWithVariantKey(mergedOptions, variantKey);

    if (!screenshotOptions.skip) {
      await waitForDelayTime(screenshotOptions.delay);
      if (context.abortSignal?.aborted) return;
      await waitUserFunction(screenshotOptions.waitFor);
      if (context.abortSignal?.aborted) return;
      const visualCommitDiagnostic = await waitForVisualCommitInPage(
        { paintFallbackMs: 250, timeoutMs: 3000 },
        context.abortSignal,
      );
      void Promise.resolve(
        win.reportCaptureDiagnostic?.({
          type: 'visual-commit',
          ...visualCommitDiagnostic,
          requestId: identity.requestId,
          storyId: identity.storyId,
          variantKey: variantKey.keys,
        }),
      ).catch(() => {});
      if (context.abortSignal?.aborted) return;
    }

    if (context.abortSignal?.aborted) return;
    setState(win, { ...baseState, status: 'ready', options: normalizeOptions(screenshotOptions) });
  } catch (error) {
    if (context.abortSignal?.aborted) return;
    setState(win, { ...baseState, status: 'error', error: serializeError(error) });
    throw error;
  }
}
