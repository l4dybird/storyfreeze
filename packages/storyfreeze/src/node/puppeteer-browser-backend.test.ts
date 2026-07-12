import { EventEmitter } from 'node:events';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vite-plus/test';
import { PuppeteerCapturePage } from './puppeteer-browser-backend.js';

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

  it('delegates Chromium trace start and stop without changing the buffer', async () => {
    const trace = Buffer.from('trace');
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => trace);
    const page = new PuppeteerCapturePage({ tracing: { start, stop } } as unknown as Page);

    await page.startTrace();
    await expect(page.stopTrace()).resolves.toBe(trace);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
