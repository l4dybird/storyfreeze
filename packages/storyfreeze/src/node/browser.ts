/*
 * Portions of this file are derived from reg-viz/storycrawler.
 * Copyright (c) 2019 reg-viz. Licensed under the MIT License.
 * https://github.com/reg-viz/storycap/tree/master/packages/storycrawler
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import puppeteerCore, {
  type Browser,
  type BrowserLaunchArgumentOptions,
  type LaunchOptions,
  type Metrics,
  type Page,
} from 'puppeteer-core';
import { sleep } from './async-utils.js';

const require = createRequire(import.meta.url);
const newLineRegex = /\r?\n/;

export type ChromeChannel = 'puppeteer' | 'canary' | 'stable' | '*';

export interface BaseBrowserOptions {
  launchOptions?: LaunchOptions & BrowserLaunchArgumentOptions;
  chromiumChannel?: ChromeChannel;
  chromiumPath?: string;
}

export class ChromiumNotFoundError extends Error {
  name = 'ChromiumNotFoundError';
}

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

export class BaseBrowser {
  private browser?: Browser;
  private _page?: Page;
  private _executablePath = '';
  private debugInputResolver = () => {};
  private debugInputPromise: Promise<void> = Promise.resolve();

  constructor(protected opt: BaseBrowserOptions) {}

  get page() {
    if (!this._page) throw new Error('The browser page is not available before boot completes.');
    return this._page;
  }

  get executablePath() {
    return this._executablePath;
  }

  protected locateChrome(options: FindChromeOptions) {
    return findChrome(options);
  }

  protected launchBrowser(options: LaunchOptions & BrowserLaunchArgumentOptions) {
    return puppeteerCore.launch(options);
  }

  async boot() {
    const baseExecutablePath = this.opt.chromiumPath || this.opt.launchOptions?.executablePath;
    const { executablePath } = await this.locateChrome({
      executablePath: baseExecutablePath,
      channel: this.opt.chromiumChannel,
    });
    if (!executablePath) throw new ChromiumNotFoundError();

    this._executablePath = executablePath;
    this.browser = await this.launchBrowser({
      ...(this.opt.launchOptions || {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true,
      }),
      executablePath,
    });
    try {
      this._page = await this.browser.newPage();
      await this.setupDebugInput();
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    const page = this._page;
    const browser = this.browser;
    this._page = undefined;
    this.browser = undefined;

    try {
      await page?.close();
    } catch {
      // Page cleanup is best effort; still attempt browser cleanup below.
    }
    try {
      await sleep(50);
      await browser?.close();
    } catch {
      // Preserve disposal behavior: browser cleanup is best effort.
    }
  }

  protected async waitForDebugInput() {
    if (this.opt.launchOptions?.headless === false) {
      // eslint-disable-next-line no-console
      console.log(
        'StoryFreeze waits for your input. Open Puppeteer devtool console and execute nextStep() to continue.',
      );
      await this.debugInputPromise;
    }
  }

  private async setupDebugInput() {
    if (this.opt.launchOptions?.headless === false) {
      const resetInput = () =>
        (this.debugInputPromise = new Promise<void>(resolve => (this.debugInputResolver = resolve)).then(() => {
          setTimeout(resetInput, 10);
        }));
      resetInput();
      await this.page.exposeFunction('nextStep', () => this.debugInputResolver());
    }
  }
}

export class MetricsWatcher {
  private readonly length = 3;
  private previous: Metrics[] = [];

  constructor(
    private readonly page: Page,
    private readonly count = 1000,
  ) {}

  async waitForStable() {
    for (let index = 0; index < this.count; ++index) {
      if (await this.check()) return index;
      await sleep(16);
    }
    return this.count;
  }

  private async check() {
    const current = await this.page.metrics();
    if (this.previous.length < this.length) return this.next(current);
    if (this.diff('Nodes')) return this.next(current);
    if (this.diff('RecalcStyleCount')) return this.next(current);
    if (this.diff('LayoutCount')) return this.next(current);
    return true;
  }

  private diff(key: 'Nodes' | 'RecalcStyleCount' | 'LayoutCount') {
    for (let index = 1; index < this.previous.length; ++index) {
      if (this.previous[index][key] !== this.previous[0][key]) return true;
    }
    return false;
  }

  private next(metrics: Metrics) {
    this.previous.push(metrics);
    this.previous = this.previous.slice(-this.length);
    return false;
  }
}

export function getDeviceDescriptors() {
  return Object.values(puppeteerCore.devices);
}
