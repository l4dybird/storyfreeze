import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { STORYFREEZE_PREVIEW_STATE_GLOBAL } from '../shared/preview-protocol.js';
import { createBaseScreenshotOptions } from '../shared/screenshot-options-helper.js';
import { finalizeScreenshot, triggerScreenshot } from './trigger-screenshot.js';

describe(finalizeScreenshot, () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

  function installWindow(overrides: Record<string, unknown> = {}) {
    const win = {
      getBaseScreenshotOptions: vi.fn(async () => ({})),
      getCurrentVariantKey: vi.fn(async () => ({ isDefault: true, keys: [] })),
      ...overrides,
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { href: 'https://example.test/iframe.html?id=button--primary&storyfreezeRequestId=0-1' },
    });
    return win;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  });

  it('publishes JSON-safe ready options after render/play and user readiness', async () => {
    const waitFor = vi.fn(async () => {});
    const win = installWindow();
    triggerScreenshot(
      { fullPage: true, waitFor, variants: { nested: { waitFor: async () => {} } } },
      { id: 'button--primary' },
    );

    await finalizeScreenshot({ id: 'button--primary', abortSignal: new AbortController().signal });

    expect(waitFor).toHaveBeenCalledOnce();
    expect((win as Record<string, any>)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({
      status: 'ready',
      options: { fullPage: true, variants: { nested: {} } },
    });
  });

  it('registers the merged reset hook and clears it on the next render', async () => {
    const win = installWindow();
    const reset = vi.fn(async () => {});
    triggerScreenshot({ reset }, { id: 'button--primary' });
    triggerScreenshot({ fullPage: true }, { id: 'button--primary' });
    await finalizeScreenshot({ id: 'button--primary' });
    expect((win as Record<string, any>).__STORYFREEZE_CAPTURE_RESET__).toEqual({
      storyId: 'button--primary',
      reset,
    });

    triggerScreenshot({ fullPage: false }, { id: 'button--primary' });
    await finalizeScreenshot({ id: 'button--primary' });
    expect((win as Record<string, any>).__STORYFREEZE_CAPTURE_RESET__).toEqual({ storyId: 'button--primary' });
  });

  it('stops a long delay without publishing stale ready state when Storybook aborts', async () => {
    const win = installWindow();
    const controller = new AbortController();
    triggerScreenshot({ delay: 60_000 }, { id: 'button--primary' });
    const finalizing = finalizeScreenshot({ id: 'button--primary', abortSignal: controller.signal });
    await vi.waitFor(() => expect(win.getCurrentVariantKey).toHaveBeenCalledOnce());
    controller.abort();
    await finalizing;
    expect((win as Record<string, any>)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({ status: 'booting' });
  });

  it('publishes a viewport resolved from Storybook globals without a suffix', async () => {
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
        parameters: { viewport: { options: { desktop: { styles: { width: '1280px', height: '720px' } } } } },
      },
    );
    await finalizeScreenshot({ id: 'button--primary' });
    expect((win as Record<string, any>)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({
      status: 'ready',
      options: { viewport: { width: 1280, height: 720 }, defaultVariantSuffix: '' },
    });
  });

  it('publishes a serialized render error when user readiness fails', async () => {
    const win = installWindow();
    triggerScreenshot({ waitFor: async () => Promise.reject(new Error('wait failed')) }, { id: 'button--primary' });
    await expect(finalizeScreenshot({ id: 'button--primary' })).rejects.toThrow('wait failed');
    expect((win as Record<string, any>)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({
      status: 'error',
      error: { name: 'Error', message: 'wait failed' },
    });
  });
});
