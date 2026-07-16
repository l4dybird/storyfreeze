/*
 * Portions of this file are derived from reg-viz/storycrawler.
 * Copyright (c) 2019 reg-viz. Licensed under the MIT License.
 * https://github.com/reg-viz/storycap/tree/master/packages/storycrawler
 */

import puppeteerCore, {
  type Browser,
  type BrowserLaunchArgumentOptions,
  type ConsoleMessage,
  type HTTPRequest,
  type LaunchOptions,
  type Page,
} from 'puppeteer-core';
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
  type BrowserLaunchOptions,
  type BrowserMetrics,
  type BrowserRequest,
  type BrowserRuntimeOptions,
  type BrowserSession,
  type BrowserSessionOptions,
  type CapturePage,
  type NavigationOptions,
  type RequestListeners,
  type ScreenshotCaptureOptions,
  type TraceSink,
} from './browser-backend.js';
import { findChrome, type FindChromeOptions } from './chromium-resolver.js';

export class PuppeteerCapturePage implements CapturePage {
  private readonly requests = new WeakMap<HTTPRequest, BrowserRequest>();
  private traceState: 'idle' | 'starting' | 'active' | 'stopping' | 'failed' = 'idle';
  private traceSink?: TraceSink;

  constructor(private readonly rawPage: Page) {}

  addStyleFile(path: string) {
    return this.rawPage.addStyleTag({ path }).then(() => {});
  }

  click(selector: string) {
    return this.rawPage.click(selector);
  }

  currentUrl() {
    return this.rawPage.url();
  }

  async elementExists(selector: string) {
    return Boolean(await this.rawPage.$(selector));
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

  exposeFunction<Arguments extends unknown[], Result>(
    name: string,
    fn: (...args: Arguments) => Result | Promise<Result>,
  ) {
    return this.rawPage.exposeFunction(name, fn as never);
  }

  focus(selector: string) {
    return this.rawPage.focus(selector);
  }

  async goto(url: string, options?: NavigationOptions) {
    await this.rawPage.goto(url, options);
  }

  hover(selector: string) {
    return this.rawPage.hover(selector);
  }

  async readMetrics(): Promise<BrowserMetrics> {
    const metrics = await this.rawPage.metrics();
    return {
      nodes: metrics.Nodes,
      recalcStyleCount: metrics.RecalcStyleCount,
      layoutCount: metrics.LayoutCount,
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
    const result = await this.rawPage.screenshot(options);
    return Buffer.isBuffer(result) ? result : null;
  }

  setViewport(viewport: Viewport) {
    return this.rawPage.setViewport(viewport);
  }

  async startTrace(sink: TraceSink) {
    if (this.traceState === 'failed') {
      throw new Error('The Chromium trace state is unavailable. Close the browser before tracing again.');
    }
    if (this.traceState !== 'idle') throw new Error('A Chromium trace is already running.');
    this.traceState = 'starting';
    try {
      await this.rawPage.tracing.start();
      this.traceSink = sink;
      this.traceState = 'active';
    } catch (error) {
      this.traceState = 'idle';
      this.traceSink = undefined;
      throw error;
    }
  }

  async stopTrace() {
    if (this.traceState !== 'active') throw new Error('A Chromium trace has not been started.');
    this.traceState = 'stopping';
    try {
      const trace = await this.rawPage.tracing.stop();
      if (trace) await this.traceSink!.write(trace);
      this.traceState = 'idle';
      this.traceSink = undefined;
    } catch (error) {
      this.traceState = 'failed';
      this.traceSink = undefined;
      throw error;
    }
  }

  subscribeConsole(listener: (message: BrowserConsoleMessage) => void) {
    const onConsole = (message: ConsoleMessage) => listener({ text: message.text(), type: message.type() });
    this.rawPage.on('console', onConsole);
    return () => this.rawPage.off('console', onConsole);
  }

  subscribeRequests(listeners: RequestListeners) {
    const toRequest = (request: HTTPRequest) => {
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
    const onRequest = (request: HTTPRequest) => listeners.started(toRequest(request));
    const onRequestComplete = (request: HTTPRequest) => {
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
}

class PuppeteerBrowserSession implements BrowserSession {
  readonly page: CapturePage;

  constructor(private readonly rawPage: Page) {
    this.page = new PuppeteerCapturePage(rawPage);
  }

  close() {
    return this.rawPage.close();
  }

  isHealthy() {
    return !this.rawPage.isClosed();
  }
}

class PuppeteerBrowserInstance implements BrowserInstance {
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

  async newSession(_options?: BrowserSessionOptions) {
    return new PuppeteerBrowserSession(await this.rawBrowser.newPage());
  }
}

export class PuppeteerBrowserBackend implements BrowserBackend {
  readonly name = 'puppeteer';

  protected locateChrome(options: FindChromeOptions) {
    return findChrome(options);
  }

  protected launchBrowser(options: LaunchOptions & BrowserLaunchArgumentOptions) {
    return puppeteerCore.launch(options);
  }

  async launch(options: BrowserRuntimeOptions): Promise<BrowserInstance> {
    const baseExecutablePath = options.chromiumPath || options.launchOptions?.executablePath;
    const { executablePath } = await this.locateChrome({
      executablePath: baseExecutablePath,
      channel: options.chromiumChannel,
    });
    if (!executablePath) throw new ChromiumNotFoundError();

    const launchOptions: BrowserLaunchOptions = options.launchOptions ?? { headless: true };
    const browser = await this.launchBrowser({
      ...launchOptions,
      executablePath,
    } as LaunchOptions & BrowserLaunchArgumentOptions);
    return new PuppeteerBrowserInstance(browser, executablePath);
  }
}

export const puppeteerBrowserBackend = new PuppeteerBrowserBackend();
