import type { Browser, BrowserLaunchArgumentOptions, LaunchOptions, Metrics, Page } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  BaseBrowser,
  ChromiumNotFoundError,
  MetricsWatcher,
  findChrome,
  getDeviceDescriptors,
  type FindChromeOptions,
  type FindChromeResult,
} from './browser.js';

class TestBrowser extends BaseBrowser {
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
    const browser = new TestBrowser({
      chromiumPath: '/custom/chrome',
      chromiumChannel: 'stable',
      launchOptions: { args: ['--custom'], headless: true },
    });

    await browser.boot();

    expect(browser.locatedWith).toEqual({ executablePath: '/custom/chrome', channel: 'stable' });
    expect(browser.launchedWith).toMatchObject({
      args: ['--custom'],
      executablePath: '/test/chrome',
      headless: true,
    });
    expect(browser.executablePath).toBe('/test/chrome');
  });

  it('uses the legacy sandbox-safe defaults when launch options are omitted', async () => {
    const browser = new TestBrowser({});

    await browser.boot();

    expect(browser.launchedWith).toMatchObject({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: '/test/chrome',
      headless: true,
    });
  });

  it('throws the owned error when Chromium cannot be found', async () => {
    const browser = new TestBrowser({});
    browser.findResult = { executablePath: null, type: null };

    await expect(browser.boot()).rejects.toBeInstanceOf(ChromiumNotFoundError);
  });

  it('closes the page before the browser', async () => {
    const browser = new TestBrowser({});
    await browser.boot();

    await browser.close();

    expect(browser.closePage).toHaveBeenCalledTimes(1);
    expect(browser.closeBrowser).toHaveBeenCalledTimes(1);
    expect(browser.closePage.mock.invocationCallOrder[0]).toBeLessThan(
      browser.closeBrowser.mock.invocationCallOrder[0],
    );
  });

  it('closes a partially launched browser when page creation fails', async () => {
    const browser = new TestBrowser({});
    browser.newPageError = new Error('new page failed');

    await expect(browser.boot()).rejects.toThrow('new page failed');
    expect(browser.closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('still closes the browser when closing the page fails', async () => {
    const browser = new TestBrowser({});
    browser.closePage.mockRejectedValueOnce(new Error('page close failed'));
    await browser.boot();

    await expect(browser.close()).resolves.toBeUndefined();
    expect(browser.closeBrowser).toHaveBeenCalledTimes(1);
  });
});

describe(MetricsWatcher, () => {
  it('keeps the legacy three-sample stability threshold', async () => {
    const metrics = { Nodes: 1, RecalcStyleCount: 2, LayoutCount: 3 } as Metrics;
    const page = { metrics: vi.fn(async () => metrics) } as unknown as Page;

    await expect(new MetricsWatcher(page, 10).waitForStable()).resolves.toBe(3);
    expect(page.metrics).toHaveBeenCalledTimes(4);
  });

  it('returns the retry limit when metrics never become stable', async () => {
    let value = 0;
    const page = {
      metrics: vi.fn(async () => ({ Nodes: value++, RecalcStyleCount: 0, LayoutCount: 0 }) as Metrics),
    } as unknown as Page;

    await expect(new MetricsWatcher(page, 4).waitForStable()).resolves.toBe(4);
    expect(page.metrics).toHaveBeenCalledTimes(4);
  });
});

describe(getDeviceDescriptors, () => {
  it('returns Puppeteer 9 device descriptors', () => {
    expect(getDeviceDescriptors()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'iPhone 6' })]));
  });
});
