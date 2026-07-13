import { EventEmitter } from 'node:events';
import type { Browser, HTTPRequest, Page } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vite-plus/test';
import { PuppeteerBrowserBackend, PuppeteerCapturePage } from './puppeteer-browser-backend.js';

describe(PuppeteerCapturePage, () => {
  it('keeps request identity across start and completion events', () => {
    const rawPage = new EventEmitter() as unknown as Page;
    const page = new PuppeteerCapturePage(rawPage);
    const started = vi.fn();
    const finished = vi.fn();
    const unsubscribe = page.subscribeRequests({ started, finished });
    const request = {
      method: () => 'GET',
      resourceType: () => 'image',
      url: () => 'https://example.test/image.png',
    } as HTTPRequest;

    (rawPage as unknown as EventEmitter).emit('request', request);
    (rawPage as unknown as EventEmitter).emit('requestfinished', request);

    expect(started).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith(started.mock.calls[0][0]);
    unsubscribe();
    expect((rawPage as unknown as EventEmitter).listenerCount('request')).toBe(0);
  });

  it('normalizes metrics and preserves screenshot options and buffers', async () => {
    const screenshot = vi.fn(async () => Buffer.from('png'));
    const rawPage = {
      metrics: vi.fn(async () => ({ Nodes: 1, RecalcStyleCount: 2, LayoutCount: 3 })),
      screenshot,
    } as unknown as Page;
    const page = new PuppeteerCapturePage(rawPage);
    const options = {
      captureBeyondViewport: true,
      fullPage: true,
      omitBackground: false,
    };

    await expect(page.readMetrics()).resolves.toEqual({ nodes: 1, recalcStyleCount: 2, layoutCount: 3 });
    await expect(page.screenshot(options)).resolves.toEqual(Buffer.from('png'));
    expect(screenshot).toHaveBeenCalledWith(options);
  });

  it('delegates Chromium trace start and stop while guarding concurrent and failed states', async () => {
    const trace = Buffer.from('trace');
    let releaseTraceStart = () => {};
    const start = vi.fn(async () => new Promise<void>(resolve => (releaseTraceStart = resolve)));
    const stop = vi.fn(async () => trace);
    const page = new PuppeteerCapturePage({ tracing: { start, stop } } as unknown as Page);

    const startingTrace = page.startTrace();
    await Promise.resolve();
    await expect(page.startTrace()).rejects.toThrow('already running');
    releaseTraceStart();
    await startingTrace;
    await expect(page.stopTrace()).resolves.toBe(trace);
    await expect(page.stopTrace()).rejects.toThrow('has not been started');
    start.mockImplementation(async () => {});
    start.mockRejectedValueOnce(new Error('trace start failed'));
    await expect(page.startTrace()).rejects.toThrow('trace start failed');
    await page.startTrace();
    stop.mockRejectedValueOnce(new Error('trace stop failed'));
    await expect(page.stopTrace()).rejects.toThrow('trace stop failed');
    await expect(page.startTrace()).rejects.toThrow('Close the browser');
    expect(start).toHaveBeenCalledTimes(3);
  });
});

describe(PuppeteerBrowserBackend, () => {
  it('reports whether its browser process is connected', async () => {
    let connected = true;
    const browser = {
      close: vi.fn(async () => {}),
      isConnected: vi.fn(() => connected),
    } as unknown as Browser;
    class TestBackend extends PuppeteerBrowserBackend {
      protected override locateChrome() {
        return Promise.resolve({ executablePath: '/chromium', type: 'user' } as const);
      }

      protected override launchBrowser() {
        return Promise.resolve(browser);
      }
    }

    const instance = await new TestBackend().launch({});

    expect(instance.isHealthy()).toBe(true);
    connected = false;
    expect(instance.isHealthy()).toBe(false);
  });
});
