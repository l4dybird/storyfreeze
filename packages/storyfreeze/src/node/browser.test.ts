import { describe, expect, it, vi } from 'vite-plus/test';
import fs from 'node:fs';
import type {
  BrowserBackend,
  BrowserInstance,
  BrowserLaunchOptions,
  BrowserMetrics,
  BrowserRuntimeOptions,
  BrowserSession,
  CapturePage,
} from './browser-backend.js';
import { BaseBrowser, ChromiumNotFoundError, MetricsWatcher, getDeviceDescriptors } from './browser.js';
import type { BrowserSessionSource } from './browser-process-coordinator.js';
import { findChrome, type FindChromeOptions, type FindChromeResult } from './chromium-resolver.js';

class TestBackend implements BrowserBackend {
  readonly name = 'playwright';
  findResult: FindChromeResult = { executablePath: '/test/chrome', type: 'user' };
  locatedWith?: FindChromeOptions;
  launchedWith?: BrowserLaunchOptions;
  readonly closePage = vi.fn(async () => {});
  readonly closeBrowser = vi.fn(async () => {});
  readonly activate = vi.fn(async () => {});
  readonly exposeFunction = vi.fn(async (_name: string, fn: () => void) => {
    this.nextStep = fn;
  });
  nextStep?: () => void;
  launchCount = 0;
  newSessionCount = 0;
  newPageError?: Error;

  async launch(options: BrowserRuntimeOptions): Promise<BrowserInstance> {
    this.launchCount += 1;
    this.locatedWith = { executablePath: options.chromiumPath, channel: options.chromiumChannel };
    if (!this.findResult.executablePath) throw new ChromiumNotFoundError();
    this.launchedWith = {
      ...options.launchOptions,
      executablePath: this.findResult.executablePath,
      headless: options.launchOptions?.headless ?? true,
    };
    return {
      executablePath: this.findResult.executablePath,
      close: this.closeBrowser,
      isHealthy: () => true,
      newSession: async () => {
        this.newSessionCount += 1;
        if (this.newPageError) throw this.newPageError;
        return {
          close: this.closePage,
          isHealthy: () => true,
          page: { activate: this.activate, exposeFunction: this.exposeFunction } as unknown as CapturePage,
        };
      },
    };
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
  it('reports direct browser launches when diagnostics are enabled', async () => {
    vi.stubEnv('STORYFREEZE_CAPTURE_DIAGNOSTICS', '1');
    const write = vi.spyOn(fs, 'write').mockImplementation(((...args: unknown[]) => {
      const callback = args.find(value => typeof value === 'function') as (() => void) | undefined;
      callback?.();
    }) as never);
    const { browser } = createBrowser();

    try {
      await browser.boot();

      expect(write).toHaveBeenCalledWith(
        process.stdout.fd,
        expect.stringContaining('"type":"browser-launch"'),
        expect.any(Function),
      );
      expect(write).toHaveBeenCalledWith(
        process.stdout.fd,
        expect.stringContaining('"source":"direct"'),
        expect.any(Function),
      );
    } finally {
      await browser.close();
      write.mockRestore();
      vi.unstubAllEnvs();
    }
  });

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

  it('activates a headed page before waiting for debug input', async () => {
    class DebugBrowser extends BaseBrowser {
      waitForNextStep() {
        return this.waitForDebugInput();
      }
    }
    const backend = new TestBackend();
    const browser = new DebugBrowser({ launchOptions: { headless: false } }, backend);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await browser.boot();
      const waiting = browser.waitForNextStep();
      await vi.waitFor(() => expect(backend.activate).toHaveBeenCalledTimes(1));
      backend.nextStep?.();
      await waiting;
    } finally {
      await browser.close();
      log.mockRestore();
    }
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

  it('shares concurrent boot and close operations without leaking resources', async () => {
    const { backend, browser } = createBrowser();

    const [first, second] = await Promise.all([browser.boot(), browser.boot()]);
    expect(first).toBe(browser);
    expect(second).toBe(browser);
    expect(backend.launchCount).toBe(1);
    expect(backend.newSessionCount).toBe(1);

    const firstClose = browser.close();
    const secondClose = browser.close();
    expect(secondClose).toBe(firstClose);
    await Promise.all([firstClose, secondClose]);
    expect(backend.closePage).toHaveBeenCalledTimes(1);
    expect(backend.closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('can boot a fresh generation after close completes', async () => {
    const { backend, browser } = createBrowser();
    await browser.boot();
    await browser.close();
    await browser.boot();

    expect(backend.launchCount).toBe(2);
    expect(backend.newSessionCount).toBe(2);
    await browser.close();
  });

  it('waits for an in-flight close before booting the next generation', async () => {
    const { backend, browser } = createBrowser();
    await browser.boot();
    let releaseClose = () => {};
    backend.closePage.mockImplementationOnce(() => new Promise<void>(resolve => (releaseClose = resolve)));

    const closing = browser.close();
    const booting = browser.boot();
    await Promise.resolve();
    expect(backend.launchCount).toBe(1);
    releaseClose();
    await closing;
    await booting;

    expect(backend.launchCount).toBe(2);
    await browser.close();
  });

  it('does not wait for a shared session that opens after close supersedes its boot', async () => {
    const session = {
      close: vi.fn(async () => {}),
      isHealthy: vi.fn(() => true),
      page: {},
    } as unknown as BrowserSession;
    let resolveSession!: (lease: { executablePath: string; generation: number; session: BrowserSession }) => void;
    const source = {
      close: vi.fn(async () => {}),
      isCurrent: vi.fn(() => true),
      openSession: vi.fn(
        () =>
          new Promise<{ executablePath: string; generation: number; session: BrowserSession }>(resolve => {
            resolveSession = resolve;
          }),
      ),
    } satisfies BrowserSessionSource;
    const browser = new BaseBrowser({}, new TestBackend(), {}, source);

    const booting = browser.boot();
    await vi.waitFor(() => expect(source.openSession).toHaveBeenCalledOnce());

    await expect(browser.close()).resolves.toBeUndefined();
    resolveSession({ executablePath: '/shared/chromium', generation: 1, session });

    await expect(booting).rejects.toThrow('Browser boot was superseded by a close request.');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('closes a partially launched browser when session creation fails', async () => {
    const { backend, browser } = createBrowser();
    backend.newPageError = new Error('new page failed');

    await expect(browser.boot()).rejects.toThrow('new page failed');
    expect(backend.closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('closes a direct browser whose session creation never settles on its own', async () => {
    const { backend, browser } = createBrowser();
    let rejectSession = (_error: Error) => {};
    const sessionOpening = new Promise<BrowserSession>((_resolve, reject) => {
      rejectSession = reject;
    });
    const closeBrowser = vi.fn(async () => rejectSession(new Error('browser closed during session creation')));
    const newSession = vi.fn(() => sessionOpening);
    vi.spyOn(backend, 'launch').mockResolvedValue({
      executablePath: '/test/chrome',
      close: closeBrowser,
      isHealthy: () => true,
      newSession,
    });

    const booting = browser.boot();
    await vi.waitFor(() => expect(newSession).toHaveBeenCalledOnce());

    await expect(browser.close()).resolves.toBeUndefined();
    await expect(booting).rejects.toThrow('browser closed during session creation');
    expect(closeBrowser).toHaveBeenCalledOnce();
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
