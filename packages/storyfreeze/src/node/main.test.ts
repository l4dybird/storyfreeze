import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { BaseBrowser } from './browser.js';
import {
  CapturingBrowser,
  emulationProfileKey,
  shouldRecoverPlaywrightWorker,
  shouldWaitForVisualCommit,
} from './capturing-browser.js';
import { Logger } from './logger.js';
import { ManagedStorybookConnection } from './managed-storybook-connection.js';
import type { MainOptions } from './types.js';
import { bootCaptureWorkers, disposeRuntimeResources, filterStories, main } from './main.js';
import type { StoryDescriptor } from './story-index-provider.js';
import { CAPTURE_DIAGNOSTIC_PREFIX } from './capture-diagnostics.js';
import { PreviewReadyTimeoutError } from './errors.js';

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
});

describe(bootCaptureWorkers, () => {
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

  it('waits for late workers and closes every worker when one boot fails', async () => {
    let releaseLateWorker = () => {};
    const failure = new Error('boot failed');
    const failedWorker = createWorker(async () => Promise.reject(failure));
    const lateWorker = createWorker(() => new Promise<void>(resolve => (releaseLateWorker = resolve)));

    const booting = bootCaptureWorkers([failedWorker, lateWorker]);
    await Promise.resolve();

    expect(failedWorker.close).not.toHaveBeenCalled();
    expect(lateWorker.close).not.toHaveBeenCalled();

    releaseLateWorker();
    await expect(booting).rejects.toBe(failure);
    expect(failedWorker.close).toHaveBeenCalledTimes(1);
    expect(lateWorker.close).toHaveBeenCalledTimes(1);
  });

  it('finishes in-flight boots before closing workers after an abort', async () => {
    let releaseWorker = () => {};
    const controller = new AbortController();
    const worker = createWorker(() => new Promise<void>(resolve => (releaseWorker = resolve)));

    const booting = bootCaptureWorkers([worker], controller.signal);
    controller.abort(new Error('interrupted by test'));
    await Promise.resolve();

    expect(worker.close).not.toHaveBeenCalled();
    releaseWorker();
    await expect(booting).rejects.toThrow('interrupted by test');
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('does not start workers when the run is already aborted', async () => {
    const controller = new AbortController();
    const worker = createWorker(async () => {});
    controller.abort(new Error('already interrupted'));

    await expect(bootCaptureWorkers([worker], controller.signal)).rejects.toThrow('already interrupted');
    expect(worker.boot).not.toHaveBeenCalled();
  });
});

describe(CapturingBrowser, () => {
  const originalCaptureDiagnostics = process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCaptureDiagnostics === undefined) delete process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS;
    else process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS = originalCaptureDiagnostics;
  });

  it('resets browser input without navigating after a touched capture', async () => {
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
      blur: vi.fn(async () => {}),
      goto: vi.fn(async () => {}),
      resetPointer: vi.fn(async () => {}),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    Object.assign(browser, { currentRequestId: 'fixture--default', touched: true });
    const resetIfTouched = (
      browser as unknown as {
        resetIfTouched(options: { click: string; focus: string }): Promise<void>;
      }
    ).resetIfTouched.bind(browser);

    await resetIfTouched({ click: '#click-target', focus: '#focus-target' });

    expect(page.blur.mock.calls).toEqual([['#click-target'], ['#focus-target']]);
    expect(page.resetPointer).toHaveBeenCalledTimes(1);
    expect(page.goto).not.toHaveBeenCalled();
    expect((browser as unknown as { touched: boolean }).touched).toBe(false);

    await resetIfTouched({ click: '#click-target', focus: '#focus-target' });
    expect(page.blur).toHaveBeenCalledTimes(2);
    expect(page.resetPointer).toHaveBeenCalledTimes(1);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('recreates a Playwright context only when the emulation profile changes', async () => {
    expect(emulationProfileKey({ width: 800, height: 600 })).toBe(emulationProfileKey({ width: 1200, height: 900 }));
    expect(emulationProfileKey({ width: 800, height: 600 })).not.toBe(
      emulationProfileKey({ width: 800, height: 600, deviceScaleFactor: 2 }),
    );

    const options = {
      browserIsolation: 'context',
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
      goto: vi.fn(async () => {}),
      setViewport: vi.fn(async () => {}),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    Object.assign(browser, {
      _currentStory: { id: 'fixture--default' },
      navigator: { navigate: vi.fn(async () => {}), waitForReady: vi.fn(async () => ({})) },
      viewport: { height: 600, width: 800 },
    });
    const close = vi.spyOn(browser, 'close').mockResolvedValue(undefined);
    const boot = vi.spyOn(browser, 'boot').mockResolvedValue(browser);
    const setViewport = (
      browser as unknown as {
        setViewport(
          options: {
            viewport: { width: number; height: number; deviceScaleFactor: number };
          },
          onPageRecreated?: () => void,
        ): Promise<boolean>;
      }
    ).setViewport.bind(browser);
    const onPageRecreated = vi.fn();

    await expect(
      setViewport({ viewport: { width: 800, height: 600, deviceScaleFactor: 2 } }, onPageRecreated),
    ).resolves.toBe(true);

    expect(close).toHaveBeenCalledTimes(1);
    expect(boot).toHaveBeenCalledWith({
      viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
    });
    expect(onPageRecreated).toHaveBeenCalledTimes(1);
    expect(page.setViewport).toHaveBeenCalledWith({ width: 800, height: 600, deviceScaleFactor: 2 });
  });

  it('closes a launched browser when post-launch setup fails', async () => {
    const options = {
      delay: 0,
      disableWaitAssets: false,
      viewports: ['800x600'],
    } as unknown as MainOptions;
    const browser = new CapturingBrowser({ url: 'invalid' } as ManagedStorybookConnection, options, 'managed', 0);
    const unsubscribe = vi.fn();
    const page = {
      exposeFunction: vi.fn(async () => {}),
      subscribeRequests: vi.fn(() => unsubscribe),
    };
    vi.spyOn(BaseBrowser.prototype, 'boot').mockResolvedValue(browser);
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    const close = vi.spyOn(BaseBrowser.prototype, 'close').mockResolvedValue(undefined);

    await expect(browser.boot()).rejects.toThrow('Invalid URL');
    expect(close).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('removes the console listener without stopping a trace that failed to start', async () => {
    const options = {
      captureMaxRetryCount: 1,
      delay: 0,
      disableWaitAssets: false,
      metricsWatchRetryCount: 3,
      viewports: ['800x600'],
    } as unknown as MainOptions;
    const browser = new CapturingBrowser({ url: 'invalid' } as ManagedStorybookConnection, options, 'managed', 0);
    const unsubscribe = vi.fn();
    const page = {
      startTrace: vi.fn(async () => Promise.reject(new Error('trace start failed'))),
      stopTrace: vi.fn(async () => Buffer.from('trace')),
      subscribeConsole: vi.fn(() => unsubscribe),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
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
        { saveTrace: vi.fn() } as never,
      ),
    ).rejects.toThrow('trace start failed');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(page.stopTrace).not.toHaveBeenCalled();
  });

  it('rebinds the console listener when viewport setup replaces the context page', async () => {
    const options = {
      browserIsolation: 'context',
      captureMaxRetryCount: 1,
      captureTimeout: 5000,
      delay: 0,
      disableCssAnimation: false,
      disableWaitAssets: false,
      logger: new Logger('silent'),
      metricsWatchRetryCount: 3,
      viewports: ['800x600'],
    } as MainOptions;
    const browser = new CapturingBrowser(
      { url: 'https://example.test' } as ManagedStorybookConnection,
      options,
      'managed',
      0,
      { name: 'playwright' } as never,
    );
    const unsubscribeOldPage = vi.fn();
    const unsubscribeNewPage = vi.fn();
    const page = {
      subscribeConsole: vi.fn().mockReturnValueOnce(unsubscribeOldPage).mockReturnValueOnce(unsubscribeNewPage),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    Object.assign(browser, {
      navigator: {
        navigate: vi.fn(async () => {}),
        waitForReady: vi.fn(async () => ({})),
      },
      resourceWatcher: { clear: vi.fn() },
    });
    const setViewport = vi.spyOn(
      browser as unknown as {
        setViewport(options: unknown, onPageRecreated?: () => void): Promise<boolean>;
      },
      'setViewport',
    );
    setViewport.mockImplementation(async (_viewport, onPageRecreated) => {
      onPageRecreated?.();
      return false;
    });

    await expect(
      browser.screenshot(
        'fixture--default',
        { id: 'fixture--default', kind: 'Fixture', story: 'Default', version: 'v5' },
        { isDefault: true, keys: [] },
        0,
        options.logger,
        true,
        false,
        { saveTrace: vi.fn() } as never,
      ),
    ).resolves.toEqual({ buffer: null, succeeded: true, variantKeysToPush: [], defaultVariantSuffix: '' });

    expect(page.subscribeConsole).toHaveBeenCalledTimes(2);
    expect(unsubscribeOldPage).toHaveBeenCalledTimes(1);
    expect(unsubscribeNewPage).toHaveBeenCalledTimes(1);
  });

  it('returns a retry after an unhealthy Playwright capture closes and reboots the worker', async () => {
    process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS = '1';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
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
      .map(([chunk]) => String(chunk))
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
});

describe(shouldRecoverPlaywrightWorker, () => {
  const recoverable = {
    aborted: false,
    backendName: 'playwright' as const,
    healthy: false,
    maxRetryCount: 3,
    retryCount: 2,
  };

  it('only recovers an unhealthy Playwright worker below the retry limit', () => {
    expect(shouldRecoverPlaywrightWorker(recoverable)).toBe(true);
    expect(shouldRecoverPlaywrightWorker({ ...recoverable, backendName: 'puppeteer' })).toBe(false);
    expect(shouldRecoverPlaywrightWorker({ ...recoverable, healthy: true })).toBe(false);
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

  afterEach(() => vi.restoreAllMocks());

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
});
