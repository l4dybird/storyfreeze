import type { Browser, BrowserLaunchArgumentOptions, LaunchOptions, Page } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { BrowserMetrics, CapturePage } from './browser-backend.js';
import {
  BaseBrowser,
  ChromiumNotFoundError,
  MetricsWatcher,
  PuppeteerBrowserBackend,
  findChrome,
  getDeviceDescriptors,
  type FindChromeOptions,
  type FindChromeResult,
} from './browser.js';

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

  it('uses the legacy sandbox-safe defaults when launch options are omitted', async () => {
    const { backend, browser } = createBrowser();

    await browser.boot();

    expect(backend.launchedWith).toMatchObject({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: '/test/chrome',
      headless: true,
    });
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
});

describe(MetricsWatcher, () => {
  it('keeps the legacy three-sample stability threshold', async () => {
    const metrics: BrowserMetrics = { nodes: 1, recalcStyleCount: 2, layoutCount: 3 };
    const page = { readMetrics: vi.fn(async () => metrics) } as Pick<CapturePage, 'readMetrics'>;

    await expect(new MetricsWatcher(page, 10).waitForStable()).resolves.toBe(3);
    expect(page.readMetrics).toHaveBeenCalledTimes(4);
  });

  it('returns the retry limit when metrics never become stable', async () => {
    let value = 0;
    const page = {
      readMetrics: vi.fn(async () => ({ nodes: value++, recalcStyleCount: 0, layoutCount: 0 })),
    };

    await expect(new MetricsWatcher(page, 4).waitForStable()).resolves.toBe(4);
    expect(page.readMetrics).toHaveBeenCalledTimes(4);
  });
});

describe(getDeviceDescriptors, () => {
  it('returns Puppeteer 9 device descriptors', () => {
    expect(getDeviceDescriptors()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'iPhone 6' })]));
  });
});
