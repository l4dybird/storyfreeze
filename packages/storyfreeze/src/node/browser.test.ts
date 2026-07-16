import type { Browser, BrowserLaunchArgumentOptions, LaunchOptions, Page } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { BrowserMetrics, BrowserSession, CapturePage } from './browser-backend.js';
import { BaseBrowser, ChromiumNotFoundError, MetricsWatcher, getDeviceDescriptors } from './browser.js';
import type { BrowserSessionSource } from './browser-process-coordinator.js';
import { PuppeteerBrowserBackend } from './puppeteer-browser-backend.js';
import { findChrome, type FindChromeOptions, type FindChromeResult } from './chromium-resolver.js';

class TestBackend extends PuppeteerBrowserBackend {
  findResult: FindChromeResult = { executablePath: '/test/chrome', type: 'user' };
  locatedWith?: FindChromeOptions;
  launchedWith?: LaunchOptions & BrowserLaunchArgumentOptions;
  readonly closePage = vi.fn(async () => {});
  readonly closeBrowser = vi.fn(async () => {});
  readonly exposeFunction = vi.fn(async () => {});
  newPageError?: Error;

  protected async locateChrome(options: FindChromeOptions) {
    this.locatedWith = options;
    return this.findResult;
  }

  protected async launchBrowser(options: LaunchOptions & BrowserLaunchArgumentOptions) {
    this.launchedWith = options;
    return {
      newPage: async () => {
        if (this.newPageError) throw this.newPageError;
        return { close: this.closePage, exposeFunction: this.exposeFunction } as unknown as Page;
      },
      close: this.closeBrowser,
    } as unknown as Browser;
  }
}

function createBrowser(options: ConstructorParameters<typeof BaseBrowser>[0] = {}) {
  const backend = new TestBackend();
  return { backend, browser: new BaseBrowser(options, backend) };
}

describe(findChrome, () => {
  it('preserves a user-specified executable without requiring it to be installed locally', async () => {
    await expect(findChrome({ executablePath: '/custom/chrome', channel: 'canary' })).resolves.toEqual({
      executablePath: '/custom/chrome',
      type: 'user',
    });
  });
});

describe(BaseBrowser, () => {
  it('uses the explicit launch path and preserves caller launch options', async () => {
    const { backend, browser } = createBrowser({
      chromiumPath: '/custom/chrome',
      chromiumChannel: 'stable',
      launchOptions: { args: ['--custom'], headless: true },
    });

    await browser.boot();

    expect(backend.locatedWith).toEqual({ executablePath: '/custom/chrome', channel: 'stable' });
    expect(backend.launchedWith).toMatchObject({
      args: ['--custom'],
      executablePath: '/test/chrome',
      headless: true,
    });
    expect(browser.executablePath).toBe('/test/chrome');
  });

  it('keeps the Chromium sandbox enabled when launch options are omitted', async () => {
    const { backend, browser } = createBrowser();

    await browser.boot();

    expect(backend.launchedWith).toEqual({ executablePath: '/test/chrome', headless: true });
  });

  it('throws the owned error when Chromium cannot be found', async () => {
    const { backend, browser } = createBrowser();
    backend.findResult = { executablePath: null, type: null };

    await expect(browser.boot()).rejects.toBeInstanceOf(ChromiumNotFoundError);
  });

  it('closes the session before the browser instance', async () => {
    const { backend, browser } = createBrowser();
    await browser.boot();

    await browser.close();
    await browser.close();

    expect(backend.closePage).toHaveBeenCalledTimes(1);
    expect(backend.closeBrowser).toHaveBeenCalledTimes(1);
    expect(backend.closePage.mock.invocationCallOrder[0]).toBeLessThan(
      backend.closeBrowser.mock.invocationCallOrder[0],
    );
  });

  it('closes a partially launched browser when session creation fails', async () => {
    const { backend, browser } = createBrowser();
    backend.newPageError = new Error('new page failed');

    await expect(browser.boot()).rejects.toThrow('new page failed');
    expect(backend.closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('still closes the browser when closing the session fails', async () => {
    const { backend, browser } = createBrowser();
    backend.closePage.mockRejectedValueOnce(new Error('page close failed'));
    await browser.boot();

    await expect(browser.close()).resolves.toBeUndefined();
    expect(backend.closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('closes only its session when using a shared browser process', async () => {
    let current = true;
    const session = {
      close: vi.fn(async () => Promise.reject(new Error('context close failed'))),
      isHealthy: vi.fn(() => true),
      page: {},
    } as unknown as BrowserSession;
    const source = {
      close: vi.fn(async () => {}),
      isCurrent: vi.fn(() => current),
      openSession: vi.fn(async () => ({ executablePath: '/shared/chromium', generation: 7, session })),
    } satisfies BrowserSessionSource;
    const backend = new TestBackend();
    class SharedBrowser extends BaseBrowser {
      healthy() {
        return this.isSessionHealthy();
      }
    }
    const browser = new SharedBrowser({}, backend, {}, source);

    await browser.boot();
    expect(browser.executablePath).toBe('/shared/chromium');
    expect(browser.healthy()).toBe(true);
    current = false;
    expect(browser.healthy()).toBe(false);

    await expect(browser.close()).resolves.toBeUndefined();
    await browser.close();

    expect(source.openSession).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(source.close).not.toHaveBeenCalled();
    expect(backend.closeBrowser).not.toHaveBeenCalled();
  });
});

describe(MetricsWatcher, () => {
  it('keeps the legacy three-sample stability threshold', async () => {
    const metrics: BrowserMetrics = { nodes: 1, recalcStyleCount: 2, layoutCount: 3 };
    const page = { readMetrics: vi.fn(async () => metrics) } as Pick<CapturePage, 'readMetrics'>;

    await expect(new MetricsWatcher(page, 10).waitForStable()).resolves.toMatchObject({
      reason: 'stable',
      sampleCount: 3,
      stable: true,
    });
    expect(page.readMetrics).toHaveBeenCalledTimes(3);
  });

  it('returns the retry limit when metrics never become stable', async () => {
    let value = 0;
    const page = {
      readMetrics: vi.fn(async () => ({ nodes: value++, recalcStyleCount: 0, layoutCount: 0 })),
    };

    await expect(new MetricsWatcher(page, 4).waitForStable()).resolves.toMatchObject({
      reason: 'sample-limit',
      sampleCount: 4,
      stable: false,
    });
    expect(page.readMetrics).toHaveBeenCalledTimes(4);
  });

  it('includes the current sample and waits for the quiet window', async () => {
    vi.useFakeTimers();
    const values = [1, 1, 1, 2, 2, 2, 2, 2];
    const page = {
      readMetrics: vi.fn(async () => {
        const value = values.shift() ?? 2;
        return { nodes: value, recalcStyleCount: value, layoutCount: value };
      }),
    };

    try {
      const waiting = new MetricsWatcher(page, 10).waitForStable({ quietMs: 50, timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(200);
      const result = await waiting;
      expect(result).toMatchObject({ reason: 'stable', stable: true });
      expect(result.sampleCount).toBeGreaterThan(4);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(50);
      expect(result.samples).toEqual([
        { nodes: 2, recalcStyleCount: 2, layoutCount: 2 },
        { nodes: 2, recalcStyleCount: 2, layoutCount: 2 },
        { nodes: 2, recalcStyleCount: 2, layoutCount: 2 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat incomplete samples as stable and bounds a stalled metrics read', async () => {
    const incomplete = { readMetrics: vi.fn(async () => ({ nodes: undefined })) };
    await expect(new MetricsWatcher(incomplete, 3).waitForStable()).resolves.toMatchObject({
      incompleteSampleCount: 3,
      reason: 'sample-limit',
      stable: false,
    });

    const stalled = { readMetrics: vi.fn(() => new Promise<BrowserMetrics>(() => {})) };
    await expect(new MetricsWatcher(stalled, 100).waitForStable({ timeoutMs: 20 })).resolves.toMatchObject({
      reason: 'wall-timeout',
      sampleCount: 0,
      stable: false,
    });

    const controller = new AbortController();
    const aborted = new MetricsWatcher(stalled, 100).waitForStable({ timeoutMs: 1000, signal: controller.signal });
    controller.abort(new Error('interrupted'));
    await expect(aborted).rejects.toThrow('interrupted');
  });
});

describe(getDeviceDescriptors, () => {
  it('returns the fixed StoryFreeze device registry', () => {
    const devices = getDeviceDescriptors();
    expect(devices).toHaveLength(77);
    expect(new Set(devices.map(device => device.name))).toHaveProperty('size', 77);
    expect(
      devices.every(
        device =>
          device.viewport.width > 0 && device.viewport.height > 0 && (device.viewport.deviceScaleFactor ?? 1) > 0,
      ),
    ).toBe(true);
    expect(devices).toEqual(
      expect.arrayContaining([
        {
          name: 'iPhone 6',
          viewport: {
            width: 375,
            height: 667,
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
            isLandscape: false,
          },
        },
        {
          name: 'iPhone 6 landscape',
          viewport: {
            width: 667,
            height: 375,
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
            isLandscape: true,
          },
        },
        expect.objectContaining({ name: 'iPad' }),
      ]),
    );
  });
});
