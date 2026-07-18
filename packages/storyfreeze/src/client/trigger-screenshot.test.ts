import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { STORYFREEZE_PREVIEW_STATE_GLOBAL } from '../shared/preview-protocol.js';
import { createBaseScreenshotOptions } from '../shared/screenshot-options-helper.js';
import { finalizeScreenshot, triggerScreenshot } from './trigger-screenshot.js';

describe(finalizeScreenshot, () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');

  function installWindow(overrides: Record<string, unknown> = {}) {
    const win = {
      getBaseScreenshotOptions: vi.fn(async () => ({})),
      getCurrentVariantKey: vi.fn(async () => ({ isDefault: true, keys: [] })),
      waitBrowserMetricsStable: vi.fn(async () => {}),
      ...overrides,
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { href: 'https://example.test/iframe.html?id=button--primary&storyfreezeRequestId=0-1' },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { images: [], visibilityState: 'visible' },
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    return win;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalRequestAnimationFrame) {
      Object.defineProperty(globalThis, 'requestAnimationFrame', originalRequestAnimationFrame);
    } else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  });

  it('does not publish ready from an aborted stale afterEach', async () => {
    let releaseMetrics = () => {};
    const win = installWindow({
      waitBrowserMetricsStable: vi.fn(() => new Promise<void>(resolve => (releaseMetrics = resolve))),
    });
    const controller = new AbortController();

    triggerScreenshot({ fullPage: true }, { id: 'button--primary' });
    const finalizing = finalizeScreenshot({ id: 'button--primary', abortSignal: controller.signal });
    await Promise.resolve();
    controller.abort();
    releaseMetrics();
    await finalizing;

    expect((win as Record<string, unknown>)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({
      requestId: '0-1',
      storyId: 'button--primary',
      status: 'booting',
    });
    expect(win.getBaseScreenshotOptions).not.toHaveBeenCalled();
  });

  it('publishes JSON-safe ready options after the preview lifecycle completes', async () => {
    const win = installWindow();

    triggerScreenshot({ fullPage: true, variants: { nested: { waitFor: async () => {} } } }, { id: 'button--primary' });
    await finalizeScreenshot({ id: 'button--primary', abortSignal: new AbortController().signal });

    const state = (win as Record<string, any>)[STORYFREEZE_PREVIEW_STATE_GLOBAL];
    expect(state).toMatchObject({
      status: 'ready',
      options: { fullPage: true, variants: { nested: {} } },
      runtime: {
        hasCustomReset: false,
        hasRuntimeWaitFor: false,
        runtimeWaitForVariants: ['nested'],
      },
    });
    expect(state.rootOptions).toBeUndefined();
  });

  it('marks named runtime wait hooks as unsafe for same-document capture', async () => {
    const win = installWindow();

    triggerScreenshot({ waitFor: 'fontLoading' }, { id: 'button--primary' });
    await finalizeScreenshot({ id: 'button--primary', abortSignal: new AbortController().signal });

    expect((win as Record<string, any>)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({
      status: 'ready',
      runtime: { hasRuntimeWaitFor: true },
    });
  });

  it('publishes a viewport from Storybook globals without adding a variant suffix', async () => {
    const win = installWindow({
      getBaseScreenshotOptions: vi.fn(async () =>
        createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] }),
      ),
    });

    triggerScreenshot(
      {},
      {
        id: 'button--primary',
        globals: { viewport: { value: 'desktop' } },
        parameters: {
          viewport: {
            options: { desktop: { styles: { width: '1280px', height: '720px' } } },
          },
        },
      },
    );
    await finalizeScreenshot({ id: 'button--primary', abortSignal: new AbortController().signal });

    expect((win as Record<string, any>)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({
      status: 'ready',
      options: {
        viewport: { width: 1280, height: 720 },
        variants: {},
        defaultVariantSuffix: '',
      },
    });
  });

  it('keeps the CLI viewport when Storybook globals cannot be resolved', async () => {
    const win = installWindow({
      getBaseScreenshotOptions: vi.fn(async () =>
        createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] }),
      ),
    });

    triggerScreenshot(
      {},
      {
        id: 'button--primary',
        globals: { viewport: { value: 'unknown' } },
        parameters: {
          viewport: {
            options: { desktop: { styles: { width: '1280px', height: '720px' } } },
          },
        },
      },
    );
    await finalizeScreenshot({ id: 'button--primary', abortSignal: new AbortController().signal });

    expect((win as Record<string, any>)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({
      status: 'ready',
      options: { viewport: '800x600', variants: {}, defaultVariantSuffix: '' },
    });
  });

  it('reports the preview visual commit result when diagnostics are exposed', async () => {
    const reportCaptureDiagnostic = vi.fn(async () => {});
    const win = installWindow({ reportCaptureDiagnostic });

    triggerScreenshot({}, { id: 'button--primary' });
    await finalizeScreenshot({ id: 'button--primary', abortSignal: new AbortController().signal });

    expect(reportCaptureDiagnostic).toHaveBeenCalledWith({
      type: 'visual-commit',
      didTimeout: false,
      elapsedMs: expect.any(Number),
      fontsStatus: 'unsupported',
      imageCount: 0,
      imageDecodeFailureCount: 0,
      requestId: '0-1',
      storyId: 'button--primary',
      usedAnimationFrameFallback: false,
      variantKey: [],
      visibilityState: 'visible',
    });
    expect((win as Record<string, any>)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({ status: 'ready' });
  });

  it('publishes a serialized error when user readiness fails', async () => {
    const win = installWindow();
    triggerScreenshot({ waitFor: async () => Promise.reject(new Error('wait failed')) }, { id: 'button--primary' });

    await expect(
      finalizeScreenshot({ id: 'button--primary', abortSignal: new AbortController().signal }),
    ).rejects.toThrow('wait failed');
    expect((win as Record<string, any>)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({
      status: 'error',
      error: { name: 'Error', message: 'wait failed' },
    });
  });
});
