import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext, CDPSession, Page, Request } from 'playwright-core';
import { describe, expect, it, vi } from 'vite-plus/test';
import { ChromiumNotFoundError, type BrowserRequest } from './browser-backend.js';
import { PlaywrightBrowserBackend, PlaywrightCapturePage } from './playwright-browser-backend.js';

class FakePage extends EventEmitter {
  readonly bringToFront = vi.fn(async () => {});
  readonly setViewportSize = vi.fn(async () => {});
  readonly element = {
    click: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
  };
  readonly $ = vi.fn(async () => this.element);

  isClosed() {
    return false;
  }
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

function createTraceCollector() {
  const chunks: Buffer[] = [];
  return { chunks, sink: { write: vi.fn(async (chunk: Buffer) => void chunks.push(chunk)) } };
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

    await page.activate();
    expect(rawPage.bringToFront).toHaveBeenCalledTimes(1);

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
    expect(rawCdp.send.mock.calls).toEqual([['Performance.getMetrics']]);
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
      screenOrientation: { type: 'landscapePrimary', angle: 90 },
    });
    expect(rawCdp.send).toHaveBeenLastCalledWith('Emulation.setTouchEmulationEnabled', { enabled: false });
  });

  it('preserves derived viewport orientation during a tall full-page capture', async () => {
    const rawPage = {
      bringToFront: vi.fn(async () => {}),
      setViewportSize: vi.fn(async () => {}),
    } as unknown as Page;
    const rawCdp = new FakeCdp();
    rawCdp.send.mockImplementation(async method => {
      if (method === 'Page.getLayoutMetrics') return { contentSize: { width: 800, height: 1600 } };
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
      return {};
    });
    const page = new PlaywrightCapturePage(rawPage, rawCdp as unknown as CDPSession, { width: 800, height: 600 });

    await page.screenshot({ fullPage: true, captureBeyondViewport: false });

    expect(rawCdp.send).toHaveBeenNthCalledWith(2, 'Emulation.setDeviceMetricsOverride', {
      width: 800,
      height: 1600,
      deviceScaleFactor: 1,
      mobile: false,
      screenOrientation: { type: 'landscapePrimary', angle: 90 },
    });
  });

  it('preserves both screenshot and emulation cleanup failures', async () => {
    const rawPage = { setViewportSize: vi.fn(async () => {}) } as unknown as Page;
    const rawCdp = new FakeCdp();
    const captureError = new Error('capture failed');
    const cleanupError = new Error('background cleanup failed');
    rawCdp.send.mockImplementation(async (method, params) => {
      if (method === 'Page.captureScreenshot') throw captureError;
      if (method === 'Emulation.setDefaultBackgroundColorOverride' && params === undefined) throw cleanupError;
      return {};
    });
    const page = new PlaywrightCapturePage(rawPage, rawCdp as unknown as CDPSession);

    try {
      await page.screenshot({ omitBackground: true });
      throw new Error('Expected screenshot capture to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([captureError, cleanupError]);
    }
  });

  it('normalizes Chromium screenshots and records a Chromium trace through CDP', async () => {
    const png = Buffer.from('png');
    const rawPage = {
      bringToFront: vi.fn(async () => {}),
      setViewportSize: vi.fn(async () => {}),
    } as unknown as Page;
    const rawCdp = new FakeCdp();
    let failCapture = false;
    let readCount = 0;
    rawCdp.send.mockImplementation(async method => {
      if (method === 'Page.getLayoutMetrics') {
        return { contentSize: { x: 0, y: 0, width: 640.2, height: 960.1 } };
      }
      if (method === 'Page.captureScreenshot') {
        if (failCapture) throw new Error('capture failed');
        return { data: png.toString('base64') };
      }
      if (method === 'Tracing.end') {
        queueMicrotask(() => rawCdp.emit('Tracing.tracingComplete', { stream: 'trace-stream' }));
      }
      if (method === 'IO.read') {
        readCount += 1;
        return readCount === 1
          ? { data: '{"trace', eof: false }
          : { data: Buffer.from('Events":[]}').toString('base64'), base64Encoded: true, eof: true };
      }
      return {};
    });
    const page = new PlaywrightCapturePage(rawPage, rawCdp as unknown as CDPSession);

    await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 2, isMobile: true });
    await expect(
      page.screenshot({ fullPage: true, omitBackground: true, captureBeyondViewport: false }),
    ).resolves.toEqual(png);
    expect(rawPage.bringToFront).not.toHaveBeenCalled();
    expect(rawCdp.send).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 641, height: 961, scale: 1 },
      captureBeyondViewport: false,
    });
    expect(rawCdp.send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 641,
      height: 961,
      deviceScaleFactor: 2,
      mobile: true,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    expect(rawCdp.send).toHaveBeenLastCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      mobile: true,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    await page.screenshot({ clip: { x: 0.2, y: 0.8, width: 10.7, height: 20.4 } });
    expect(rawCdp.send).toHaveBeenLastCalledWith('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 1, width: 11, height: 20, scale: 1 },
      captureBeyondViewport: true,
    });
    await expect(page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: 1, height: 1 } })).rejects.toThrow(
      'exclusive',
    );
    failCapture = true;
    rawCdp.send.mockClear();
    await expect(
      page.screenshot({ fullPage: true, omitBackground: true, captureBeyondViewport: false }),
    ).rejects.toThrow('capture failed');
    expect(rawCdp.send.mock.calls).toEqual([
      ['Page.getLayoutMetrics'],
      [
        'Emulation.setDeviceMetricsOverride',
        {
          width: 641,
          height: 961,
          deviceScaleFactor: 2,
          mobile: true,
          screenOrientation: { type: 'portraitPrimary', angle: 0 },
        },
      ],
      ['Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }],
      [
        'Page.captureScreenshot',
        {
          format: 'png',
          clip: { x: 0, y: 0, width: 641, height: 961, scale: 1 },
          captureBeyondViewport: false,
        },
      ],
      ['Emulation.setDefaultBackgroundColorOverride'],
      [
        'Emulation.setDeviceMetricsOverride',
        {
          width: 375,
          height: 667,
          deviceScaleFactor: 2,
          mobile: true,
          screenOrientation: { type: 'portraitPrimary', angle: 0 },
        },
      ],
    ]);
    failCapture = false;
    rawCdp.send.mockClear();
    const { chunks, sink } = createTraceCollector();

    let releaseTraceStart = () => {};
    rawCdp.send.mockImplementationOnce(async () => new Promise<void>(resolve => (releaseTraceStart = resolve)));
    const startingTrace = page.startTrace(sink);
    await Promise.resolve();
    await expect(page.startTrace(sink)).rejects.toThrow('already running');
    releaseTraceStart();
    await startingTrace;
    await expect(page.stopTrace()).resolves.toBeUndefined();
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('{"traceEvents":[]}'));
    expect(rawCdp.send).toHaveBeenCalledWith('Tracing.start', {
      categories:
        '-*,devtools.timeline,v8.execute,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,toplevel,blink.console,blink.user_timing,latencyInfo,disabled-by-default-devtools.timeline.stack,disabled-by-default-v8.cpu_profiler,disabled-by-default-v8.cpu_profiler.hires',
      transferMode: 'ReturnAsStream',
    });
    expect(rawCdp.send).toHaveBeenCalledWith('IO.close', { handle: 'trace-stream' });
    rawCdp.send.mockRejectedValueOnce(new Error('trace start failed'));
    await expect(page.startTrace(sink)).rejects.toThrow('trace start failed');
    await page.startTrace(sink);
    rawCdp.send.mockRejectedValueOnce(new Error('trace end failed'));
    await expect(page.stopTrace()).rejects.toThrow('trace end failed');
    expect(rawCdp.listenerCount('Tracing.tracingComplete')).toBe(0);
    expect(page.isHealthy()).toBe(false);
    await expect(page.startTrace(sink)).rejects.toThrow('Close the browser');
  });

  it('closes a Chromium trace stream when reading fails', async () => {
    const rawCdp = new FakeCdp();
    rawCdp.send.mockImplementation(async method => {
      if (method === 'Tracing.end') {
        queueMicrotask(() => rawCdp.emit('Tracing.tracingComplete', { stream: 'trace-stream' }));
      }
      if (method === 'IO.read') throw new Error('trace read failed');
      return {};
    });
    const page = new PlaywrightCapturePage({} as Page, rawCdp as unknown as CDPSession);
    const { sink } = createTraceCollector();

    await page.startTrace(sink);
    await expect(page.stopTrace()).rejects.toThrow('trace read failed');
    expect(rawCdp.send).toHaveBeenCalledWith('IO.close', { handle: 'trace-stream' });
    await expect(page.startTrace(sink)).rejects.toThrow('Close the browser');
  });

  it('rejects a trace promptly when the CDP session closes', async () => {
    const rawCdp = new FakeCdp();
    rawCdp.send.mockImplementation(async method => {
      if (method === 'Tracing.end') queueMicrotask(() => rawCdp.emit('close'));
      return {};
    });
    const page = new PlaywrightCapturePage({} as Page, rawCdp as unknown as CDPSession);
    const { sink } = createTraceCollector();

    await page.startTrace(sink);
    await expect(page.stopTrace()).rejects.toThrow('CDP session closed');
    expect(page.isHealthy()).toBe(false);
    expect(rawCdp.listenerCount('Tracing.tracingComplete')).toBe(0);
    expect(rawCdp.listenerCount('close')).toBe(0);
  });

  it('consumes the trace completion rejection when Tracing.end also fails', async () => {
    const rawCdp = new FakeCdp();
    let rejectTraceEnd = (_error: Error) => {};
    rawCdp.send.mockImplementation(method =>
      method === 'Tracing.end'
        ? new Promise((_, reject) => {
            rejectTraceEnd = reject;
          })
        : Promise.resolve({}),
    );
    const page = new PlaywrightCapturePage({} as Page, rawCdp as unknown as CDPSession);
    const { sink } = createTraceCollector();

    await page.startTrace(sink);
    const stopping = page.stopTrace();
    await Promise.resolve();
    rawCdp.emit('close');
    rejectTraceEnd(new Error('trace end failed'));

    await expect(stopping).rejects.toThrow('trace end failed');
    expect(page.isHealthy()).toBe(false);
    expect(rawCdp.listenerCount('Tracing.tracingComplete')).toBe(0);
    expect(rawCdp.listenerCount('close')).toBe(0);
  });
});

describe(PlaywrightBrowserBackend, () => {
  it('prefers the managed Chromium, maps devices, and creates one context per session', async () => {
    const rawPage = new FakePage();
    const page = rawPage as unknown as Page;
    const rawCdp = new FakeCdp();
    rawCdp.send.mockRejectedValueOnce(new Error('timeDomain is unsupported'));
    const cdp = rawCdp as unknown as CDPSession;
    const closeContext = vi.fn(async () => {});
    const context = Object.assign(new EventEmitter(), {
      close: closeContext,
      newCDPSession: vi.fn(async () => cdp),
      newPage: vi.fn(async () => page),
    }) as unknown as BrowserContext;
    const closeBrowser = vi.fn(async () => {});
    const browser = Object.assign(new EventEmitter(), {
      close: closeBrowser,
      isConnected: vi.fn(() => true),
      newContext: vi.fn(async () => context),
    }) as unknown as Browser;
    const launch = vi.fn(async () => browser);
    const findChrome = vi.fn(async () => ({ executablePath: null, type: null }) as const);
    const backend = new PlaywrightBrowserBackend({
      canAccess: path => path === '/managed/chromium',
      findChrome,
      launch,
      managedExecutablePath: () => '/managed/chromium',
    });

    const instance = await backend.launch({ chromiumChannel: '*' });
    const session = await instance.newSession({
      viewport: {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    });
    const secondSession = await instance.newSession();
    expect(instance.isHealthy()).toBe(true);
    expect(session.isHealthy()).toBe(true);
    rawPage.emit('crash');
    expect(session.isHealthy()).toBe(false);
    await session.close();
    await secondSession.close();
    await instance.close();

    expect(launch).toHaveBeenCalledWith({ executablePath: '/managed/chromium', headless: true });
    expect(findChrome).not.toHaveBeenCalled();
    expect(vi.mocked(browser.newContext)).toHaveBeenNthCalledWith(1, {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    expect(vi.mocked(browser.newContext)).toHaveBeenNthCalledWith(2, { viewport: { width: 800, height: 600 } });
    expect(rawCdp.send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    expect(rawCdp.send).toHaveBeenCalledWith('Performance.enable', { timeDomain: 'threadTicks' });
    expect(rawCdp.send).toHaveBeenCalledWith('Performance.enable');
    expect(closeContext).toHaveBeenCalledTimes(2);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('closes a context when session creation fails', async () => {
    const closeContext = vi.fn(async () => {});
    const context = Object.assign(new EventEmitter(), {
      close: closeContext,
      newPage: vi.fn(async () => {
        throw new Error('page creation failed');
      }),
    }) as unknown as BrowserContext;
    const browser = Object.assign(new EventEmitter(), {
      close: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      newContext: vi.fn(async () => context),
    }) as unknown as Browser;
    const backend = new PlaywrightBrowserBackend({
      canAccess: () => true,
      findChrome: vi.fn(async () => ({ executablePath: null, type: null }) as const),
      launch: vi.fn(async () => browser),
      managedExecutablePath: () => '/managed/chromium',
    });

    const instance = await backend.launch({});

    await expect(instance.newSession()).rejects.toThrow('page creation failed');
    expect(closeContext).toHaveBeenCalledTimes(1);
  });

  it('honors an explicitly requested installed channel before managed Chromium', async () => {
    const launch = vi.fn(async () => ({ close: vi.fn() }) as unknown as Browser);
    const findChrome = vi.fn(async () => ({ executablePath: '/stable/chrome', type: 'stable' }) as const);
    const backend = new PlaywrightBrowserBackend({
      canAccess: () => true,
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

  it('falls back to system Canary and stable Chrome', async () => {
    const launch = vi.fn(async () => ({ close: vi.fn() }) as unknown as Browser);
    const findChrome = vi.fn(async ({ channel }: { channel?: string }) =>
      channel === 'stable'
        ? ({ executablePath: '/system/chrome', type: 'stable' } as const)
        : ({ executablePath: null, type: null } as const),
    );
    const backend = new PlaywrightBrowserBackend({
      canAccess: () => false,
      findChrome,
      launch,
      managedExecutablePath: () => '/missing/managed/chromium',
    });

    await backend.launch({ chromiumChannel: '*' });

    expect(findChrome.mock.calls.map(([options]) => options)).toEqual([{ channel: 'canary' }, { channel: 'stable' }]);
    expect(launch).toHaveBeenCalledWith({ executablePath: '/system/chrome', headless: true });
  });
});
