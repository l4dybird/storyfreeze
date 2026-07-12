/*
 * Portions of this file are derived from reg-viz/storycrawler.
 * Copyright (c) 2019 reg-viz. Licensed under the MIT License.
 * https://github.com/reg-viz/storycap/tree/master/packages/storycrawler
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
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
  ChromiumNotFoundError,
  type BrowserBackend,
  type BrowserConsoleMessage,
  type BrowserInstance,
  type BrowserLaunchOptions,
  type BrowserMetrics,
  type BrowserRequest,
  type BrowserRuntimeOptions,
  type BrowserSession,
  type CapturePage,
  type ChromeChannel,
  type NavigationOptions,
  type RequestListeners,
  type ScreenshotCaptureOptions,
} from './browser-backend.js';

const require = createRequire(import.meta.url);
const newLineRegex = /\r?\n/;

export type FindChromeOptions = {
  executablePath?: string;
  channel?: ChromeChannel;
};

export type FindChromeResult =
  | { executablePath: string; type: 'user' | 'puppeteer' | 'canary' | 'stable' }
  | { executablePath: null; type: null };

function canAccess(file: string | undefined): file is string {
  if (!file) return false;
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function findChromeExecutables(folder: string) {
  const argumentsRegex = /(^[^ ]+).*/;
  const chromeExecRegex = '^Exec=/.*/(google-chrome|chrome|chromium)-.*';
  const installations: string[] = [];

  if (canAccess(folder)) {
    let execPaths: Buffer;
    try {
      execPaths = execSync(`grep -ER "${chromeExecRegex}" ${folder} | awk -F '=' '{print $2}'`);
    } catch {
      try {
        execPaths = execSync(`grep -Er "${chromeExecRegex}" ${folder} | awk -F '=' '{print $2}'`);
      } catch {
        return installations;
      }
    }
    execPaths
      .toString()
      .split(newLineRegex)
      .map(execPath => execPath.replace(argumentsRegex, '$1'))
      .forEach(execPath => canAccess(execPath) && installations.push(execPath));
  }

  return installations;
}

function sortInstallations(installations: string[], priorities: Array<{ regex: RegExp; weight: number }>) {
  const defaultPriority = 10;
  return installations
    .map(installation => {
      const priority = priorities.find(pair => pair.regex.test(installation));
      return { path: installation, weight: priority?.weight ?? defaultPriority };
    })
    .sort((a, b) => b.weight - a.weight)
    .map(pair => pair.path);
}

function localPuppeteer() {
  try {
    require.resolve('puppeteer');
    const puppeteer = require('puppeteer') as { executablePath(): string };
    const executablePath = puppeteer.executablePath();
    return canAccess(executablePath) ? executablePath : undefined;
  } catch {
    return undefined;
  }
}

function findDarwinChrome(canary = false) {
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework' +
    '/Versions/A/Frameworks/LaunchServices.framework' +
    '/Versions/A/Support/lsregister';
  const grepExpression = canary ? 'google chrome canary' : 'google chrome';
  const paths = execSync(`${lsregister} -dump  | grep -i \'${grepExpression}\\?.app$\' | awk \'{$1=""; print $0}\'`)
    .toString()
    .split(newLineRegex)
    .filter(Boolean)
    .map(value => value.trim());

  paths.unshift(canary ? '/Applications/Google Chrome Canary.app' : '/Applications/Google Chrome.app');
  for (const applicationPath of paths) {
    if (applicationPath.startsWith('/Volumes')) continue;
    const executablePath = path.join(
      applicationPath,
      canary ? '/Contents/MacOS/Google Chrome Canary' : '/Contents/MacOS/Google Chrome',
    );
    if (canAccess(executablePath)) return executablePath;
  }
  return undefined;
}

function findLinuxChrome() {
  if (canAccess(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  let installations: string[] = [];
  const desktopInstallationFolders = [
    path.join(os.homedir(), '.local/share/applications/'),
    '/usr/share/applications/',
  ];
  desktopInstallationFolders.forEach(folder => {
    installations = installations.concat(findChromeExecutables(folder));
  });

  ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium'].forEach(executable => {
    try {
      const executablePath = execFileSync('which', [executable], { stdio: 'pipe' }).toString().split(newLineRegex)[0];
      if (canAccess(executablePath)) installations.push(executablePath);
    } catch {
      // Not installed.
    }
  });

  if (installations.length === 0) return undefined;

  const priorities = [
    { regex: /chrome-wrapper$/, weight: 51 },
    { regex: /google-chrome-stable$/, weight: 50 },
    { regex: /google-chrome$/, weight: 49 },
    { regex: /chromium-browser$/, weight: 48 },
    { regex: /chromium$/, weight: 47 },
  ];
  return sortInstallations([...new Set(installations.filter(Boolean))], priorities)[0];
}

function findWindowsChrome(canary = false) {
  const suffix = canary
    ? `${path.sep}Google${path.sep}Chrome SxS${path.sep}Application${path.sep}chrome.exe`
    : `${path.sep}Google${path.sep}Chrome${path.sep}Application${path.sep}chrome.exe`;
  const prefixes = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(
    (value): value is string => Boolean(value),
  );
  let result: string | undefined;
  prefixes.forEach(prefix => {
    const executablePath = path.join(prefix, suffix);
    if (canAccess(executablePath)) result = executablePath;
  });
  return result;
}

function findInstalledChrome(canary: boolean) {
  try {
    // Chrome Canary is not distributed for Linux; let the '*' channel continue to stable.
    if (process.platform === 'linux') return canary ? undefined : findLinuxChrome();
    if (process.platform === 'win32') return findWindowsChrome(canary);
    if (process.platform === 'darwin') return findDarwinChrome(canary);
    return undefined;
  } catch {
    return undefined;
  }
}

export async function findChrome(options: FindChromeOptions): Promise<FindChromeResult> {
  if (options.executablePath) return { executablePath: options.executablePath, type: 'user' };

  const channels = new Set<ChromeChannel>(options.channel ? [options.channel] : ['*']);
  if (channels.has('puppeteer') || channels.has('*')) {
    const executablePath = localPuppeteer();
    if (executablePath) return { executablePath, type: 'puppeteer' };
  }
  if (channels.has('canary') || channels.has('*')) {
    const executablePath = findInstalledChrome(true);
    if (executablePath) return { executablePath, type: 'canary' };
  }
  if (channels.has('stable') || channels.has('*')) {
    const executablePath = findInstalledChrome(false);
    if (executablePath) return { executablePath, type: 'stable' };
  }
  return { executablePath: null, type: null };
}

export class PuppeteerCapturePage implements CapturePage {
  private readonly requests = new WeakMap<HTTPRequest, BrowserRequest>();
  private traceState: 'idle' | 'starting' | 'active' | 'stopping' | 'failed' = 'idle';

  constructor(private readonly rawPage: Page) {}

  addStyleFile(path: string) {
    return this.rawPage.addStyleTag({ path }).then(() => {});
  }

  blur(selector: string) {
    return this.rawPage.$eval(selector, (element: unknown) => (element as HTMLElement)?.blur());
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

  async screenshot(options: ScreenshotCaptureOptions) {
    const result = await this.rawPage.screenshot(options);
    return Buffer.isBuffer(result) ? result : null;
  }

  setViewport(viewport: Viewport) {
    return this.rawPage.setViewport(viewport);
  }

  async startTrace() {
    if (this.traceState === 'failed') {
      throw new Error('The Chromium trace state is unavailable. Close the browser before tracing again.');
    }
    if (this.traceState !== 'idle') throw new Error('A Chromium trace is already running.');
    this.traceState = 'starting';
    try {
      await this.rawPage.tracing.start();
      this.traceState = 'active';
    } catch (error) {
      this.traceState = 'idle';
      throw error;
    }
  }

  async stopTrace() {
    if (this.traceState !== 'active') throw new Error('A Chromium trace has not been started.');
    this.traceState = 'stopping';
    try {
      const trace = await this.rawPage.tracing.stop();
      this.traceState = 'idle';
      return trace;
    } catch (error) {
      this.traceState = 'failed';
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
}

class PuppeteerBrowserInstance implements BrowserInstance {
  constructor(
    private readonly rawBrowser: Browser,
    readonly executablePath: string,
  ) {}

  close() {
    return this.rawBrowser.close();
  }

  async newSession() {
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

    const launchOptions: BrowserLaunchOptions = options.launchOptions ?? {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    };
    const browser = await this.launchBrowser({
      ...launchOptions,
      executablePath,
    } as LaunchOptions & BrowserLaunchArgumentOptions);
    return new PuppeteerBrowserInstance(browser, executablePath);
  }
}

export const puppeteerBrowserBackend = new PuppeteerBrowserBackend();
