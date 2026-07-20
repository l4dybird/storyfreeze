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
import { browserDeviceDescriptors } from './browser-device-registry.js';
import { findChrome, type ChromeChannel } from './chromium-resolver.js';

export class ChromiumNotFoundError extends Error {
  name = 'ChromiumNotFoundError';
}

export type BrowserLaunchOptions = {
  args?: string[];
  executablePath?: string;
  headless?: boolean;
  timeout?: number;
  [key: string]: unknown;
};

const defaultBrowserLaunchTimeoutMs = 30_000;

export interface PlaywrightRuntimeOptions {
  launchOptions?: BrowserLaunchOptions;
  chromiumChannel?: ChromeChannel;
  chromiumPath?: string;
}

export interface BrowserSessionOptions {
  viewport?: Viewport;
}

export interface BrowserRequest {
  resourceType: string;
  url: string;
}

export interface BrowserConsoleMessage {
  text: string;
  type: string;
}

export interface ScreenshotCaptureDimensions {
  deviceScaleFactor: number;
  height: number;
  width: number;
}

type ScreenshotCapture = (
  dimensions: ScreenshotCaptureDimensions | undefined,
  capture: () => Promise<Buffer | null>,
) => Promise<Buffer | null>;

export interface RequestListeners {
  finished(request: BrowserRequest): void;
  started(request: BrowserRequest): void;
}

type CdpClient = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

const styleFileContents = new Map<string, Promise<string>>();

function readStyleFile(filePath: string) {
  let content = styleFileContents.get(filePath);
  if (!content) {
    content = fs.promises.readFile(filePath, 'utf8');
    styleFileContents.set(filePath, content);
    void content.catch(() => styleFileContents.delete(filePath));
  }
  return content;
}

/** The only page implementation used by the production capture runtime. */
export class PlaywrightCapturePage {
  private readonly requests = new WeakMap<Request, BrowserRequest>();
  private readonly cdp: CdpClient;
  private viewport?: Viewport;

  constructor(
    private readonly rawPage: Page,
    rawCdp: CDPSession,
    initialViewport?: Viewport,
  ) {
    this.cdp = rawCdp as unknown as CdpClient;
    this.viewport = initialViewport ? { ...initialViewport } : undefined;
  }

  isHealthy() {
    return !this.rawPage.isClosed();
  }

  async activate() {
    await this.rawPage.bringToFront();
  }

  async addStyleFile(filePath: string) {
    await this.rawPage.addStyleTag({ content: await readStyleFile(filePath) });
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

  async goto(url: string, options?: { timeout?: number; waitUntil?: 'domcontentloaded' }) {
    await this.rawPage.goto(url, options);
  }

  hover(selector: string) {
    return this.withElement(selector, element => element.hover());
  }

  async resetPointer() {
    await this.rawPage.mouse.move(0, 0);
  }

  waitForVisualCommit(options: VisualCommitOptions, signal?: AbortSignal) {
    return waitForVisualCommitWithAbort(this.rawPage.evaluate(waitForVisualCommitInPage, options), signal);
  }

  async screenshot(
    options: {
      captureBeyondViewport?: boolean;
      clip?: { x: number; y: number; width: number; height: number };
      fullPage?: boolean;
      omitBackground?: boolean;
    },
    captureWithBudget?: ScreenshotCapture,
  ) {
    if (options.clip && options.fullPage) throw new Error('options.clip and options.fullPage are exclusive');
    if (options.clip) {
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        if (typeof options.clip[key] !== 'number') throw new TypeError(`Expected options.clip.${key} to be a number`);
      }
      if (options.clip.width === 0) throw new Error('Expected options.clip.width not to be 0.');
      if (options.clip.height === 0) throw new Error('Expected options.clip.height not to be 0.');
    }

    const captureBeyondViewport = options.captureBeyondViewport ?? true;
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
    let captureFailure: { error: unknown } | undefined;
    let buffer: Buffer | null | undefined;

    try {
      if (options.fullPage) {
        const metrics = (await this.cdp.send('Page.getLayoutMetrics')) as {
          contentSize: { height: number; width: number };
        };
        clip = {
          x: 0,
          y: 0,
          width: Math.ceil(metrics.contentSize.width),
          height: Math.ceil(metrics.contentSize.height),
          scale: 1,
        };
        if (!captureBeyondViewport && this.viewport) {
          viewportOverridden = true;
          await this.applyDeviceMetrics({ ...this.viewport, width: clip.width, height: clip.height });
        }
      }
      if (options.omitBackground) {
        backgroundOverridden = true;
        await this.cdp.send('Emulation.setDefaultBackgroundColorOverride', {
          color: { r: 0, g: 0, b: 0, a: 0 },
        });
      }
      const dimensions = clip
        ? { width: clip.width, height: clip.height, deviceScaleFactor: this.viewport?.deviceScaleFactor || 1 }
        : this.viewport
          ? {
              width: this.viewport.width,
              height: this.viewport.height,
              deviceScaleFactor: this.viewport.deviceScaleFactor || 1,
            }
          : undefined;
      const capture = async () => {
        const result = (await this.cdp.send('Page.captureScreenshot', {
          format: 'png',
          ...(clip ? { clip } : {}),
          captureBeyondViewport,
        })) as { data: string };
        return Buffer.from(result.data, 'base64');
      };
      buffer = captureWithBudget ? await captureWithBudget(dimensions, capture) : await capture();
    } catch (error) {
      captureFailure = { error };
    }

    const cleanupErrors: unknown[] = [];
    if (backgroundOverridden) {
      await this.cdp.send('Emulation.setDefaultBackgroundColorOverride').catch(error => cleanupErrors.push(error));
    }
    if (viewportOverridden && this.viewport) {
      await this.applyDeviceMetrics(this.viewport).catch(error => cleanupErrors.push(error));
    }
    if (captureFailure && cleanupErrors.length) {
      throw new AggregateError(
        [captureFailure.error, ...cleanupErrors],
        'Screenshot and emulation cleanup both failed.',
      );
    }
    if (captureFailure) throw captureFailure.error;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Screenshot emulation cleanup failed.');
    return buffer!;
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

  subscribeConsole(listener: (message: BrowserConsoleMessage) => void) {
    const onConsole = (message: ConsoleMessage) => listener({ text: message.text(), type: message.type() });
    this.rawPage.on('console', onConsole);
    return () => this.rawPage.off('console', onConsole);
  }

  subscribeRequests(listeners: RequestListeners) {
    const normalize = (request: Request) => {
      let value = this.requests.get(request);
      if (!value) {
        value = { resourceType: request.resourceType(), url: request.url() };
        this.requests.set(request, value);
      }
      return value;
    };
    const started = (request: Request) => listeners.started(normalize(request));
    const finished = (request: Request) => {
      listeners.finished(normalize(request));
      this.requests.delete(request);
    };
    this.rawPage.on('request', started);
    this.rawPage.on('requestfinished', finished);
    this.rawPage.on('requestfailed', finished);
    return () => {
      this.rawPage.off('request', started);
      this.rawPage.off('requestfinished', finished);
      this.rawPage.off('requestfailed', finished);
    };
  }

  private applyDeviceMetrics(viewport: Viewport) {
    const isLandscape = viewport.isLandscape ?? viewport.width > viewport.height;
    return this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor || 1,
      mobile: viewport.isMobile ?? false,
      screenOrientation: isLandscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
    });
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

/** Owns exactly one Chromium process and its current context/page generation. */
export class PlaywrightRuntime {
  private browser?: Browser;
  private context?: BrowserContext;
  private capturePage?: PlaywrightCapturePage;
  private bootPromise?: Promise<this>;
  private closePromise?: Promise<void>;
  private lifecycleGeneration = 0;
  private _executablePath = '';
  private debugInputResolver = () => {};
  private debugInputPromise?: Promise<void>;

  constructor(protected readonly opt: PlaywrightRuntimeOptions) {}

  get page() {
    if (!this.capturePage) throw new Error('The Playwright page is unavailable before boot completes.');
    return this.capturePage;
  }

  get executablePath() {
    return this._executablePath;
  }

  protected getDeviceDescriptors() {
    return browserDeviceDescriptors;
  }

  protected prepareSessionOptions(options?: BrowserSessionOptions): BrowserSessionOptions | undefined {
    return options;
  }

  protected async onBooted(_options?: BrowserSessionOptions): Promise<void> {}

  protected async onClosing(): Promise<void> {}

  protected isSessionHealthy() {
    return Boolean(this.browser?.isConnected() && this.capturePage?.isHealthy());
  }

  async boot(options?: BrowserSessionOptions, signal?: AbortSignal): Promise<this> {
    if (signal?.aborted) throw this.abortReason(signal);
    if (this.closePromise) await this.closePromise;
    if (this.capturePage) return this;
    if (!this.bootPromise) {
      const generation = this.lifecycleGeneration;
      const boot = this.performBoot(this.prepareSessionOptions(options), generation);
      this.bootPromise = boot;
      const clear = () => {
        if (this.bootPromise === boot) this.bootPromise = undefined;
      };
      void boot.then(clear, clear);
    }
    return this.waitForBoot(this.bootPromise, signal);
  }

  protected async recreateContext(options?: BrowserSessionOptions) {
    const prepared = this.prepareSessionOptions(options);
    await this.closeContext();
    if (!this.browser?.isConnected()) {
      await this.close();
      await this.boot(prepared);
      return;
    }
    try {
      await this.openContext(prepared, this.lifecycleGeneration);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Closes only the current context so an interrupted page operation cannot outlive its attempt. */
  protected discardContext() {
    return this.closeContext();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycleGeneration += 1;
    const closing = this.performClose(this.bootPromise);
    this.closePromise = closing;
    const clear = () => {
      if (this.closePromise === closing) this.closePromise = undefined;
    };
    void closing.then(clear, clear);
    return closing;
  }

  protected async waitForDebugInput() {
    if (this.opt.launchOptions?.headless !== false) return;
    this.debugInputPromise ??= new Promise<void>(resolve => {
      this.debugInputResolver = () => {
        this.debugInputResolver = () => {};
        this.debugInputPromise = undefined;
        resolve();
      };
    });
    await this.page.activate();
    // oxlint-disable-next-line no-console
    console.log('StoryFreeze waits for input. Execute nextStep() in the browser developer console.');
    await this.debugInputPromise;
  }

  private async performBoot(options: BrowserSessionOptions | undefined, generation: number) {
    try {
      if (this.browser?.isConnected()) {
        await this.openContext(options, generation);
        return this;
      }
      const executablePath = await this.locateChromium();
      if (!executablePath) throw new ChromiumNotFoundError();
      const configuredTimeout = this.opt.launchOptions?.timeout;
      const timeout =
        typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > 0
          ? Math.min(configuredTimeout, defaultBrowserLaunchTimeoutMs)
          : defaultBrowserLaunchTimeoutMs;
      this.browser = await chromium.launch({
        chromiumSandbox: true,
        headless: true,
        ...this.opt.launchOptions,
        executablePath,
        timeout,
      } as Parameters<typeof chromium.launch>[0]);
      this._executablePath = executablePath;
      if (generation !== this.lifecycleGeneration) throw new Error('Browser boot was superseded by close.');
      await this.openContext(options, generation);
      return this;
    } catch (error) {
      await this.cleanupResources();
      throw error;
    }
  }

  private async openContext(options: BrowserSessionOptions | undefined, generation: number) {
    const browser = this.browser;
    if (!browser) throw new Error('Chromium must be launched before opening a context.');
    const viewport = options?.viewport ?? { width: 800, height: 600 };
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      ...(viewport.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: viewport.deviceScaleFactor }),
      ...(viewport.isMobile === undefined ? {} : { isMobile: viewport.isMobile }),
      ...(viewport.hasTouch === undefined ? {} : { hasTouch: viewport.hasTouch }),
    });
    this.context = context;
    try {
      const rawPage = await context.newPage();
      const cdp = await context.newCDPSession(rawPage);
      const page = new PlaywrightCapturePage(rawPage, cdp, viewport);
      await page.setViewport(viewport);
      this.capturePage = page;
      if (this.opt.launchOptions?.headless === false) {
        await page.exposeFunction('nextStep', () => this.debugInputResolver());
      }
      await this.onBooted(options);
      if (generation !== this.lifecycleGeneration) throw new Error('Context boot was superseded by close.');
    } catch (error) {
      this.capturePage = undefined;
      this.context = undefined;
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  private async closeContext() {
    const context = this.context;
    this.context = undefined;
    this.capturePage = undefined;
    this.debugInputResolver();
    this.debugInputResolver = () => {};
    this.debugInputPromise = undefined;
    await this.onClosing().catch(() => undefined);
    await context?.close().catch(() => undefined);
  }

  private async cleanupResources() {
    const browser = this.browser;
    this.browser = undefined;
    this._executablePath = '';
    await this.closeContext();
    await browser?.close().catch(() => undefined);
  }

  private async performClose(activeBoot?: Promise<this>) {
    await this.cleanupResources();
    if (!activeBoot) return;
    await activeBoot.catch(() => undefined);
    await this.cleanupResources();
  }

  private abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new Error('Browser boot was interrupted.');
  }

  private waitForBoot(boot: Promise<this>, signal?: AbortSignal): Promise<this> {
    if (!signal) return boot;
    if (signal.aborted) {
      void this.close().catch(() => undefined);
      return Promise.reject(this.abortReason(signal));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        void this.close().catch(() => undefined);
        reject(this.abortReason(signal));
      };
      const finish = (action: () => void) => {
        signal.removeEventListener('abort', onAbort);
        action();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      boot.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error)),
      );
    });
  }

  private async locateChromium() {
    const explicit = this.opt.chromiumPath || this.opt.launchOptions?.executablePath;
    if (explicit) return explicit;
    if (this.opt.chromiumChannel && this.opt.chromiumChannel !== '*') {
      return (await findChrome({ channel: this.opt.chromiumChannel })).executablePath;
    }
    const managed = chromium.executablePath();
    if (fs.existsSync(managed)) return managed;
    for (const channel of ['canary', 'stable'] as const) {
      const result = await findChrome({ channel });
      if (result.executablePath) return result.executablePath;
    }
    return null;
  }
}
