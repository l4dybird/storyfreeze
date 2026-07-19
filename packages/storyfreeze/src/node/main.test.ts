import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import fs from 'node:fs';
import { BaseBrowser } from './browser.js';
import { CapturingBrowser, resolveViewport } from './capturing-browser.js';
import { shouldRecycleContext, shouldRecoverPlaywrightWorker, shouldWaitForVisualCommit } from './capture-policy.js';
import { Logger } from './logger.js';
import { ManagedStorybookConnection } from './managed-storybook-connection.js';
import type { MainOptions } from './types.js';
import { bootCaptureWorkers, disposeRuntimeResources, filterStories, main } from './main.js';
import type { StoryDescriptor } from './story-index-provider.js';
import { CAPTURE_DIAGNOSTIC_PREFIX } from './capture-diagnostics.js';
import { CaptureAttemptTimeoutError, PreviewReadyTimeoutError } from './errors.js';
import { CaptureDeadline } from './capture-deadline.js';
import { StoryNavigator } from './story-navigator.js';
import { createBaseScreenshotOptions } from '../shared/screenshot-options-helper.js';

function completeStdoutWrite(...args: unknown[]) {
  const callback = args.find(value => typeof value === 'function') as (() => void) | undefined;
  callback?.();
  return true;
}

function story(id: string, title: string, name: string): StoryDescriptor {
  return { id, title, name };
}

describe(filterStories, () => {
  const stories = [
    story('button--primary', 'Button', 'Primary'),
    story('button--secondary', 'Button', 'Secondary'),
    story('form-input--default', 'Form/Input', 'Default'),
  ];

  it('preserves enumeration order when no filters are specified', () => {
    expect(filterStories(stories, [], []).map(item => item.id)).toEqual([
      'button--primary',
      'button--secondary',
      'form-input--default',
    ]);
  });

  it('applies include before exclude using the title/story name', () => {
    expect(filterStories(stories, ['Button/**'], ['**/Secondary']).map(item => item.id)).toEqual(['button--primary']);
  });
});

describe(resolveViewport, () => {
  const devices = [{ name: 'Phone', viewport: { height: 800, width: 400, hasTouch: true, isMobile: true } }];

  it('resolves numeric, dimension, and registered device values', () => {
    expect(resolveViewport('1024', devices)).toEqual({ height: 600, width: 1024 });
    expect(resolveViewport('1024x768', devices)).toEqual({ height: 768, width: 1024 });
    expect(resolveViewport('Phone', devices)).toEqual({ height: 800, width: 400, hasTouch: true, isMobile: true });
  });

  it('preserves object values and rejects unknown devices', () => {
    const viewport = { height: 720, width: 1280 };
    expect(resolveViewport(viewport, devices)).toBe(viewport);
    expect(resolveViewport('Unknown', devices)).toBeUndefined();
  });
});

describe(shouldRecycleContext, () => {
  it('recycles only when an enabled count or age boundary is reached', () => {
    expect(shouldRecycleContext(undefined, 100, 100_000)).toBe(false);
    expect(shouldRecycleContext({ maxCapturesPerContext: 10, maxContextAgeMs: 60_000 }, 9, 59_999)).toBe(false);
    expect(shouldRecycleContext({ maxCapturesPerContext: 10, maxContextAgeMs: 60_000 }, 10, 1)).toBe(true);
    expect(shouldRecycleContext({ maxCapturesPerContext: 128 }, 127, 0)).toBe(false);
    expect(shouldRecycleContext({ maxCapturesPerContext: 128 }, 128, 0)).toBe(true);
    expect(shouldRecycleContext({ maxCapturesPerContext: 0 }, 100, 0)).toBe(false);
  });
});

describe(disposeRuntimeResources, () => {
  const logger = new Logger('silent');

  it('calls and awaits worker close before disconnecting', async () => {
    let releaseWorker = () => {};
    const worker = {
      close: vi.fn(() => new Promise<void>(resolve => (releaseWorker = resolve))),
    };
    const storiesBrowser = { close: vi.fn(async () => {}) };
    const browserProcess = { close: vi.fn(async () => {}) };
    const connection = { disconnect: vi.fn(async () => {}) };

    const disposing = disposeRuntimeResources(
      { workers: [worker], storiesBrowser, browserProcess, connection },
      logger,
    );
    await Promise.resolve();

    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(storiesBrowser.close).not.toHaveBeenCalled();
    expect(browserProcess.close).not.toHaveBeenCalled();
    expect(connection.disconnect).not.toHaveBeenCalled();

    releaseWorker();
    await disposing;

    expect(storiesBrowser.close).toHaveBeenCalledTimes(1);
    expect(browserProcess.close).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(storiesBrowser.close.mock.invocationCallOrder[0]).toBeLessThan(
      browserProcess.close.mock.invocationCallOrder[0],
    );
    expect(browserProcess.close.mock.invocationCallOrder[0]).toBeLessThan(
      connection.disconnect.mock.invocationCallOrder[0],
    );
  });

  it('continues cleanup when a close operation fails', async () => {
    const worker = { close: vi.fn(async () => Promise.reject(new Error('close failed'))) };
    const storiesBrowser = { close: vi.fn(async () => {}) };
    const connection = { disconnect: vi.fn(async () => {}) };

    await expect(disposeRuntimeResources({ workers: [worker], storiesBrowser, connection }, logger)).resolves.toBe(
      undefined,
    );
    expect(storiesBrowser.close).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it('continues cleanup when a close operation never settles', async () => {
    vi.useFakeTimers();
    try {
      const worker = { close: vi.fn(() => new Promise<void>(() => {})) };
      const storiesBrowser = { close: vi.fn(async () => {}) };
      const connection = { disconnect: vi.fn(async () => {}) };

      const disposing = disposeRuntimeResources({ workers: [worker], storiesBrowser, connection }, logger);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(disposing).resolves.toBeUndefined();
      expect(storiesBrowser.close).toHaveBeenCalledTimes(1);
      expect(connection.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe(bootCaptureWorkers, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function createWorker(boot: () => Promise<unknown>) {
    const worker = {
      boot: vi.fn(async () => {
        await boot();
        return worker;
      }),
      close: vi.fn(async () => {}),
    };
    return worker;
  }

  it('closes every worker without waiting for a hung peer when one boot fails', async () => {
    const failure = new Error('boot failed');
    const failedWorker = createWorker(async () => Promise.reject(failure));
    const lateWorker = createWorker(() => new Promise<void>(() => {}));

    const booting = bootCaptureWorkers([failedWorker, lateWorker]);

    await expect(booting).rejects.toBe(failure);
    expect(failedWorker.close).toHaveBeenCalledTimes(1);
    expect(lateWorker.close).toHaveBeenCalledTimes(1);
  });

  it('closes workers without waiting for a hung boot after an abort', async () => {
    const controller = new AbortController();
    const worker = createWorker(() => new Promise<void>(() => {}));

    const booting = bootCaptureWorkers([worker], controller.signal);
    controller.abort(new Error('interrupted by test'));

    await expect(booting).rejects.toThrow('interrupted by test');
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('bounds an initial worker boot that never settles', async () => {
    vi.useFakeTimers();
    try {
      const worker = createWorker(() => new Promise<void>(() => {}));
      const booting = bootCaptureWorkers([worker], undefined, [], 25);
      const rejection = expect(booting).rejects.toThrow('Capture worker boot did not settle within 25 msec');

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(worker.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start workers when the run is already aborted', async () => {
    const controller = new AbortController();
    const worker = createWorker(async () => {});
    controller.abort(new Error('already interrupted'));

    await expect(bootCaptureWorkers([worker], controller.signal)).rejects.toThrow('already interrupted');
    expect(worker.boot).not.toHaveBeenCalled();
  });

  it('records each concurrent worker boot independently', async () => {
    vi.stubEnv('STORYFREEZE_CAPTURE_DIAGNOSTICS', '1');
    const write = vi.spyOn(fs, 'write').mockImplementation(completeStdoutWrite as never);
    const workers = [createWorker(async () => {}), createWorker(async () => {})];

    await expect(bootCaptureWorkers(workers)).resolves.toEqual(workers);

    const completions = write.mock.calls
      .map(([, chunk]) => String(chunk))
      .filter(line => line.startsWith(CAPTURE_DIAGNOSTIC_PREFIX))
      .map(line => JSON.parse(line.slice(CAPTURE_DIAGNOSTIC_PREFIX.length)))
      .filter(
        event => event.type === 'runtime-phase' && event.phase === 'capture-worker-boot' && event.state === 'end',
      );
    expect(completions).toHaveLength(2);
    expect(completions.map(event => event.workerId).sort()).toEqual([0, 1]);
    expect(completions.every(event => typeof event.durationMs === 'number')).toBe(true);
  });
});

describe(CapturingBrowser, () => {
  const originalCaptureDiagnostics = process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCaptureDiagnostics === undefined) delete process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS;
    else process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS = originalCaptureDiagnostics;
  });

  function createStalledCapture(options: {
    captureTimeout: number;
    delay?: number;
    maxRetryCount: number;
    mode: 'managed' | 'simple';
    signal?: AbortSignal;
  }) {
    const order: string[] = [];
    let rejectReady = (_error: Error) => {};
    const mainOptions = {
      captureMaxRetryCount: options.maxRetryCount,
      captureTimeout: options.captureTimeout,
      delay: options.delay ?? 0,
      disableCssAnimation: false,
      disableWaitAssets: false,
      logger: new Logger('silent'),
      signal: options.signal,
      viewports: ['800x600'],
    } as MainOptions;
    const browser = new CapturingBrowser(
      { url: 'https://example.test' } as ManagedStorybookConnection,
      mainOptions,
      options.mode,
      0,
    );
    const unsubscribe = vi.fn();
    let currentUrl = 'about:blank';
    const page = {
      addStyleFile: vi.fn(async () => {}),
      currentUrl: vi.fn(() => currentUrl),
      evaluate: vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectReady = reject;
          }),
      ),
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
      }),
      subscribeConsole: vi.fn(() => unsubscribe),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    const navigator = new StoryNavigator(page as never, new URL('https://example.test'), 0);
    const navigate = vi.spyOn(navigator, 'navigate');
    const waitForReady = vi.spyOn(navigator, 'waitForReady');
    Object.assign(browser, {
      navigator,
      resourceWatcher: { clear: vi.fn() },
    });
    const close = vi.spyOn(browser, 'close').mockImplementation(async () => {
      order.push('close');
      rejectReady(new Error('session closed'));
    });
    const boot = vi.spyOn(browser, 'boot').mockImplementation(async () => {
      order.push('boot');
      return browser;
    });
    const capture = (retryCount: number) =>
      browser.screenshot(
        'fixture--default',
        { id: 'fixture--default', kind: 'Fixture', story: 'Default', version: 'v5' },
        { isDefault: true, keys: [] },
        retryCount,
        mainOptions.logger,
        false,
        false,
        { saveTrace: vi.fn() } as never,
      );
    return { boot, capture, close, navigate, order, unsubscribe, waitForReady };
  }

  it('creates its session with the CLI base viewport already applied', async () => {
    const options = {
      delay: 0,
      disableWaitAssets: false,
      logger: new Logger('silent'),
      viewports: ['1024x768'],
    } as MainOptions;
    const unsubscribe = vi.fn();
    const sessionClose = vi.fn(async () => {});
    const browserClose = vi.fn(async () => {});
    const newSession = vi.fn(async () => ({
      close: sessionClose,
      isHealthy: () => true,
      page: {
        exposeFunction: vi.fn(async () => {}),
        subscribeRequests: vi.fn(() => unsubscribe),
      },
    }));
    const backend = {
      launch: vi.fn(async () => ({ executablePath: 'chromium', newSession, close: browserClose })),
      name: 'test',
    };
    const browser = new CapturingBrowser(
      { url: 'https://example.test' } as ManagedStorybookConnection,
      options,
      'managed',
      0,
      backend as never,
    );

    await expect(browser.boot()).resolves.toBe(browser);

    expect(newSession).toHaveBeenCalledWith({ viewport: { height: 768, width: 1024 } });
    expect(browser as unknown as { viewport: unknown }).toMatchObject({
      viewport: { height: 768, width: 1024 },
    });
    await browser.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a captured PNG successful when best-effort input reset fails', async () => {
    const browser = new CapturingBrowser(
      { url: 'https://example.test' } as ManagedStorybookConnection,
      {
        delay: 0,
        disableWaitAssets: false,
        logger: new Logger('silent'),
        viewports: ['800x600'],
      } as MainOptions,
      'managed',
      0,
    );
    const page = {
      goto: vi.fn(async () => {}),
      resetPointer: vi.fn(async () => Promise.reject(new Error('target disappeared'))),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    Object.assign(browser, { currentRequestId: 'fixture--default', touched: true });
    const resetIfTouched = (
      browser as unknown as {
        resetIfTouched(): Promise<void>;
      }
    ).resetIfTouched.bind(browser);

    await expect(resetIfTouched()).resolves.toBeUndefined();

    expect(page.resetPointer).toHaveBeenCalledTimes(1);
    expect(page.goto).not.toHaveBeenCalled();
    expect((browser as unknown as { touched: boolean }).touched).toBe(false);

    await resetIfTouched();
    expect(page.resetPointer).toHaveBeenCalledTimes(1);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('does not repeat the preview visual commit for resource-only activity', async () => {
    const options = {
      captureMaxRetryCount: 0,
      captureTimeout: 5000,
      delay: 0,
      disableCssAnimation: false,
      disableWaitAssets: false,
      logger: new Logger('silent'),
      metricsWatchRetryCount: 3,
      viewportDelay: 0,
      viewports: ['800x600'],
    } as MainOptions;
    const screenshotOptions = createBaseScreenshotOptions(options);
    const browser = new CapturingBrowser(
      { url: 'https://example.test' } as ManagedStorybookConnection,
      options,
      'managed',
      0,
      { name: 'playwright' } as never,
    );
    const waitForVisualCommit = vi.fn(async () => ({
      didTimeout: false,
      elapsedMs: 0,
      fontsStatus: 'loaded' as const,
      imageCount: 0,
      imageDecodeFailureCount: 0,
      usedAnimationFrameFallback: false,
      visibilityState: 'visible' as const,
    }));
    const page = {
      screenshot: vi.fn(async () => Buffer.from('png')),
      subscribeConsole: vi.fn(() => () => {}),
      waitForVisualCommit,
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    const resourceWatcher = { clear: vi.fn(), generation: 2 };
    const navigator = {
      navigate: vi.fn(async () => {}),
      detectWorkerSessionSupport: vi.fn(async () => true),
      waitForReady: vi.fn(async () => {
        Object.assign(browser, { previewSettledResourceGeneration: 1 });
        return screenshotOptions;
      }),
    };
    Object.assign(browser, {
      navigator,
      resourceWatcher,
      viewport: { height: 600, width: 800 },
    });
    const waitForResources = vi.spyOn(browser as never, 'waitForResources').mockResolvedValue(undefined);
    const waitBrowserMetricsStable = vi
      .spyOn(browser as never, 'waitBrowserMetricsStable')
      .mockResolvedValue(undefined);

    await expect(
      browser.screenshot(
        'fixture--default',
        { id: 'fixture--default', kind: 'Fixture', story: 'Default', version: 'v5' },
        { isDefault: true, keys: [] },
        0,
        options.logger,
        false,
        false,
        {} as never,
      ),
    ).resolves.toMatchObject({ buffer: Buffer.from('png'), succeeded: true });

    expect(waitForResources).toHaveBeenCalledOnce();
    expect(waitBrowserMetricsStable).toHaveBeenCalledWith('postEmit', expect.any(CaptureDeadline));
    expect(waitForVisualCommit).not.toHaveBeenCalled();
  });

  it('requires the persistent Preview protocol on the first story-session capture', async () => {
    const options = {
      captureProtocol: 'story-session',
      delay: 0,
      disableCssAnimation: false,
      logger: new Logger('silent'),
      viewports: ['800x600'],
    } as MainOptions;
    const browser = new CapturingBrowser(
      { url: 'https://example.test' } as ManagedStorybookConnection,
      options,
      'managed',
      0,
      { name: 'playwright' } as never,
    );
    const navigate = vi.fn(async () => {});
    Object.assign(browser, {
      navigator: {
        canSelectStory: false,
        detectWorkerSessionSupport: vi.fn(async () => false),
        navigate,
        waitForReady: vi.fn(async () => ({})),
      },
    });
    const setCurrentStory = (
      browser as unknown as {
        setCurrentStory(
          story: { id: string; kind: string; story: string; version: 'v5' },
          deadline: CaptureDeadline,
        ): Promise<unknown>;
      }
    ).setCurrentStory.bind(browser);
    const deadline = new CaptureDeadline(5000, 'fixture--default');

    await expect(
      setCurrentStory({ id: 'fixture--default', kind: 'Fixture', story: 'Default', version: 'v5' }, deadline),
    ).rejects.toThrow('worker-session preview protocol is unavailable or incompatible');
    deadline.dispose();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'mobile/context',
      'context',
      { width: 375, height: 667, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
      true,
    ],
    [
      'mobile/process',
      'process',
      { width: 375, height: 667, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
      true,
    ],
    ['DPR', 'context', { width: 800, height: 600, deviceScaleFactor: 2, hasTouch: false, isMobile: false }, true],
    [
      'orientation',
      'process',
      { width: 600, height: 800, deviceScaleFactor: 1, hasTouch: false, isMobile: false, isLandscape: false },
      false,
    ],
  ] as const)(
    'applies a dynamic %s profile without replacing the worker session',
    async (_label, browserIsolation, nextViewport, requiresNavigation) => {
      const order: string[] = [];
      const navigate = vi.fn(async () => {
        order.push('navigate');
      });
      const waitForReady = vi.fn(async () => {
        order.push('preview-ready');
        return {};
      });
      const options = {
        browserIsolation,
        delay: 0,
        disableWaitAssets: false,
        logger: new Logger('silent'),
        reloadAfterChangeViewport: false,
        viewportDelay: 0,
        viewports: ['800x600'],
      } as MainOptions;
      const browser = new CapturingBrowser(
        { url: 'https://example.test' } as ManagedStorybookConnection,
        options,
        'managed',
        0,
        { name: 'playwright' } as never,
      );
      const page = {
        addStyleFile: vi.fn(async () => {}),
        goto: vi.fn(async () => {
          order.push('about:blank');
        }),
        setViewport: vi.fn(async () => {
          order.push('setViewport');
        }),
      };
      vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
      Object.assign(browser, {
        _currentStory: { id: 'fixture--default' },
        navigator: {
          navigate,
          detectWorkerSessionSupport: vi.fn(async () => true),
          waitForReady,
        },
        viewport: { height: 600, width: 800 },
      });
      const close = vi.spyOn(browser, 'close').mockResolvedValue(undefined);
      const boot = vi.spyOn(browser, 'boot').mockResolvedValue(browser);
      const setViewport = (
        browser as unknown as {
          setViewport(
            options: {
              viewport: {
                width: number;
                height: number;
                deviceScaleFactor: number;
                hasTouch: boolean;
                isMobile: boolean;
                isLandscape?: boolean;
              };
            },
            deadline: CaptureDeadline,
          ): Promise<boolean>;
        }
      ).setViewport.bind(browser);
      const deadline = new CaptureDeadline(5000, 'fixture--default');

      await expect(
        setViewport(
          {
            viewport: nextViewport,
          },
          deadline,
        ),
      ).resolves.toBe(true);
      deadline.dispose();

      expect(close).not.toHaveBeenCalled();
      expect(boot).not.toHaveBeenCalled();
      expect(page.setViewport).toHaveBeenCalledWith(nextViewport);
      if (requiresNavigation) {
        expect(page.goto).toHaveBeenCalledWith('about:blank', {
          timeout: expect.any(Number),
          waitUntil: 'domcontentloaded',
        });
        expect(navigate).toHaveBeenCalledWith('fixture--default', expect.any(Number), 0);
        expect(waitForReady).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['about:blank', 'setViewport', 'navigate', 'preview-ready']);
      } else {
        expect(page.goto).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(waitForReady).not.toHaveBeenCalled();
        expect(order).toEqual(['setViewport']);
      }
    },
  );

  it('closes a launched browser when post-launch setup fails', async () => {
    const options = {
      delay: 0,
      disableWaitAssets: false,
      viewports: ['800x600'],
    } as unknown as MainOptions;
    const unsubscribe = vi.fn();
    const sessionClose = vi.fn(async () => {});
    const browserClose = vi.fn(async () => {});
    const page = {
      exposeFunction: vi.fn(async () => {}),
      subscribeRequests: vi.fn(() => unsubscribe),
    };
    const backend = {
      launch: vi.fn(async () => ({
        executablePath: 'chromium',
        newSession: vi.fn(async () => ({ close: sessionClose, isHealthy: () => true, page })),
        close: browserClose,
      })),
      name: 'test',
    };
    const browser = new CapturingBrowser(
      { url: 'invalid' } as ManagedStorybookConnection,
      options,
      'managed',
      0,
      backend as never,
    );

    await expect(browser.boot()).rejects.toThrow('Invalid URL');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it('removes the console listener and retries when a Playwright trace fails to start', async () => {
    const options = {
      captureMaxRetryCount: 1,
      delay: 0,
      disableWaitAssets: false,
      logger: new Logger('silent'),
      metricsWatchRetryCount: 3,
      viewports: ['800x600'],
    } as unknown as MainOptions;
    const browser = new CapturingBrowser({ url: 'invalid' } as ManagedStorybookConnection, options, 'managed', 0);
    const unsubscribe = vi.fn();
    const discard = vi.fn(async () => {});
    const page = {
      startTrace: vi.fn(async () => Promise.reject(new Error('trace start failed'))),
      stopTrace: vi.fn(async () => {}),
      subscribeConsole: vi.fn(() => unsubscribe),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    const boot = vi.spyOn(browser, 'boot').mockResolvedValue(browser);
    vi.spyOn(browser, 'close').mockResolvedValue(undefined);
    Object.assign(browser, { resourceWatcher: { clear: vi.fn() } });

    await expect(
      browser.screenshot(
        'fixture--default',
        { id: 'fixture--default', kind: 'Fixture', story: 'Default', version: 'v5' },
        { isDefault: true, keys: [] },
        0,
        new Logger('silent'),
        false,
        true,
        {
          createTraceFile: vi.fn(async () => ({ write: vi.fn(), commit: vi.fn(), discard })),
        } as never,
      ),
    ).resolves.toMatchObject({ buffer: null, succeeded: false });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(page.stopTrace).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(boot).toHaveBeenCalledTimes(1);
  });

  it('returns a retry after an unhealthy Playwright capture closes and reboots the worker', async () => {
    process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS = '1';
    const write = vi.spyOn(fs, 'write').mockImplementation(completeStdoutWrite as never);
    const order: string[] = [];
    const watcher = { clear: vi.fn(), dispose: vi.fn() };
    const options = {
      captureMaxRetryCount: 3,
      delay: 0,
      disableWaitAssets: false,
      logger: new Logger('silent'),
      viewports: ['800x600'],
    } as MainOptions;
    const browser = new CapturingBrowser(
      { url: 'https://example.test' } as ManagedStorybookConnection,
      options,
      'managed',
      0,
      { name: 'playwright' } as never,
    );
    const page = {
      subscribeConsole: vi.fn(() => {
        throw new Error('page crashed');
      }),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    vi.spyOn(BaseBrowser.prototype as never, 'isSessionHealthy').mockReturnValue(false);
    Object.assign(browser, {
      _currentStory: { id: 'fixture--default' },
      navigator: {},
      resourceWatcher: watcher,
      touched: true,
      viewport: { height: 600, width: 800 },
    });
    const close = browser.close.bind(browser);
    vi.spyOn(browser, 'close').mockImplementation(async () => {
      order.push('close');
      await close();
    });
    vi.spyOn(browser, 'boot').mockImplementation(async () => {
      order.push('boot');
      return browser;
    });

    await expect(
      browser.screenshot(
        'fixture--default',
        { id: 'fixture--default', kind: 'Fixture', story: 'Default', version: 'v5' },
        { isDefault: true, keys: [] },
        0,
        options.logger,
        false,
        false,
        { saveTrace: vi.fn() } as never,
      ),
    ).resolves.toEqual({ buffer: null, succeeded: false, variantKeysToPush: [], defaultVariantSuffix: '' });

    expect(order).toEqual(['close', 'boot']);
    expect(watcher.dispose).toHaveBeenCalledTimes(1);
    expect(browser.currentStory).toBeUndefined();
    expect(
      browser as unknown as { navigator?: unknown; resourceWatcher?: unknown; touched: boolean; viewport?: unknown },
    ).toMatchObject({ navigator: undefined, resourceWatcher: undefined, touched: false, viewport: undefined });
    const completion = write.mock.calls
      .map(([, chunk]) => String(chunk))
      .find(line => line.includes('"type":"capture-complete"'));
    expect(completion).toBeDefined();
    expect(JSON.parse(completion!.slice(CAPTURE_DIAGNOSTIC_PREFIX.length))).toMatchObject({
      outcome: 'retry',
      requestId: 'fixture--default',
      storyId: 'fixture--default',
      variantKey: [],
      workerId: 0,
    });
  });

  it('uses a fresh context after a recoverable preview timeout in context mode', async () => {
    const options = {
      browserIsolation: 'context',
      captureMaxRetryCount: 2,
      delay: 0,
      disableWaitAssets: false,
      logger: new Logger('silent'),
      viewports: ['800x600'],
    } as MainOptions;
    const browser = new CapturingBrowser(
      { url: 'https://example.test' } as ManagedStorybookConnection,
      options,
      'managed',
      0,
      { name: 'playwright' } as never,
    );
    const unsubscribe = vi.fn();
    const page = {
      addStyleFile: vi.fn(async () => {}),
      subscribeConsole: vi.fn(() => unsubscribe),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    Object.assign(browser, {
      navigator: {
        navigate: vi.fn(async () => {}),
        waitForReady: vi.fn(async () =>
          Promise.reject(
            new PreviewReadyTimeoutError(
              1000,
              'https://example.test',
              { requestId: '0-1', storyId: 'fixture--default' },
              undefined,
            ),
          ),
        ),
      },
      resourceWatcher: { clear: vi.fn(), dispose: vi.fn() },
    });
    const close = vi.spyOn(browser, 'close').mockResolvedValue(undefined);
    const boot = vi.spyOn(browser, 'boot').mockResolvedValue(browser);

    await expect(
      browser.screenshot(
        'fixture--default',
        { id: 'fixture--default', kind: 'Fixture', story: 'Default', version: 'v5' },
        { isDefault: true, keys: [] },
        0,
        options.logger,
        false,
        false,
        { saveTrace: vi.fn() } as never,
      ),
    ).resolves.toEqual({ buffer: null, succeeded: false, variantKeysToPush: [], defaultVariantSuffix: '' });

    expect(close).toHaveBeenCalledTimes(1);
    expect(boot).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('closes a stalled capture, drains its page operation, and then reboots for a retry', async () => {
    const { boot, capture, close, navigate, order, unsubscribe, waitForReady } = createStalledCapture({
      captureTimeout: 20,
      maxRetryCount: 2,
      mode: 'managed',
    });

    await expect(capture(0)).resolves.toEqual({
      buffer: null,
      succeeded: false,
      variantKeysToPush: [],
      defaultVariantSuffix: '',
    });

    expect(waitForReady).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][1]).toBeGreaterThan(0);
    expect(navigate.mock.calls[0][1]).toBeLessThanOrEqual(20);
    expect(order).toEqual(['close', 'boot']);
    expect(close).toHaveBeenCalledTimes(1);
    expect(boot).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('releases a capture result that completes after its deadline', async () => {
    const options = {
      captureMaxRetryCount: 0,
      captureTimeout: 5,
      delay: 0,
      disableWaitAssets: false,
      logger: new Logger('silent'),
      viewports: ['800x600'],
    } as MainOptions;
    const browser = new CapturingBrowser(
      { url: 'https://example.test' } as ManagedStorybookConnection,
      options,
      'managed',
      0,
    );
    const buffer = Buffer.from('late capture');
    let resolveAttempt!: (result: {
      buffer: Buffer;
      succeeded: boolean;
      variantKeysToPush: never[];
      defaultVariantSuffix: string;
    }) => void;
    const lateAttempt = new Promise<{
      buffer: Buffer;
      succeeded: boolean;
      variantKeysToPush: never[];
      defaultVariantSuffix: string;
    }>(resolve => {
      resolveAttempt = resolve;
    });
    vi.spyOn(browser as never, 'screenshotAttempt').mockReturnValue(lateAttempt);
    vi.spyOn(browser, 'close').mockImplementation(async () => {
      resolveAttempt({ buffer, succeeded: true, variantKeysToPush: [], defaultVariantSuffix: '' });
    });
    const releaseScreenshotBuffer = vi.fn();

    await expect(
      browser.screenshot(
        'fixture--default',
        { id: 'fixture--default', kind: 'Fixture', story: 'Default', version: 'v5' },
        { isDefault: true, keys: [] },
        0,
        options.logger,
        false,
        false,
        { releaseScreenshotBuffer } as never,
      ),
    ).rejects.toBeInstanceOf(CaptureAttemptTimeoutError);

    expect(releaseScreenshotBuffer).toHaveBeenCalledTimes(1);
    expect(releaseScreenshotBuffer).toHaveBeenCalledWith(buffer);
  });

  it('releases a captured buffer after its deadline even when post-capture work never settles', async () => {
    const options = {
      captureMaxRetryCount: 0,
      captureTimeout: 5,
      delay: 0,
      disableWaitAssets: false,
      logger: new Logger('silent'),
      viewports: ['800x600'],
    } as MainOptions;
    const browser = new CapturingBrowser(
      { url: 'https://example.test' } as ManagedStorybookConnection,
      options,
      'managed',
      0,
    );
    const buffer = Buffer.from('captured before stalled reset');
    const releaseScreenshotBuffer = vi.fn();
    vi.spyOn(browser as never, 'screenshotAttempt').mockImplementation((...args: unknown[]) => {
      const onCapturedBuffer = args.at(-1) as (captured: Buffer, release: () => void) => void;
      let released = false;
      onCapturedBuffer(buffer, () => {
        if (released) return;
        released = true;
        releaseScreenshotBuffer(buffer);
      });
      return new Promise(() => {});
    });
    vi.spyOn(browser as never, 'interruptAttempt').mockResolvedValue(false);

    await expect(
      browser.screenshot(
        'fixture--default',
        { id: 'fixture--default', kind: 'Fixture', story: 'Default', version: 'v5' },
        { isDefault: true, keys: [] },
        0,
        options.logger,
        false,
        false,
        { releaseScreenshotBuffer } as never,
      ),
    ).rejects.toThrow('did not stop after its browser session was closed');

    expect(releaseScreenshotBuffer).toHaveBeenCalledOnce();
    expect(releaseScreenshotBuffer).toHaveBeenCalledWith(buffer);
  });

  it('applies the attempt deadline to simple mode and preserves the timeout after the final retry', async () => {
    const { boot, capture, close } = createStalledCapture({
      captureTimeout: 20,
      delay: 1000,
      maxRetryCount: 1,
      mode: 'simple',
    });

    await expect(capture(1)).rejects.toBeInstanceOf(CaptureAttemptTimeoutError);

    expect(close).toHaveBeenCalledTimes(1);
    expect(boot).not.toHaveBeenCalled();
  });

  it('closes and drains a stalled attempt on run abort without rebooting it', async () => {
    const controller = new AbortController();
    const { boot, capture, close, waitForReady } = createStalledCapture({
      captureTimeout: 1000,
      maxRetryCount: 2,
      mode: 'managed',
      signal: controller.signal,
    });
    const capturing = capture(0);
    await vi.waitFor(() => expect(waitForReady).toHaveBeenCalledTimes(1));

    controller.abort(new Error('interrupted by test'));

    await expect(capturing).rejects.toThrow('interrupted by test');
    expect(close).toHaveBeenCalledTimes(1);
    expect(boot).not.toHaveBeenCalled();
  });
});

describe(shouldRecoverPlaywrightWorker, () => {
  const recoverable = {
    aborted: false,
    healthy: false,
    maxRetryCount: 3,
    retryCount: 2,
  };

  it('only recovers an unhealthy Playwright worker below the retry limit', () => {
    expect(shouldRecoverPlaywrightWorker(recoverable)).toBe(true);
    expect(shouldRecoverPlaywrightWorker({ ...recoverable, healthy: true })).toBe(false);
    expect(shouldRecoverPlaywrightWorker({ ...recoverable, healthy: true, protocolFault: true })).toBe(true);
    expect(shouldRecoverPlaywrightWorker({ ...recoverable, aborted: true })).toBe(false);
    expect(shouldRecoverPlaywrightWorker({ ...recoverable, retryCount: 3 })).toBe(false);
  });
});

describe(shouldWaitForVisualCommit, () => {
  it('waits for simple mode and managed browser-side mutations only', () => {
    expect(shouldWaitForVisualCommit('simple', false, false)).toBe(true);
    expect(shouldWaitForVisualCommit('managed', true, false)).toBe(true);
    expect(shouldWaitForVisualCommit('managed', false, true)).toBe(true);
    expect(shouldWaitForVisualCommit('managed', false, false)).toBe(false);
  });
});

describe(main, () => {
  const logger = new Logger('silent');
  const options = {
    logger,
    serverOptions: { storybookUrl: 'https://example.test', serverCmd: '', serverTimeout: 1000 },
    outDir: '__screenshots__',
    flat: false,
    include: [],
    exclude: [],
    shard: { shardNumber: 1, totalShards: 1 },
  } as unknown as MainOptions;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('emits runtime phase diagnostics without changing a failed run', async () => {
    vi.stubEnv('STORYFREEZE_CAPTURE_DIAGNOSTICS', '1');
    const write = vi.spyOn(fs, 'write').mockImplementation(completeStdoutWrite as never);
    vi.spyOn(ManagedStorybookConnection.prototype, 'connect').mockImplementation(
      async function (this: ManagedStorybookConnection) {
        return this;
      },
    );
    vi.spyOn(ManagedStorybookConnection.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(BaseBrowser.prototype, 'boot').mockImplementation(async function (this: BaseBrowser) {
      return this;
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('enumeration failed'));
    vi.spyOn(BaseBrowser.prototype, 'close').mockResolvedValue(undefined);

    await expect(main(options)).rejects.toThrow('enumeration failed');

    const events = write.mock.calls
      .map(([, chunk]) => String(chunk))
      .filter(line => line.startsWith(CAPTURE_DIAGNOSTIC_PREFIX))
      .map(line => JSON.parse(line.slice(CAPTURE_DIAGNOSTIC_PREFIX.length)))
      .filter(event => event.type === 'runtime-phase' && event.state === 'end');
    const phases = events.map(event => event.phase);
    expect(new Set(phases)).toEqual(
      new Set(['storybook-connect', 'story-index-browser-boot', 'story-index-load', 'runtime-dispose']),
    );
    expect(phases.indexOf('story-index-load')).toBeGreaterThan(phases.indexOf('storybook-connect'));
    expect(phases.at(-1)).toBe('runtime-dispose');
    expect(events.find(event => event.phase === 'story-index-load')).toMatchObject({
      durationMs: expect.any(Number),
      error: { message: 'enumeration failed', name: 'Error' },
    });
  });

  it('closes the enumeration browser and connection when story enumeration fails', async () => {
    vi.spyOn(ManagedStorybookConnection.prototype, 'connect').mockImplementation(
      async function (this: ManagedStorybookConnection) {
        return this;
      },
    );
    const disconnect = vi.spyOn(ManagedStorybookConnection.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(BaseBrowser.prototype, 'boot').mockImplementation(async function (this: BaseBrowser) {
      return this;
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('enumeration failed'));
    const close = vi.spyOn(BaseBrowser.prototype, 'close').mockResolvedValue(undefined);

    await expect(main(options)).rejects.toThrow('enumeration failed');

    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('cancels peer startup work without loading the story index after browser boot fails', async () => {
    const failure = new Error('browser boot failed');
    let connectionSignal: AbortSignal | undefined;
    vi.spyOn(ManagedStorybookConnection.prototype, 'connect').mockImplementation(function (
      this: ManagedStorybookConnection,
      signal?: AbortSignal,
    ) {
      connectionSignal = signal;
      return new Promise(resolve => setImmediate(() => resolve(this)));
    });
    const disconnect = vi.spyOn(ManagedStorybookConnection.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(BaseBrowser.prototype, 'boot').mockRejectedValue(failure);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const close = vi.spyOn(BaseBrowser.prototype, 'close').mockResolvedValue(undefined);

    await expect(main(options)).rejects.toBe(failure);

    expect(connectionSignal?.aborted).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects after an early return when no stories match', async () => {
    vi.spyOn(ManagedStorybookConnection.prototype, 'connect').mockImplementation(
      async function (this: ManagedStorybookConnection) {
        return this;
      },
    );
    const disconnect = vi.spyOn(ManagedStorybookConnection.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(BaseBrowser.prototype, 'boot').mockImplementation(async function (this: BaseBrowser) {
      return this;
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ entries: {} })));
    const close = vi.spyOn(BaseBrowser.prototype, 'close').mockResolvedValue(undefined);
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue({
      goto: vi.fn(async () => {}),
      evaluate: vi.fn(async () => false),
    } as never);

    await expect(main(options)).resolves.toBe(0);

    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('closes the browser and connection when interrupted during enumeration', async () => {
    const controller = new AbortController();
    vi.spyOn(ManagedStorybookConnection.prototype, 'connect').mockImplementation(
      async function (this: ManagedStorybookConnection) {
        return this;
      },
    );
    const disconnect = vi.spyOn(ManagedStorybookConnection.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(BaseBrowser.prototype, 'boot').mockImplementation(async function (this: BaseBrowser) {
      return this;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const close = vi.spyOn(BaseBrowser.prototype, 'close').mockResolvedValue(undefined);

    const running = main({ ...options, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error('interrupted by test'));

    await expect(running).rejects.toThrow('interrupted by test');
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('bounds story index enumeration and aborts its fetch before disposal', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(ManagedStorybookConnection.prototype, 'connect').mockImplementation(
        async function (this: ManagedStorybookConnection) {
          return this;
        },
      );
      const disconnect = vi.spyOn(ManagedStorybookConnection.prototype, 'disconnect').mockResolvedValue(undefined);
      vi.spyOn(BaseBrowser.prototype, 'boot').mockImplementation(async function (this: BaseBrowser) {
        return this;
      });
      let fetchSignal: AbortSignal | undefined;
      vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          const onAbort = () => reject(fetchSignal?.reason);
          if (fetchSignal?.aborted) onAbort();
          else fetchSignal?.addEventListener('abort', onAbort, { once: true });
        });
      });
      const close = vi.spyOn(BaseBrowser.prototype, 'close').mockResolvedValue(undefined);

      const running = main({ ...options, captureTimeout: 1_000 });
      const rejection = expect(running).rejects.toThrow('Story index load did not settle within 60000 msec');
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSignal).toBeDefined();
      await vi.advanceTimersByTimeAsync(60_000);

      await rejection;
      expect(fetchSignal?.aborted).toBe(true);
      expect(close).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
