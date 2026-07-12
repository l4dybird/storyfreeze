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
import { browserDeviceDescriptors } from './browser-device-registry.js';
import { captureDiagnosticsEnabled, emitCaptureDiagnostic } from './capture-diagnostics.js';

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
    private readonly closeDiagnosticContext: { role?: 'capture-worker' | 'story-index'; workerId?: number } = {},
  ) {}

  get page() {
    if (!this.session) throw new Error('The browser page is not available before boot completes.');
    return this.session.page;
  }

  get executablePath() {
    return this._executablePath;
  }

  protected getDeviceDescriptors() {
    return browserDeviceDescriptors;
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

    const sessionCloseStartedAt = captureDiagnosticsEnabled() ? performance.now() : 0;
    let sessionCloseError: unknown;
    try {
      await session?.close();
    } catch (error) {
      sessionCloseError = error;
      // Page cleanup is best effort; still attempt browser cleanup below.
    }
    const sessionCloseMs = captureDiagnosticsEnabled() ? performance.now() - sessionCloseStartedAt : 0;
    const processDrainStartedAt = captureDiagnosticsEnabled() ? performance.now() : 0;
    await sleep(50);
    const processDrainMs = captureDiagnosticsEnabled() ? performance.now() - processDrainStartedAt : 0;
    const browserCloseStartedAt = captureDiagnosticsEnabled() ? performance.now() : 0;
    let browserCloseError: unknown;
    try {
      await instance?.close();
    } catch (error) {
      browserCloseError = error;
      // Preserve disposal behavior: browser cleanup is best effort.
    }
    emitCaptureDiagnostic({
      type: 'browser-close',
      backend: this.backend.name,
      browserCloseMs: captureDiagnosticsEnabled() ? performance.now() - browserCloseStartedAt : 0,
      processDrainMs,
      sessionCloseMs,
      browserCloseError: browserCloseError instanceof Error ? browserCloseError.message : browserCloseError,
      sessionCloseError: sessionCloseError instanceof Error ? sessionCloseError.message : sessionCloseError,
      ...this.closeDiagnosticContext,
    });
  }

  protected async waitForDebugInput() {
    if (this.opt.launchOptions?.headless === false) {
      // oxlint-disable-next-line no-console
      console.log(
        'StoryFreeze waits for your input. Open the browser developer console and execute nextStep() to continue.',
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
  private _sampleCount = 0;

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

  get sampleCount() {
    return this._sampleCount;
  }

  get samples() {
    return [...this.previous];
  }

  private async check() {
    this._sampleCount += 1;
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
  return browserDeviceDescriptors;
}
