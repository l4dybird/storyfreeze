import fs from 'node:fs';
import {
  chromium,
  devices,
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
  ChromiumNotFoundError,
  type BrowserBackend,
  type BrowserConsoleMessage,
  type BrowserDeviceDescriptor,
  type BrowserInstance,
  type BrowserRequest,
  type BrowserRuntimeOptions,
  type BrowserSession,
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
  deviceDescriptors: typeof devices;
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
  deviceDescriptors: devices,
  findChrome,
  launch: options => chromium.launch(options),
  managedExecutablePath: () => chromium.executablePath(),
};

type CdpClient = {
  once(event: string, listener: (payload: unknown) => void): unknown;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

function asCdpClient(session: CDPSession): CdpClient {
  return session as unknown as CdpClient;
}

export class PlaywrightCapturePage implements CapturePage {
  private readonly requests = new WeakMap<Request, BrowserRequest>();
  private readonly cdp: CdpClient;
  private tracing = false;

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

  async screenshot(options: ScreenshotCaptureOptions) {
    await this.rawPage.bringToFront();
    if (options.omitBackground) {
      await this.cdp.send('Emulation.setDefaultBackgroundColorOverride', {
        color: { r: 0, g: 0, b: 0, a: 0 },
      });
    }

    try {
      let clip = options.clip ? { ...options.clip, scale: 1 } : undefined;
      if (options.fullPage) {
        const metrics = (await this.cdp.send('Page.getLayoutMetrics')) as {
          contentSize: { height: number; width: number };
          cssContentSize?: { height: number; width: number };
        };
        const contentSize = metrics.cssContentSize ?? metrics.contentSize;
        clip = {
          x: 0,
          y: 0,
          width: Math.ceil(contentSize.width),
          height: Math.ceil(contentSize.height),
          scale: 1,
        };
      }
      const result = (await this.cdp.send('Page.captureScreenshot', {
        format: 'png',
        ...(clip ? { clip } : {}),
        captureBeyondViewport: options.fullPage || (options.captureBeyondViewport ?? false),
      })) as { data: string };
      return Buffer.from(result.data, 'base64');
    } finally {
      if (options.omitBackground) {
        await this.cdp.send('Emulation.setDefaultBackgroundColorOverride');
      }
    }
  }

  async setViewport(viewport: Viewport) {
    await this.rawPage.setViewportSize({ width: viewport.width, height: viewport.height });
    const orientation = viewport.isLandscape
      ? { type: 'landscapePrimary', angle: 90 }
      : { type: 'portraitPrimary', angle: 0 };
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor || 1,
      mobile: viewport.isMobile ?? false,
      screenOrientation: orientation,
    });
    const hasTouch = viewport.hasTouch ?? false;
    await this.cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: hasTouch,
      ...(hasTouch ? { maxTouchPoints: 1 } : {}),
    });
  }

  async startTrace() {
    if (this.tracing) throw new Error('A Chromium trace is already running.');
    await this.cdp.send('Tracing.start', {
      categories: traceCategories,
      transferMode: 'ReturnAsStream',
    });
    this.tracing = true;
  }

  async stopTrace() {
    if (!this.tracing) throw new Error('A Chromium trace has not been started.');
    const completed = new Promise<{ stream?: string }>(resolve => {
      this.cdp.once('Tracing.tracingComplete', payload => resolve(payload as { stream?: string }));
    });
    await this.cdp.send('Tracing.end');
    this.tracing = false;
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
    return Buffer.concat(chunks);
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

  constructor(
    private readonly context: BrowserContext,
    rawPage: Page,
    cdp: CDPSession,
  ) {
    this.page = new PlaywrightCapturePage(rawPage, cdp);
  }

  close() {
    return this.context.close();
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

  async newSession() {
    const context = await this.rawBrowser.newContext({ viewport: { width: 800, height: 600 } });
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      return new PlaywrightBrowserSession(context, page, cdp);
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }
}

export class PlaywrightBrowserBackend implements BrowserBackend {
  readonly name = 'playwright';

  constructor(private readonly dependencies: PlaywrightBackendDependencies = defaultDependencies) {}

  devices(): readonly BrowserDeviceDescriptor[] {
    return Object.entries(this.dependencies.deviceDescriptors).map(([name, descriptor]) => ({
      name,
      viewport: {
        ...descriptor.viewport,
        deviceScaleFactor: descriptor.deviceScaleFactor,
        isMobile: descriptor.isMobile,
        hasTouch: descriptor.hasTouch,
      },
    }));
  }

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
