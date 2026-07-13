import fs from 'node:fs';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type ConsoleMessage,
  type ElementHandle,
  type Page,
  type Request,
} from 'playwright-core';
import type { Viewport } from '../shared/types.js';
import {
  waitForVisualCommitInPage,
  waitForVisualCommitWithAbort,
  type VisualCommitOptions,
} from '../shared/visual-commit.js';
import {
  ChromiumNotFoundError,
  type BrowserBackend,
  type BrowserConsoleMessage,
  type BrowserInstance,
  type BrowserRequest,
  type BrowserRuntimeOptions,
  type BrowserSession,
  type BrowserSessionOptions,
  type CapturePage,
  type NavigationOptions,
  type RequestListeners,
  type ScreenshotCaptureOptions,
} from './browser-backend.js';
import { findChrome, type FindChromeOptions, type FindChromeResult } from './puppeteer-browser-backend.js';

const traceCategories = [
  '-*',
  'devtools.timeline',
  'v8.execute',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'toplevel',
  'blink.console',
  'blink.user_timing',
  'latencyInfo',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-v8.cpu_profiler.hires',
].join(',');

type PlaywrightBackendDependencies = {
  canAccess(path: string): boolean;
  findChrome(options: FindChromeOptions): Promise<FindChromeResult>;
  launch(options: Parameters<typeof chromium.launch>[0]): Promise<Browser>;
  managedExecutablePath(): string;
};

const defaultDependencies: PlaywrightBackendDependencies = {
  canAccess(path) {
    try {
      fs.accessSync(path);
      return true;
    } catch {
      return false;
    }
  },
  findChrome,
  launch: options => chromium.launch(options),
  managedExecutablePath: () => chromium.executablePath(),
};

type CdpClient = {
  off(event: string, listener: (payload: unknown) => void): unknown;
  once(event: string, listener: (payload: unknown) => void): unknown;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

function asCdpClient(session: CDPSession): CdpClient {
  return session as unknown as CdpClient;
}

export class PlaywrightCapturePage implements CapturePage {
  private readonly requests = new WeakMap<Request, BrowserRequest>();
  private readonly cdp: CdpClient;
  private traceState: 'idle' | 'starting' | 'active' | 'stopping' | 'failed' = 'idle';
  private viewport?: Viewport;

  isHealthy() {
    return this.traceState !== 'failed';
  }

  constructor(
    private readonly rawPage: Page,
    rawCdp: CDPSession,
  ) {
    this.cdp = asCdpClient(rawCdp);
  }

  addStyleFile(path: string) {
    return this.rawPage.addStyleTag({ path }).then(() => {});
  }

  blur(selector: string) {
    return this.rawPage.$eval(selector, (element: unknown) => (element as HTMLElement)?.blur());
  }

  click(selector: string) {
    return this.withElement(selector, element => element.click());
  }

  currentUrl() {
    return this.rawPage.url();
  }

  async elementExists(selector: string) {
    return (await this.rawPage.locator(selector).count()) > 0;
  }

  evaluate<Result>(fn: () => Result | Promise<Result>): Promise<Awaited<Result>>;
  evaluate<Argument, Result>(
    fn: (argument: Argument) => Result | Promise<Result>,
    argument: Argument,
  ): Promise<Awaited<Result>>;
  evaluate<Argument, Result>(
    fn: ((argument: Argument) => Result | Promise<Result>) | (() => Result | Promise<Result>),
    argument?: Argument,
  ) {
    return this.rawPage.evaluate(fn as never, argument as never) as Promise<Awaited<Result>>;
  }

  async exposeFunction<Arguments extends unknown[], Result>(
    name: string,
    fn: (...args: Arguments) => Result | Promise<Result>,
  ) {
    await this.rawPage.exposeFunction(name, fn as never);
  }

  focus(selector: string) {
    return this.withElement(selector, element => element.focus());
  }

  async goto(url: string, options?: NavigationOptions) {
    await this.rawPage.goto(url, options);
  }

  hover(selector: string) {
    return this.withElement(selector, element => element.hover());
  }

  async readMetrics() {
    const response = (await this.cdp.send('Performance.getMetrics')) as {
      metrics?: Array<{ name: string; value: number }>;
    };
    const metrics = new Map(response.metrics?.map(metric => [metric.name, metric.value]));
    return {
      nodes: metrics.get('Nodes'),
      recalcStyleCount: metrics.get('RecalcStyleCount'),
      layoutCount: metrics.get('LayoutCount'),
    };
  }

  async resetPointer() {
    await this.rawPage.mouse.move(0, 0);
    await this.rawPage.mouse.click(0, 0);
  }

  waitForVisualCommit(options: VisualCommitOptions, signal?: AbortSignal) {
    return waitForVisualCommitWithAbort(this.rawPage.evaluate(waitForVisualCommitInPage, options), signal);
  }

  async screenshot(options: ScreenshotCaptureOptions) {
    if (options.clip && options.fullPage) {
      throw new Error('options.clip and options.fullPage are exclusive');
    }
    if (options.clip) {
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        if (typeof options.clip[key] !== 'number') {
          throw new TypeError(`Expected options.clip.${key} to be a number`);
        }
      }
      if (options.clip.width === 0) throw new Error('Expected options.clip.width not to be 0.');
      if (options.clip.height === 0) throw new Error('Expected options.clip.height not to be 0.');
    }

    await this.rawPage.bringToFront();
    const captureBeyondViewport =
      typeof options.captureBeyondViewport === 'boolean' ? options.captureBeyondViewport : true;
    let clip = options.clip
      ? {
          x: Math.round(options.clip.x),
          y: Math.round(options.clip.y),
          width: Math.round(options.clip.width + options.clip.x - Math.round(options.clip.x)),
          height: Math.round(options.clip.height + options.clip.y - Math.round(options.clip.y)),
          scale: 1,
        }
      : undefined;
    let backgroundOverridden = false;
    let viewportOverridden = false;

    try {
      if (options.fullPage) {
        const metrics = (await this.cdp.send('Page.getLayoutMetrics')) as {
          contentSize: { height: number; width: number };
        };
        const contentSize = metrics.contentSize;
        clip = {
          x: 0,
          y: 0,
          width: Math.ceil(contentSize.width),
          height: Math.ceil(contentSize.height),
          scale: 1,
        };
        if (!captureBeyondViewport && this.viewport) {
          await this.applyDeviceMetrics({ ...this.viewport, width: clip.width, height: clip.height });
          viewportOverridden = true;
        }
      }
      if (options.omitBackground) {
        await this.cdp.send('Emulation.setDefaultBackgroundColorOverride', {
          color: { r: 0, g: 0, b: 0, a: 0 },
        });
        backgroundOverridden = true;
      }
      const result = (await this.cdp.send('Page.captureScreenshot', {
        format: 'png',
        ...(clip ? { clip } : {}),
        captureBeyondViewport,
      })) as { data: string };
      return Buffer.from(result.data, 'base64');
    } finally {
      try {
        if (backgroundOverridden) {
          await this.cdp.send('Emulation.setDefaultBackgroundColorOverride');
        }
      } finally {
        if (viewportOverridden && this.viewport) await this.applyDeviceMetrics(this.viewport);
      }
    }
  }

  async setViewport(viewport: Viewport) {
    await this.rawPage.setViewportSize({ width: viewport.width, height: viewport.height });
    await this.applyDeviceMetrics(viewport);
    const hasTouch = viewport.hasTouch ?? false;
    await this.cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: hasTouch,
      ...(hasTouch ? { maxTouchPoints: 1 } : {}),
    });
    this.viewport = { ...viewport };
  }

  private applyDeviceMetrics(viewport: Viewport) {
    const orientation = viewport.isLandscape
      ? { type: 'landscapePrimary', angle: 90 }
      : { type: 'portraitPrimary', angle: 0 };
    return this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor || 1,
      mobile: viewport.isMobile ?? false,
      screenOrientation: orientation,
    });
  }

  async startTrace() {
    if (this.traceState === 'failed') {
      throw new Error('The Chromium trace state is unavailable. Close the browser before tracing again.');
    }
    if (this.traceState !== 'idle') throw new Error('A Chromium trace is already running.');
    this.traceState = 'starting';
    try {
      await this.cdp.send('Tracing.start', {
        categories: traceCategories,
        transferMode: 'ReturnAsStream',
      });
      this.traceState = 'active';
    } catch (error) {
      this.traceState = 'idle';
      throw error;
    }
  }

  async stopTrace() {
    if (this.traceState !== 'active') throw new Error('A Chromium trace has not been started.');
    this.traceState = 'stopping';
    let completedReceived = false;
    let resolveCompleted!: (result: { stream?: string }) => void;
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<{ stream?: string }>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    void completed.catch(() => {});
    const onCompleted = (payload: unknown) => {
      completedReceived = true;
      resolveCompleted(payload as { stream?: string });
    };
    const onCdpClose = () => rejectCompleted(new Error('The Chromium CDP session closed while tracing.'));
    this.cdp.once('Tracing.tracingComplete', onCompleted);
    this.cdp.once('close', onCdpClose);
    try {
      await this.cdp.send('Tracing.end');
      const { stream } = await completed;
      if (!stream) throw new Error('Chromium did not provide a trace stream.');

      const chunks: Buffer[] = [];
      try {
        let eof = false;
        while (!eof) {
          const result = (await this.cdp.send('IO.read', { handle: stream })) as {
            base64Encoded?: boolean;
            data: string;
            eof?: boolean;
          };
          chunks.push(Buffer.from(result.data, result.base64Encoded ? 'base64' : 'utf8'));
          eof = Boolean(result.eof);
        }
      } finally {
        await this.cdp.send('IO.close', { handle: stream });
      }
      const buffer = Buffer.concat(chunks);
      this.traceState = 'idle';
      return buffer;
    } catch (error) {
      this.traceState = 'failed';
      throw error;
    } finally {
      if (!completedReceived) this.cdp.off('Tracing.tracingComplete', onCompleted);
      this.cdp.off('close', onCdpClose);
    }
  }

  subscribeConsole(listener: (message: BrowserConsoleMessage) => void) {
    const onConsole = (message: ConsoleMessage) => listener({ text: message.text(), type: message.type() });
    this.rawPage.on('console', onConsole);
    return () => this.rawPage.off('console', onConsole);
  }

  subscribeRequests(listeners: RequestListeners) {
    const toRequest = (request: Request) => {
      let normalized = this.requests.get(request);
      if (!normalized) {
        normalized = {
          method: request.method(),
          resourceType: request.resourceType(),
          url: request.url(),
        };
        this.requests.set(request, normalized);
      }
      return normalized;
    };
    const onRequest = (request: Request) => listeners.started(toRequest(request));
    const onRequestComplete = (request: Request) => {
      listeners.finished(toRequest(request));
      this.requests.delete(request);
    };
    this.rawPage.on('request', onRequest);
    this.rawPage.on('requestfinished', onRequestComplete);
    this.rawPage.on('requestfailed', onRequestComplete);
    return () => {
      this.rawPage.off('request', onRequest);
      this.rawPage.off('requestfinished', onRequestComplete);
      this.rawPage.off('requestfailed', onRequestComplete);
    };
  }

  private async withElement(
    selector: string,
    action: (element: ElementHandle<HTMLElement | SVGElement>) => Promise<void>,
  ) {
    const element = await this.rawPage.$(selector);
    if (!element) throw new Error(`No element found for selector: ${selector}`);
    try {
      await action(element);
    } finally {
      await element.dispose();
    }
  }
}

class PlaywrightBrowserSession implements BrowserSession {
  readonly page: CapturePage;
  private healthy = true;
  private readonly capturePage: PlaywrightCapturePage;

  constructor(
    private readonly context: BrowserContext,
    private readonly rawPage: Page,
    cdp: CDPSession,
    private readonly rawBrowser: Browser,
  ) {
    this.capturePage = new PlaywrightCapturePage(rawPage, cdp);
    this.page = this.capturePage;
    const markUnhealthy = () => (this.healthy = false);
    rawPage.on('crash', markUnhealthy);
    rawPage.on('close', markUnhealthy);
    context.on('close', markUnhealthy);
    cdp.on('close', markUnhealthy);
  }

  close() {
    return this.context.close();
  }

  isHealthy() {
    return this.healthy && !this.rawPage.isClosed() && this.rawBrowser.isConnected() && this.capturePage.isHealthy();
  }
}

class PlaywrightBrowserInstance implements BrowserInstance {
  constructor(
    private readonly rawBrowser: Browser,
    readonly executablePath: string,
  ) {}

  close() {
    return this.rawBrowser.close();
  }

  isHealthy() {
    return this.rawBrowser.isConnected();
  }

  async newSession(options?: BrowserSessionOptions) {
    const viewport = options?.viewport ?? { width: 800, height: 600 };
    const context = await this.rawBrowser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      ...(viewport.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: viewport.deviceScaleFactor }),
      ...(viewport.isMobile === undefined ? {} : { isMobile: viewport.isMobile }),
      ...(viewport.hasTouch === undefined ? {} : { hasTouch: viewport.hasTouch }),
    });
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
      } catch {
        await cdp.send('Performance.enable').catch(() => {});
      }
      return new PlaywrightBrowserSession(context, page, cdp, this.rawBrowser);
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }
}

export class PlaywrightBrowserBackend implements BrowserBackend {
  readonly name = 'playwright';

  constructor(private readonly dependencies: PlaywrightBackendDependencies = defaultDependencies) {}

  protected async locateChromium(options: BrowserRuntimeOptions) {
    const explicitPath = options.chromiumPath || options.launchOptions?.executablePath;
    if (explicitPath) return explicitPath;

    if (options.chromiumChannel && options.chromiumChannel !== '*') {
      const requested = await this.dependencies.findChrome({ channel: options.chromiumChannel });
      return requested.executablePath;
    }

    const managed = this.dependencies.managedExecutablePath();
    if (this.dependencies.canAccess(managed)) return managed;

    for (const channel of ['canary', 'stable'] as const) {
      const fallback = await this.dependencies.findChrome({ channel });
      if (fallback.executablePath) return fallback.executablePath;
    }
    return null;
  }

  async launch(options: BrowserRuntimeOptions): Promise<BrowserInstance> {
    const executablePath = await this.locateChromium(options);
    if (!executablePath) throw new ChromiumNotFoundError();

    const launchOptions = options.launchOptions ?? {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    };
    const browser = await this.dependencies.launch({
      ...(launchOptions.args ? { args: launchOptions.args } : {}),
      ...(launchOptions.headless === undefined ? {} : { headless: launchOptions.headless }),
      executablePath,
    });
    return new PlaywrightBrowserInstance(browser, executablePath);
  }
}

export const playwrightBrowserBackend = new PlaywrightBrowserBackend();
