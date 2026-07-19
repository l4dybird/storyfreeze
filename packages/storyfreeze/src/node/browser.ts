import { raceAgainstTimeout, type TimeoutRaceResult } from './async-utils.js';
import {
  type BrowserBackend,
  type BrowserInstance,
  type BrowserRuntimeOptions,
  type BrowserSession,
  type BrowserSessionOptions,
} from './browser-backend.js';
import type { BrowserSessionSource } from './browser-process-coordinator.js';
import { browserDeviceDescriptors } from './browser-device-registry.js';
import { captureDiagnosticsEnabled, emitCaptureDiagnostic } from './capture-diagnostics.js';
import { lazyPlaywrightBrowserBackend } from './playwright-backend-loader.js';

export { ChromiumNotFoundError } from './browser-backend.js';
export type { ChromeChannel } from './browser-backend.js';
export type BaseBrowserOptions = BrowserRuntimeOptions;

const sessionCloseTimeoutMs = 1_000;
const browserCloseTimeoutMs = 5_000;

export class BaseBrowser {
  private readonly instanceClosures = new WeakMap<BrowserInstance, Promise<TimeoutRaceResult<void>>>();
  private readonly sessionClosures = new WeakMap<BrowserSession, Promise<TimeoutRaceResult<void>>>();
  private instance?: BrowserInstance;
  private session?: BrowserSession;
  private sessionGeneration?: number;
  private bootPromise?: Promise<this>;
  private closePromise?: Promise<void>;
  private lifecycleGeneration = 0;
  private _executablePath = '';
  private debugInputResolver = () => {};
  private debugInputPromise?: Promise<void>;

  constructor(
    protected opt: BaseBrowserOptions,
    protected readonly backend: BrowserBackend = lazyPlaywrightBrowserBackend,
    private readonly closeDiagnosticContext: { role?: 'capture-worker' | 'story-index'; workerId?: number } = {},
    private readonly sessionSource?: BrowserSessionSource,
  ) {}

  get page() {
    if (!this.session) throw new Error('The browser page is not available before boot completes.');
    return this.session.page;
  }

  get executablePath() {
    return this._executablePath;
  }

  protected isSessionHealthy() {
    return (
      (this.session?.isHealthy() ?? false) &&
      (this.sessionSource === undefined ||
        (this.sessionGeneration !== undefined && this.sessionSource.isCurrent(this.sessionGeneration)))
    );
  }

  protected getDeviceDescriptors() {
    return browserDeviceDescriptors;
  }

  async boot(sessionOptions?: BrowserSessionOptions): Promise<this> {
    if (this.closePromise) await this.closePromise;
    if (this.session) return this;
    if (this.bootPromise) return this.bootPromise;

    const preparedOptions = this.prepareSessionOptions(sessionOptions);
    const boot = this.performBoot(preparedOptions, this.lifecycleGeneration);
    this.bootPromise = boot;
    try {
      return await boot;
    } finally {
      if (this.bootPromise === boot) this.bootPromise = undefined;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycleGeneration += 1;
    const close = this.performClose();
    this.closePromise = close;
    const clear = () => {
      if (this.closePromise === close) this.closePromise = undefined;
    };
    void close.then(clear, clear);
    return close;
  }

  protected prepareSessionOptions(sessionOptions?: BrowserSessionOptions): BrowserSessionOptions | undefined {
    return sessionOptions;
  }

  protected async onBooted(_sessionOptions?: BrowserSessionOptions): Promise<void> {}

  protected async onClosing(): Promise<void> {}

  private async performBoot(
    sessionOptions: BrowserSessionOptions | undefined,
    lifecycleGeneration: number,
  ): Promise<this> {
    let instance: BrowserInstance | undefined;
    let session: BrowserSession | undefined;
    let sessionGeneration: number | undefined;
    let executablePath = '';
    try {
      if (this.sessionSource) {
        const lease = await this.sessionSource.openSession(sessionOptions);
        session = lease.session;
        sessionGeneration = lease.generation;
        executablePath = lease.executablePath;
      } else {
        instance = await this.backend.launch(this.opt);
        if (lifecycleGeneration !== this.lifecycleGeneration) {
          throw new Error('Browser boot was superseded by a close request.');
        }
        // Publish a partially launched direct instance so close() can interrupt
        // a backend whose new-session operation never settles.
        this.instance = instance;
        executablePath = instance.executablePath;
        emitCaptureDiagnostic({
          type: 'browser-launch',
          backend: this.backend.name,
          executablePath,
          source: 'direct',
          ...this.closeDiagnosticContext,
        });
        session = await instance.newSession(sessionOptions);
      }

      if (lifecycleGeneration !== this.lifecycleGeneration) {
        throw new Error('Browser boot was superseded by a close request.');
      }
      this.instance = instance;
      this.session = session;
      this.sessionGeneration = sessionGeneration;
      this._executablePath = executablePath;
      await this.setupDebugInput();
      await this.onBooted(sessionOptions);
      if (lifecycleGeneration !== this.lifecycleGeneration) {
        throw new Error('Browser boot was superseded by a close request.');
      }
      emitCaptureDiagnostic({
        type: 'browser-session-open',
        backend: this.backend.name,
        executablePath,
        source: this.sessionSource ? 'coordinator' : 'direct',
        ...this.closeDiagnosticContext,
      });
      return this;
    } catch (error) {
      this.instance = undefined;
      this.session = undefined;
      this.sessionGeneration = undefined;
      this._executablePath = '';
      try {
        await this.onClosing();
      } catch {
        // Partial subclass setup must not prevent browser cleanup.
      }
      await Promise.allSettled([
        session ? this.closeSession(session) : undefined,
        instance ? this.closeInstance(instance) : undefined,
      ]);
      throw error;
    }
  }

  private closeSession(session: BrowserSession) {
    let closing = this.sessionClosures.get(session);
    if (!closing) {
      closing = Promise.resolve().then(() => raceAgainstTimeout(session.close(), sessionCloseTimeoutMs));
      this.sessionClosures.set(session, closing);
    }
    return closing;
  }

  private closeInstance(instance: BrowserInstance) {
    let closing = this.instanceClosures.get(instance);
    if (!closing) {
      closing = Promise.resolve().then(() => raceAgainstTimeout(instance.close(), browserCloseTimeoutMs));
      this.instanceClosures.set(instance, closing);
    }
    return closing;
  }

  private async performClose() {
    const session = this.session;
    const instance = this.instance;
    this.session = undefined;
    this.sessionGeneration = undefined;
    this.instance = undefined;
    this._executablePath = '';
    this.debugInputResolver();
    this.debugInputResolver = () => {};
    this.debugInputPromise = undefined;

    try {
      await this.onClosing();
    } catch {
      // Subclass cleanup is best effort; browser resources still need to close.
    }

    if (!session && !instance) return;

    const sessionCloseStartedAt = captureDiagnosticsEnabled() ? performance.now() : 0;
    let sessionCloseError: unknown;
    try {
      if (session) {
        const result = await this.closeSession(session);
        if (result.timedOut)
          sessionCloseError = new Error(`Browser session close exceeded ${sessionCloseTimeoutMs} msec.`);
      }
    } catch (error) {
      sessionCloseError = error;
      // Page cleanup is best effort; still attempt browser cleanup below.
    }
    const sessionCloseMs = captureDiagnosticsEnabled() ? performance.now() - sessionCloseStartedAt : 0;
    const browserCloseStartedAt = captureDiagnosticsEnabled() ? performance.now() : 0;
    let browserCloseError: unknown;
    try {
      if (instance) {
        const result = await this.closeInstance(instance);
        if (result.timedOut) browserCloseError = new Error(`Browser close exceeded ${browserCloseTimeoutMs} msec.`);
      }
    } catch (error) {
      browserCloseError = error;
      // Preserve disposal behavior: browser cleanup is best effort.
    }
    emitCaptureDiagnostic({
      type: 'browser-close',
      backend: this.backend.name,
      browserCloseMs: captureDiagnosticsEnabled() && instance ? performance.now() - browserCloseStartedAt : 0,
      processDrainMs: 0,
      sessionCloseMs,
      browserCloseError: browserCloseError instanceof Error ? browserCloseError.message : browserCloseError,
      sessionCloseError: sessionCloseError instanceof Error ? sessionCloseError.message : sessionCloseError,
      ...this.closeDiagnosticContext,
    });
  }

  protected async waitForDebugInput() {
    if (this.opt.launchOptions?.headless === false) {
      this.debugInputPromise ??= new Promise<void>(resolve => {
        this.debugInputResolver = () => {
          this.debugInputResolver = () => {};
          this.debugInputPromise = undefined;
          resolve();
        };
      });
      const waitForInput = this.debugInputPromise;
      try {
        await this.page.activate();
      } catch (error) {
        this.debugInputResolver();
        throw error;
      }
      // oxlint-disable-next-line no-console
      console.log(
        'StoryFreeze waits for your input. Open the browser developer console and execute nextStep() to continue.',
      );
      await waitForInput;
    }
  }

  private async setupDebugInput() {
    if (this.opt.launchOptions?.headless === false) {
      await this.page.exposeFunction('nextStep', () => this.debugInputResolver());
    }
  }
}

export function getDeviceDescriptors() {
  return browserDeviceDescriptors;
}
