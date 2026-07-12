import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext, CDPSession, Page, Request } from 'playwright-core';
import { describe, expect, it, vi } from 'vite-plus/test';
import { ChromiumNotFoundError, type BrowserRequest } from './browser-backend.js';
import { PlaywrightBrowserBackend, PlaywrightCapturePage } from './playwright-browser-backend.js';

class FakePage extends EventEmitter {
  readonly element = {
    click: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
  };
  readonly $ = vi.fn(async () => this.element);
}

class FakeCdp extends EventEmitter {
  readonly send = vi.fn(async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({}));
}

function request(url = 'https://example.test/image.png') {
  return {
    method: () => 'GET',
    resourceType: () => 'image',
    url: () => url,
  } as Request;
}

describe(PlaywrightCapturePage, () => {
  it('normalizes browser events, performs immediate element interactions, and removes listeners', async () => {
    const rawPage = new FakePage();
    const page = new PlaywrightCapturePage(rawPage as unknown as Page, new FakeCdp() as unknown as CDPSession);
    const started = vi.fn((_request: BrowserRequest) => {});
    const finished = vi.fn((_request: BrowserRequest) => {});
    const consoleListener = vi.fn();
    const unsubscribeRequests = page.subscribeRequests({ started, finished });
    const unsubscribeConsole = page.subscribeConsole(consoleListener);
    const rawRequest = request();

    rawPage.emit('request', rawRequest);
    rawPage.emit('requestfinished', rawRequest);
    rawPage.emit('console', { text: () => 'hello', type: () => 'warning' });

    expect(finished).toHaveBeenCalledWith(started.mock.calls[0][0]);
    expect(consoleListener).toHaveBeenCalledWith({ text: 'hello', type: 'warning' });
    await page.click('#target');
    await page.focus('#target');
    await page.hover('#target');
    expect(rawPage.element.click).toHaveBeenCalledTimes(1);
    expect(rawPage.element.focus).toHaveBeenCalledTimes(1);
    expect(rawPage.element.hover).toHaveBeenCalledTimes(1);
    rawPage.$.mockImplementationOnce(async () => null as never);
    await expect(page.click('#missing')).rejects.toThrow('No element found for selector: #missing');

    unsubscribeRequests();
    unsubscribeConsole();
    expect(rawPage.listenerCount('request')).toBe(0);
    expect(rawPage.listenerCount('requestfinished')).toBe(0);
    expect(rawPage.listenerCount('requestfailed')).toBe(0);
    expect(rawPage.listenerCount('console')).toBe(0);
  });

  it('reads Chromium metrics and applies viewport, scale, mobile, and touch emulation', async () => {
    const setViewportSize = vi.fn(async () => {});
    const rawPage = { setViewportSize } as unknown as Page;
    const rawCdp = new FakeCdp();
    rawCdp.send.mockImplementation(async method => {
      if (method === 'Performance.getMetrics') {
        return {
          metrics: [
            { name: 'Nodes', value: 10 },
            { name: 'RecalcStyleCount', value: 20 },
            { name: 'LayoutCount', value: 30 },
          ],
        };
      }
      return {};
    });
    const page = new PlaywrightCapturePage(rawPage, rawCdp as unknown as CDPSession);

    await expect(page.readMetrics()).resolves.toEqual({ nodes: 10, recalcStyleCount: 20, layoutCount: 30 });
    await page.setViewport({
      width: 640,
      height: 360,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      isLandscape: true,
    });

    expect(setViewportSize).toHaveBeenCalledWith({ width: 640, height: 360 });
    expect(rawCdp.send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 640,
      height: 360,
      deviceScaleFactor: 2,
      mobile: true,
      screenOrientation: { type: 'landscapePrimary', angle: 90 },
    });
    expect(rawCdp.send).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1,
    });
    await page.setViewport({ width: 800, height: 600 });
    expect(rawCdp.send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    expect(rawCdp.send).toHaveBeenLastCalledWith('Emulation.setTouchEmulationEnabled', { enabled: false });
  });

  it('returns PNG bytes and records a Chromium trace through CDP', async () => {
    const png = Buffer.from('png');
    const rawPage = { bringToFront: vi.fn(async () => {}) } as unknown as Page;
    const rawCdp = new FakeCdp();
    rawCdp.send.mockImplementation(async method => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssContentSize: { x: 0, y: 0, width: 640, height: 960 } };
      }
      if (method === 'Page.captureScreenshot') return { data: png.toString('base64') };
      if (method === 'Tracing.end') {
        queueMicrotask(() => rawCdp.emit('Tracing.tracingComplete', { stream: 'trace-stream' }));
      }
      if (method === 'IO.read') return { data: '{"traceEvents":[]}', eof: true };
      return {};
    });
    const page = new PlaywrightCapturePage(rawPage, rawCdp as unknown as CDPSession);

    await expect(
      page.screenshot({ fullPage: true, omitBackground: true, captureBeyondViewport: true }),
    ).resolves.toEqual(png);
    expect(rawCdp.send).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 640, height: 960, scale: 1 },
      captureBeyondViewport: true,
    });

    await page.startTrace();
    await expect(page.startTrace()).rejects.toThrow('already running');
    await expect(page.stopTrace()).resolves.toEqual(Buffer.from('{"traceEvents":[]}'));
    expect(rawCdp.send).toHaveBeenCalledWith(
      'Tracing.start',
      expect.objectContaining({ transferMode: 'ReturnAsStream' }),
    );
    expect(rawCdp.send).toHaveBeenCalledWith('IO.close', { handle: 'trace-stream' });
  });
});

describe(PlaywrightBrowserBackend, () => {
  it('prefers the managed Chromium, maps devices, and creates one context per session', async () => {
    const page = {} as Page;
    const cdp = new FakeCdp() as unknown as CDPSession;
    const closeContext = vi.fn(async () => {});
    const context = {
      close: closeContext,
      newCDPSession: vi.fn(async () => cdp),
      newPage: vi.fn(async () => page),
    } as unknown as BrowserContext;
    const closeBrowser = vi.fn(async () => {});
    const browser = {
      close: closeBrowser,
      newContext: vi.fn(async () => context),
    } as unknown as Browser;
    const launch = vi.fn(async () => browser);
    const findChrome = vi.fn(async () => ({ executablePath: null, type: null }) as const);
    const backend = new PlaywrightBrowserBackend({
      canAccess: path => path === '/managed/chromium',
      deviceDescriptors: {
        'Test Phone': {
          viewport: { width: 320, height: 640 },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
        },
      } as never,
      findChrome,
      launch,
      managedExecutablePath: () => '/managed/chromium',
    });

    const instance = await backend.launch({ chromiumChannel: '*' });
    const session = await instance.newSession();
    await session.close();
    await instance.close();

    expect(launch).toHaveBeenCalledWith({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: '/managed/chromium',
      headless: true,
    });
    expect(findChrome).not.toHaveBeenCalled();
    expect(vi.mocked(browser.newContext)).toHaveBeenCalledWith({ viewport: { width: 800, height: 600 } });
    expect(closeContext).toHaveBeenCalledTimes(1);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
    expect(backend.devices()).toEqual([
      {
        name: 'Test Phone',
        viewport: {
          width: 320,
          height: 640,
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
        },
      },
    ]);
  });

  it('honors an explicitly requested installed channel before managed Chromium', async () => {
    const launch = vi.fn(async () => ({ close: vi.fn() }) as unknown as Browser);
    const findChrome = vi.fn(async () => ({ executablePath: '/stable/chrome', type: 'stable' }) as const);
    const backend = new PlaywrightBrowserBackend({
      canAccess: () => true,
      deviceDescriptors: {} as never,
      findChrome,
      launch,
      managedExecutablePath: () => '/managed/chromium',
    });

    await backend.launch({
      chromiumChannel: 'stable',
      launchOptions: { args: ['--custom'], headless: true, slowMo: 100 },
    });

    expect(findChrome).toHaveBeenCalledWith({ channel: 'stable' });
    expect(launch).toHaveBeenCalledWith({
      args: ['--custom'],
      executablePath: '/stable/chrome',
      headless: true,
    });

    findChrome.mockResolvedValueOnce({ executablePath: null, type: null });
    await expect(backend.launch({ chromiumChannel: 'stable' })).rejects.toBeInstanceOf(ChromiumNotFoundError);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('falls back to system Canary and stable Chrome without using a Puppeteer-managed browser', async () => {
    const launch = vi.fn(async () => ({ close: vi.fn() }) as unknown as Browser);
    const findChrome = vi.fn(async ({ channel }: { channel?: string }) =>
      channel === 'stable'
        ? ({ executablePath: '/system/chrome', type: 'stable' } as const)
        : ({ executablePath: null, type: null } as const),
    );
    const backend = new PlaywrightBrowserBackend({
      canAccess: () => false,
      deviceDescriptors: {} as never,
      findChrome,
      launch,
      managedExecutablePath: () => '/missing/managed/chromium',
    });

    await backend.launch({ chromiumChannel: '*' });

    expect(findChrome.mock.calls.map(([options]) => options)).toEqual([{ channel: 'canary' }, { channel: 'stable' }]);
    expect(launch).toHaveBeenCalledWith({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: '/system/chrome',
      headless: true,
    });
  });
});
