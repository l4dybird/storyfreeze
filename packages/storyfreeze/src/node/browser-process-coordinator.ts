import type {
  BrowserBackend,
  BrowserInstance,
  BrowserRuntimeOptions,
  BrowserSession,
  BrowserSessionOptions,
} from './browser-backend.js';
import { emitCaptureDiagnostic } from './capture-diagnostics.js';
import { raceAgainstTimeout } from './async-utils.js';

export interface BrowserSessionLease {
  readonly executablePath: string;
  readonly generation: number;
  readonly session: BrowserSession;
}

export interface BrowserSessionSource {
  close(): Promise<void>;
  isCurrent(generation: number): boolean;
  openSession(options?: BrowserSessionOptions): Promise<BrowserSessionLease>;
}

type BrowserGeneration = {
  readonly generation: number;
  readonly instance: BrowserInstance;
};

const closedMessage = 'The browser process coordinator is closed.';
const staleSessionCloseTimeoutMs = 1_000;

/**
 * Owns a single shared browser process and creates isolated sessions within it.
 * A disconnected process is replaced once even when several callers observe it
 * concurrently.
 */
export class BrowserProcessCoordinator implements BrowserSessionSource {
  private readonly instanceClosures = new WeakMap<BrowserInstance, Promise<void>>();
  private readonly closeController = new AbortController();
  private closed = false;
  private closePromise?: Promise<void>;
  private current?: BrowserGeneration;
  private generation = 0;
  private pinnedExecutablePath?: string;
  private replacementPromise?: Promise<void>;

  constructor(
    private readonly backend: BrowserBackend,
    private readonly runtimeOptions: BrowserRuntimeOptions,
  ) {}

  async openSession(options?: BrowserSessionOptions): Promise<BrowserSessionLease> {
    while (true) {
      const browser = await this.ensureHealthyInstance();
      let session: BrowserSession;
      const opening = Promise.resolve().then(() => browser.instance.newSession(options));
      try {
        const result = await raceAgainstTimeout(opening, Number.POSITIVE_INFINITY, this.closeController.signal);
        if (result.timedOut) throw new Error('Browser session opening timed out unexpectedly.');
        session = result.value;
      } catch (error) {
        if (this.closed) {
          void opening.then(
            lateSession => this.closeStaleSession(lateSession),
            () => undefined,
          );
          throw new Error(closedMessage);
        }
        if (!this.closed && (this.current !== browser || !browser.instance.isHealthy())) {
          await this.replaceInstance(browser.generation);
          continue;
        }
        throw error;
      }

      if (!this.closed && this.current === browser && browser.instance.isHealthy()) {
        return {
          executablePath: browser.instance.executablePath,
          generation: browser.generation,
          session,
        };
      }

      await this.closeStaleSession(session);
      if (this.closed) throw new Error(closedMessage);
      await this.replaceInstance(browser.generation);
    }
  }

  isCurrent(generation: number) {
    return !this.closed && this.current?.generation === generation && this.current.instance.isHealthy();
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closeController.abort(new Error(closedMessage));
    this.closePromise = this.closeCurrentInstance();
    return this.closePromise;
  }

  private async closeCurrentInstance() {
    // Closing marks the coordinator first, so a replacement that finishes late
    // will close its newly launched instance in performReplacement(). Do not
    // wait here: a backend launch that never settles must not deadlock runtime
    // disposal.
    if (this.replacementPromise) void this.replacementPromise.catch(() => {});
    const current = this.current;
    this.current = undefined;
    if (current) {
      await this.closeInstance(current.instance);
    }
  }

  private closeInstance(instance: BrowserInstance) {
    let closing = this.instanceClosures.get(instance);
    if (!closing) {
      closing = Promise.resolve()
        .then(() => raceAgainstTimeout(instance.close(), 5_000))
        .then(() => undefined);
      this.instanceClosures.set(instance, closing);
    }
    return closing;
  }

  private async closeStaleSession(session: BrowserSession) {
    await raceAgainstTimeout(
      Promise.resolve().then(() => session.close()),
      staleSessionCloseTimeoutMs,
    ).catch(() => {});
  }

  private async ensureHealthyInstance(): Promise<BrowserGeneration> {
    while (true) {
      if (this.closed) throw new Error(closedMessage);
      const current = this.current;
      if (current?.instance.isHealthy()) return current;
      await this.replaceInstance(current?.generation);
    }
  }

  private async replaceInstance(expectedGeneration?: number) {
    if (this.replacementPromise) {
      await this.replacementPromise;
      return;
    }

    const replacement = this.performReplacement(expectedGeneration);
    this.replacementPromise = replacement;
    try {
      await replacement;
    } finally {
      if (this.replacementPromise === replacement) this.replacementPromise = undefined;
    }
  }

  private async performReplacement(expectedGeneration?: number) {
    if (this.closed) throw new Error(closedMessage);

    const stale = this.current;
    if (stale?.generation !== expectedGeneration) return;
    if (stale?.instance.isHealthy()) return;

    this.current = undefined;
    if (stale) await this.closeInstance(stale.instance).catch(() => {});
    if (this.closed) throw new Error(closedMessage);

    const launching = Promise.resolve().then(() =>
      this.backend.launch(
        this.pinnedExecutablePath
          ? { ...this.runtimeOptions, chromiumPath: this.pinnedExecutablePath }
          : this.runtimeOptions,
      ),
    );
    let instance: BrowserInstance;
    try {
      const result = await raceAgainstTimeout(launching, Number.POSITIVE_INFINITY, this.closeController.signal);
      if (result.timedOut) throw new Error('Browser launch timed out unexpectedly.');
      instance = result.value;
    } catch (error) {
      if (this.closed) {
        void launching.then(
          lateInstance => this.closeInstance(lateInstance).catch(() => {}),
          () => undefined,
        );
        throw new Error(closedMessage);
      }
      throw error;
    }
    if (this.closed) {
      await this.closeInstance(instance).catch(() => {});
      throw new Error(closedMessage);
    }
    if (!instance.isHealthy()) {
      await this.closeInstance(instance).catch(() => {});
      throw new Error('The browser backend launched an unhealthy browser instance.');
    }

    emitCaptureDiagnostic({
      type: 'browser-launch',
      backend: this.backend.name,
      executablePath: instance.executablePath,
      source: 'coordinator',
    });

    this.pinnedExecutablePath ??= instance.executablePath;
    this.current = { generation: ++this.generation, instance };
  }
}
