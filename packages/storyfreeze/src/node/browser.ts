import { sleep } from './async-utils.js';
import {
  type BrowserBackend,
  type BrowserInstance,
  type BrowserMetrics,
  type BrowserRuntimeOptions,
  type BrowserSession,
  type CapturePage,
} from './browser-backend.js';
import { puppeteerBrowserBackend } from './puppeteer-browser-backend.js';

export { ChromiumNotFoundError } from './browser-backend.js';
export type { ChromeChannel } from './browser-backend.js';
export { puppeteerBrowserBackend } from './puppeteer-browser-backend.js';
export type BaseBrowserOptions = BrowserRuntimeOptions;

export class BaseBrowser {
  private instance?: BrowserInstance;
  private session?: BrowserSession;
  private _executablePath = '';
  private debugInputResolver = () => {};
  private debugInputPromise: Promise<void> = Promise.resolve();

  constructor(
    protected opt: BaseBrowserOptions,
    protected readonly backend: BrowserBackend = puppeteerBrowserBackend,
  ) {}

  get page() {
    if (!this.session) throw new Error('The browser page is not available before boot completes.');
    return this.session.page;
  }

  get executablePath() {
    return this._executablePath;
  }

  protected getDeviceDescriptors() {
    return this.backend.devices();
  }

  async boot() {
    this.instance = await this.backend.launch(this.opt);
    this._executablePath = this.instance.executablePath;
    try {
      this.session = await this.instance.newSession();
      await this.setupDebugInput();
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    const session = this.session;
    const instance = this.instance;
    this.session = undefined;
    this.instance = undefined;

    try {
      await session?.close();
    } catch {
      // Page cleanup is best effort; still attempt browser cleanup below.
    }
    try {
      await sleep(50);
      await instance?.close();
    } catch {
      // Preserve disposal behavior: browser cleanup is best effort.
    }
  }

  protected async waitForDebugInput() {
    if (this.opt.launchOptions?.headless === false) {
      // oxlint-disable-next-line no-console
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
  private previous: BrowserMetrics[] = [];

  constructor(
    private readonly page: Pick<CapturePage, 'readMetrics'>,
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
    const current = await this.page.readMetrics();
    if (this.previous.length < this.length) return this.next(current);
    if (this.diff('nodes')) return this.next(current);
    if (this.diff('recalcStyleCount')) return this.next(current);
    if (this.diff('layoutCount')) return this.next(current);
    return true;
  }

  private diff(key: keyof BrowserMetrics) {
    for (let index = 1; index < this.previous.length; ++index) {
      if (this.previous[index][key] !== this.previous[0][key]) return true;
    }
    return false;
  }

  private next(metrics: BrowserMetrics) {
    this.previous.push(metrics);
    this.previous = this.previous.slice(-this.length);
    return false;
  }
}

export function getDeviceDescriptors() {
  return puppeteerBrowserBackend.devices();
}
