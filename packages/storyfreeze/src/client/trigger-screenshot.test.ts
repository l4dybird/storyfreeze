import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { STORYFREEZE_PREVIEW_STATE_GLOBAL } from '../shared/preview-protocol.js';
import { finalizeScreenshot, triggerScreenshot } from './trigger-screenshot.js';

describe(finalizeScreenshot, () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

  function installWindow(overrides: Record<string, unknown> = {}) {
    const win = {
      getBaseScreenshotOptions: vi.fn(async () => ({})),
      getCurrentVariantKey: vi.fn(async () => ({ isDefault: true, keys: [] })),
      waitBrowserMetricsStable: vi.fn(async () => {}),
      requestIdleCallback: (callback: Function) => callback(),
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

    expect((win as Record<string, any>)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({
      status: 'ready',
      options: { fullPage: true, variants: { nested: {} } },
    });
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
