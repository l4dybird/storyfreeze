import type { ScreenshotOptions, Exposed, PreviewCaptureDiagnostic } from '../shared/types.js';
import {
  mergeScreenshotOptions,
  pickupWithVariantKey,
  expandViewportsOption,
  extractVariantKeys,
  variantKeyIdentifier,
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
import {
  initializeStorySessionController,
  registerStorySessionRuntime,
  setStorySessionReset,
  snapshotStorySessionRuntime,
} from './story-session-controller.js';

type Args<T> = T extends (...args: infer A) => unknown ? A : never;
type Return<T> = T extends (...args: infer _A) => infer R ? R : never;

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
  initializeStorySessionController(win);
  setState(win, { ...createPreviewStateBase(identity.storyId, identity.requestId), status: 'booting' });
}

function waitForDelayTime(time = 0, signal?: AbortSignal) {
  if (time <= 0 || signal?.aborted) return Promise.resolve();
  const delay = Math.min(2_147_483_647, time);
  return new Promise<void>(resolve => {
    const state: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = () => {
      if (state.timer) clearTimeout(state.timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    signal?.addEventListener('abort', finish, { once: true });
    state.timer = setTimeout(finish, delay);
    if (signal?.aborted) finish();
  });
}

function waitUserFunction(waitFor: undefined | null | string | (() => Promise<unknown>)) {
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
  const normalized = { ...options };
  delete normalized.waitFor;
  delete normalized.reset;
  if (options.variants) {
    normalized.variants = Object.fromEntries(
      Object.entries(options.variants).map(([key, variant]) => {
        const normalizedVariant = { ...variant };
        delete normalizedVariant.waitFor;
        return [key, normalizedVariant];
      }),
    );
  }
  return normalized as NormalizedScreenshotOptions;
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
  const resolvedOptions = applyViewportFromGlobals(screenshotOptions, context);
  registerStorySessionRuntime(resolvedOptions, context);
  pushOptions(win, context.id, resolvedOptions);
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
      await waitForDelayTime(screenshotOptions.delay, context.abortSignal);
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
    const [invalidVariantGraph, variantKeys] = extractVariantKeys(mergedOptions);
    const runtimeWaitForVariants = invalidVariantGraph
      ? []
      : [
          ...new Set(
            variantKeys
              .filter(key => Boolean(pickupWithVariantKey(mergedOptions, key).waitFor))
              .map(key => variantKeyIdentifier(key.keys)),
          ),
        ].sort();
    setStorySessionReset(context.id, (mergedOptions as ScreenshotOptions).reset, win);
    snapshotStorySessionRuntime(context.id, win);
    const normalizedOptions = normalizeOptions(screenshotOptions);
    const normalizedRootOptions = screenshotOptions === mergedOptions ? undefined : normalizeOptions(mergedOptions);
    setState(win, {
      ...baseState,
      status: 'ready',
      options: normalizedOptions,
      ...(normalizedRootOptions ? { rootOptions: normalizedRootOptions } : {}),
      runtime: {
        hasCustomReset: typeof (mergedOptions as ScreenshotOptions).reset === 'function',
        hasRuntimeWaitFor: Boolean(screenshotOptions.waitFor),
        runtimeWaitForVariants,
      },
    });
  } catch (error) {
    if (context.abortSignal?.aborted) return;
    setState(win, { ...baseState, status: 'error', error: serializeError(error) });
    throw error;
  }
}
