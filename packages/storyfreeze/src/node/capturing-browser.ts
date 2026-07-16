import { fileURLToPath } from 'node:url';
import { BaseBrowser, MetricsWatcher } from './browser.js';
import type { BrowserBackend, BrowserConsoleMessage, BrowserSessionOptions } from './browser-backend.js';
import type { BrowserSessionSource } from './browser-process-coordinator.js';
import type { Story } from './story.js';
import type { ManagedStorybookConnection } from './managed-storybook-connection.js';

import type { MainOptions, RunMode } from './types.js';
import type {
  VariantKey,
  ScreenshotOptions,
  StrictScreenshotOptions,
  Exposed,
  Viewport,
  PreviewCaptureDiagnostic,
} from '../shared/types.js';
import { InvalidCurrentStoryStateError, PreviewReadyTimeoutError, SimplePreviewReadyTimeoutError } from './errors.js';
import {
  createBaseScreenshotOptions,
  mergeScreenshotOptions,
  extractVariantKeys,
  pickupWithVariantKey,
  type InvalidVariantKeysReason,
} from '../shared/screenshot-options-helper.js';
import { Logger } from './logger.js';
import { FileSystem, type TraceFile } from './file.js';
import { ResourceWatcher } from './resource-watcher.js';
import { StoryNavigator } from './story-navigator.js';
import { captureDiagnosticsEnabled, emitCaptureDiagnostic, measureCaptureDiagnostic } from './capture-diagnostics.js';
import { CaptureDeadline } from './capture-deadline.js';

/**
 *
 * Represents screenshot result.
 *
 * @remarks
 *
 * - If user's screenshot option has `skip: true`,`buffer` gets null and `succeeded` gets `true`
 * - `variantKeysToPush` is set an empty array if the capturing process is set not default variant key. It makes sense for only default variant.
 * - `defaultVariantSuffix` makes sense for only default variant too. It's set non-null value when user specifies multiple viewports.
 *
 **/
interface ScreenshotResult {
  buffer: Buffer | null;
  succeeded: boolean;
  variantKeysToPush: VariantKey[];
  defaultVariantSuffix?: string;
}

export function shouldWaitForVisualCommit(mode: RunMode, viewportChanged: boolean, touched: boolean) {
  return mode === 'simple' || viewportChanged || touched;
}

export function shouldRecoverPlaywrightWorker(options: {
  aborted: boolean;
  healthy: boolean;
  maxRetryCount: number;
  retryCount: number;
}) {
  return !options.aborted && !options.healthy && options.retryCount < options.maxRetryCount;
}

/**
 *
 * A worker to capture screenshot images.
 *
 **/
export class CapturingBrowser extends BaseBrowser {
  private _currentStory?: Story;
  private currentStoryRetryCount = 0;
  private viewport?: Viewport;
  private baseScreenshotOptions: StrictScreenshotOptions;
  private currentRequestId!: string;
  private currentVariantKey: VariantKey = { isDefault: true, keys: [] };
  private touched = false;
  private resourceWatcher?: ResourceWatcher;
  private navigator?: StoryNavigator;
  private diagnosticLastPhase?: string;
  private diagnosticOutcome: 'captured' | 'failed' | 'retry' | 'skipped' = 'failed';
  private activeDeadline?: CaptureDeadline;

  /**
   *
   * @override
   *
   * @param opt - Options for StoryFreeze.
   * @param mode - Indicates this worker runs as managed mode or simple mode.
   * @param idx - Worker id.
   *
   **/
  constructor(
    private readonly connection: ManagedStorybookConnection,
    protected opt: MainOptions,
    private mode: RunMode,
    private readonly idx: number,
    backend?: BrowserBackend,
    sessionSource?: BrowserSessionSource,
  ) {
    super(opt, backend, { role: 'capture-worker', workerId: idx }, sessionSource);
    this.baseScreenshotOptions = createBaseScreenshotOptions(opt);
  }

  get currentStory() {
    return this._currentStory;
  }

  private debug(...args: unknown[]) {
    this.opt.logger.debug(`[cid: ${this.idx}]`, ...args);
  }

  /**
   *
   * @override
   *
   **/
  async boot(sessionOptions?: BrowserSessionOptions) {
    await super.boot(sessionOptions);
    try {
      await this.expose();
      this.resourceWatcher = new ResourceWatcher(this.page);
      this.resourceWatcher.init();
      this.navigator = new StoryNavigator(this.page, new URL(this.connection.url), this.idx);
      return this;
    } catch (error) {
      try {
        await this.close();
      } catch {
        // Preserve the initialization error when cleanup also fails.
      }
      throw error;
    }
  }

  async close() {
    const resourceWatcher = this.resourceWatcher;
    this.resourceWatcher = undefined;
    this.navigator = undefined;
    resourceWatcher?.dispose();
    await super.close();
  }

  private async addStyles() {
    if (this.opt.disableCssAnimation) {
      await this.page.addStyleFile(fileURLToPath(new URL('../../assets/disable-animation.css', import.meta.url)));
    }
  }

  private async expose() {
    const exposed: Exposed = {
      getBaseScreenshotOptions: () => this.baseScreenshotOptions,
      getCurrentVariantKey: () => this.currentVariantKey,
      waitBrowserMetricsStable: () => this.waitBrowserMetricsStable('preEmit'),
    };
    const diagnosticExposure = captureDiagnosticsEnabled()
      ? { reportCaptureDiagnostic: (event: PreviewCaptureDiagnostic) => this.reportPreviewDiagnostic(event) }
      : {};
    await Promise.all(
      Object.entries({ ...exposed, ...diagnosticExposure }).map(([k, f]) => this.page.exposeFunction(k, f)),
    );
  }

  private diagnosticContext() {
    return {
      backend: this.backend.name,
      requestId: this.currentRequestId,
      storyId: this.currentStory?.id,
      variantKey: this.currentVariantKey.keys,
      workerId: this.idx,
      retryCount: this.currentStoryRetryCount,
    };
  }

  private reportPreviewDiagnostic(event: PreviewCaptureDiagnostic) {
    emitCaptureDiagnostic({
      ...event,
      ...this.diagnosticContext(),
      phase: 'preview-ready',
    });
  }

  private measurePhase<T>(phase: string, action: () => Promise<T>) {
    this.diagnosticLastPhase = phase;
    return measureCaptureDiagnostic({ type: 'capture-phase', phase, ...this.diagnosticContext() }, action);
  }

  private async waitIfTouched(deadline: CaptureDeadline) {
    if (!this.touched) return;
    await deadline.wait(this.opt.stateChangeDelay);
  }

  private async resetIfTouched() {
    if (!this.touched) return;
    this.debug('Reset browser input because page state got dirty in this request.', this.currentRequestId);

    try {
      await this.page.resetPointer();
    } catch (error) {
      this.debug('Failed to reset browser input after capturing. The next request will navigate afresh.', error);
    } finally {
      this.touched = false;
    }
  }

  private async setCurrentStory(story: Story, deadline: CaptureDeadline): Promise<ScreenshotOptions | undefined> {
    this._currentStory = story;
    this.debug('Set story', story.id);
    await this.measurePhase('navigation', async () => {
      await this.navigator!.navigate(story.id, deadline.navigationTimeout(), this.currentStoryRetryCount);
      await this.addStyles();
    });
    if (this.mode === 'managed') {
      return this.measurePhase('preview-ready', () =>
        this.navigator!.waitForReady(deadline.remaining(), deadline.signal),
      );
    }
    await this.measurePhase('preview-ready', () =>
      this.navigator!.waitForSimpleReady(deadline.remaining(), deadline.signal),
    );
    return undefined;
  }

  private async setViewport(opt: StrictScreenshotOptions, deadline: CaptureDeadline) {
    if (!this.currentStory) {
      throw new InvalidCurrentStoryStateError();
    }

    let nextViewport: Viewport;

    if (typeof opt.viewport === 'string') {
      if (opt.viewport.match(/^\d+$/)) {
        // For case such as `--viewport "800"`.
        nextViewport = { width: +opt.viewport, height: 600 };
      } else if (opt.viewport.match(/^\d+x\d+$/)) {
        // For case such as `--viewport "800x600"`.
        const [w, h] = opt.viewport.split('x');
        nextViewport = { width: +w, height: +h };
      } else {
        // Handle as a StoryFreeze device descriptor.
        const hit = this.getDeviceDescriptors().find(d => d.name === opt.viewport);
        if (!hit) {
          this.opt.logger.warn(
            `Skip screenshot for ${this.opt.logger.color.yellow(
              JSON.stringify(this.currentStory),
            )} because the viewport ${this.opt.logger.color.magenta(
              opt.viewport,
            )} is not registered in the StoryFreeze device registry.`,
          );
          return false;
        }
        nextViewport = hit.viewport;
      }
    } else {
      nextViewport = opt.viewport;
    }

    // Sometimes, `page.screenshot` is completed before applying viewport unfortunately.
    // So we compare the current viewport with the next viewport and wait for `opt.viewportDelay` time if they are different.
    if (!this.viewport || JSON.stringify(this.viewport) !== JSON.stringify(nextViewport)) {
      this.debug('Change viewport', JSON.stringify(nextViewport));
      // Changing mobile or touch emulation requires a fresh Storybook navigation.
      const willBeReloaded =
        nextViewport.isMobile !== this.viewport?.isMobile || nextViewport.hasTouch !== this.viewport?.hasTouch;
      if (willBeReloaded) {
        // Avoid racing emulation changes against Storybook's preview lifecycle.
        await this.page.goto('about:blank', {
          timeout: deadline.navigationTimeout(),
          waitUntil: 'domcontentloaded',
        });
      }
      await this.page.setViewport(nextViewport);
      this.viewport = nextViewport;
      if (willBeReloaded || this.opt.reloadAfterChangeViewport) {
        // Start a fresh owned request after the viewport has settled.
        await this.setCurrentStory(this.currentStory, deadline);
        await deadline.wait(this.opt.viewportDelay);
      } else {
        await deadline.wait(this.opt.viewportDelay);
      }
    }

    return true;
  }

  private async warnIfTargetElementNotFound(selector: string) {
    if (this.currentStory && !(await this.page.elementExists(selector))) {
      this.opt.logger.warn(
        `No matched element for "${this.opt.logger.color.yellow(selector)}" in story "${this.currentStory.id}".`,
      );
    }
  }

  private async setHover(screenshotOptions: StrictScreenshotOptions) {
    if (!screenshotOptions.hover) return;
    await this.warnIfTargetElementNotFound(screenshotOptions.hover);
    await this.page.hover(screenshotOptions.hover);
    this.touched = true;
    return;
  }

  private async setFocus(screenshotOptions: StrictScreenshotOptions) {
    if (!screenshotOptions.focus) return;
    await this.warnIfTargetElementNotFound(screenshotOptions.focus);
    await this.page.focus(screenshotOptions.focus);
    this.touched = true;
    return;
  }

  private async setClick(screenshotOptions: StrictScreenshotOptions) {
    if (!screenshotOptions.click) return;
    await this.warnIfTargetElementNotFound(screenshotOptions.click);
    await this.page.click(screenshotOptions.click);
    this.touched = true;
    return;
  }

  private async waitForResources(screenshotOptions: StrictScreenshotOptions, deadline: CaptureDeadline) {
    if (!screenshotOptions.waitAssets && !screenshotOptions.waitImages) return;
    const before = this.resourceWatcher!.getDiagnosticSnapshot();
    this.debug('Wait for requested resources resolved', this.resourceWatcher!.getRequestedUrls());
    const result = await this.resourceWatcher!.waitForRequestsComplete({
      quietMs: 100,
      timeoutMs: deadline.remaining(3000),
      signal: deadline.signal,
    });
    if (result.didTimeout) {
      this.opt.logger.warn(
        `Resources did not settle within 3000 msec. ${this.opt.logger.color.yellow(JSON.stringify(this.currentStory))}`,
      );
    }
    emitCaptureDiagnostic({
      type: 'resource-summary',
      before,
      after: this.resourceWatcher!.getDiagnosticSnapshot(),
      didTimeout: result.didTimeout,
      elapsedMs: result.elapsedMs,
      pending: result.pending,
      quietMs: 100,
      requestedUrlCount: result.requestedUrls.length,
      ...this.diagnosticContext(),
    });
  }

  private async waitBrowserMetricsStable(phase: 'preEmit' | 'postEmit', deadline = this.activeDeadline) {
    const mw = new MetricsWatcher(this.page, this.opt.metricsWatchRetryCount);
    const result = await mw.waitForStable({
      quietMs: 50,
      timeoutMs: deadline?.remaining(2000) ?? 2000,
      signal: deadline?.signal ?? this.opt.signal,
    });
    this.debug(`[${phase}] Browser metrics wait ended after ${result.sampleCount} checks (${result.reason}).`);
    if (!result.stable) {
      this.opt.logger.warn(
        `Metrics did not stabilize (${result.reason}) after ${result.sampleCount} checks. ${this.opt.logger.color.yellow(
          JSON.stringify(this.currentStory),
        )}`,
      );
    }
    emitCaptureDiagnostic({
      type: 'metrics-summary',
      phase,
      elapsedMs: result.elapsedMs,
      incompleteSampleCount: result.incompleteSampleCount,
      quietMs: 50,
      reason: result.reason,
      sampleCount: result.sampleCount,
      samples: result.samples,
      stable: result.stable,
      didTimeout: result.reason === 'wall-timeout',
      ...this.diagnosticContext(),
    });
  }

  private logInvalidVariantKeysReason(reason: InvalidVariantKeysReason | null) {
    if (reason) {
      if (reason.type === 'notFound') {
        this.opt.logger.warn(
          `Invalid variants. The variant key '${reason.to}' does not exist(story id: ${this.currentStory!.id}).`,
        );
      } else if (reason.type === 'circular') {
        this.opt.logger.warn(
          `Invalid variants. Reference ${reason.refs.join(' -> ')} is circular(story id: ${this.currentStory!.id}).`,
        );
      }
    }
  }

  private async recoverPlaywrightWorker(error: unknown) {
    const originalMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.opt.logger.warn(
      `Playwright browser session became unusable. Restarting this capture worker. ${originalMessage}`,
    );
    await this.restartCaptureSession(error);
  }

  private resetCaptureState() {
    this._currentStory = undefined;
    this.viewport = undefined;
    this.touched = false;
  }

  private async restartCaptureSession(originalError?: unknown) {
    await this.close();
    this.resetCaptureState();
    try {
      await this.boot();
    } catch (recoveryError) {
      if (originalError !== undefined) {
        throw new AggregateError([originalError, recoveryError], 'Failed to restart the Playwright capture worker.');
      }
      throw recoveryError;
    }
  }

  /**
   * Captures screenshot as a PNG image buffer from a story.
   *
   * @param requestId - Represents an identifier for the screenshot
   * @param variantKey - Variant identifier for the screenshot
   * @param retryCount - The number which represents how many attempting to capture this story and variant
   * @param logger - Logger instance
   * @param forwardConsoleLogs - Whether to forward logs from the page to the user's console
   * @param trace - Whether to record a CPU trace per screenshot
   *
   * @returns PNG buffer, whether the capturing process is succeeded or not, additional variant keys if they are emitted, and file name suffix for default the default variant.
   *
   * @remarks
   *
   * - Throws an error if `retryCount` is equal to `opt.captureMaxRetryCount` and this capturing process is failed
   *
   **/
  async screenshot(
    requestId: string,
    story: Story,
    variantKey: VariantKey,
    retryCount: number,
    logger: Logger,
    forwardConsoleLogs: boolean,
    trace: boolean,
    fileSystem: FileSystem,
  ): Promise<ScreenshotResult> {
    const captureStartedAt = captureDiagnosticsEnabled() ? performance.now() : 0;
    this.diagnosticLastPhase = undefined;
    this.diagnosticOutcome = 'failed';
    this.currentRequestId = requestId;
    this.currentVariantKey = variantKey;
    this.currentStoryRetryCount = retryCount;
    const attemptDiagnosticContext = { ...this.diagnosticContext(), storyId: story.id };
    const deadline = new CaptureDeadline(this.opt.captureTimeout, requestId, this.opt.signal);
    this.activeDeadline = deadline;
    const attempt = this.screenshotAttempt(
      requestId,
      story,
      variantKey,
      logger,
      forwardConsoleLogs,
      trace,
      fileSystem,
      deadline,
    );

    try {
      return await Promise.race([attempt, deadline.interruption]);
    } catch (error) {
      const captureError = error instanceof Error ? error : new Error(String(error));
      const previewTimedOut =
        error instanceof PreviewReadyTimeoutError || error instanceof SimplePreviewReadyTimeoutError;
      if (deadline.signal.aborted || previewTimedOut) {
        const interruptedByRun = this.opt.signal?.aborted ?? false;
        const interruptionError = interruptedByRun
          ? this.opt.signal!.reason instanceof Error
            ? this.opt.signal!.reason
            : new Error('StoryFreeze was interrupted.')
          : deadline.didTimeout
            ? deadline.timeoutError
            : captureError;
        const closing = this.close();
        await Promise.allSettled([attempt, closing]);
        this.resetCaptureState();

        if (!interruptedByRun && retryCount < this.opt.captureMaxRetryCount) {
          this.opt.logger.warn(`${interruptionError.message} Retry to screenshot this story after this sequence.`);
          try {
            await this.boot();
          } catch (recoveryError) {
            throw new AggregateError(
              [interruptionError, recoveryError],
              'Failed to restart a capture worker after its attempt timed out.',
            );
          }
          this.diagnosticOutcome = 'retry';
          return { buffer: null, succeeded: false, variantKeysToPush: [], defaultVariantSuffix: '' };
        }
        throw interruptionError;
      }
      const shouldRecover = shouldRecoverPlaywrightWorker({
        aborted: this.opt.signal?.aborted ?? false,
        healthy: this.isSessionHealthy(),
        maxRetryCount: this.opt.captureMaxRetryCount,
        retryCount: this.currentStoryRetryCount,
      });
      if (!shouldRecover) throw error;
      await this.recoverPlaywrightWorker(error);
      this.diagnosticOutcome = 'retry';
      return { buffer: null, succeeded: false, variantKeysToPush: [], defaultVariantSuffix: '' };
    } finally {
      deadline.dispose();
      if (this.activeDeadline === deadline) this.activeDeadline = undefined;
      emitCaptureDiagnostic({
        type: 'capture-complete',
        durationMs: captureDiagnosticsEnabled() ? performance.now() - captureStartedAt : 0,
        lastPhase: this.diagnosticLastPhase,
        outcome: this.diagnosticOutcome,
        ...attemptDiagnosticContext,
      });
    }
  }

  private async screenshotAttempt(
    requestId: string,
    story: Story,
    variantKey: VariantKey,
    logger: Logger,
    forwardConsoleLogs: boolean,
    trace: boolean,
    fileSystem: FileSystem,
    deadline: CaptureDeadline,
  ): Promise<ScreenshotResult> {
    let emittedScreenshotOptions: ScreenshotOptions | undefined;
    this.resourceWatcher!.clear();

    function onConsoleLog(msg: BrowserConsoleMessage) {
      const niceMessage = `From ${requestId} (${msg.type}): ${msg.text}`;

      if (forwardConsoleLogs) {
        switch (msg.type) {
          case 'warning':
            logger.warn(niceMessage);
            break;
          case 'error':
            logger.error(niceMessage);
            break;
          default:
            logger.log(niceMessage);
            break;
        }
      } else {
        logger.debug(niceMessage);
      }
    }

    const unsubscribeConsole = this.page.subscribeConsole(onConsoleLog);
    let traceStarted = false;
    let traceFile: TraceFile | undefined;
    // Capture this outside so it can be used for the filePath generation for the trace.
    let defaultVariantSuffix: string | undefined;

    try {
      if (trace) {
        traceFile = await fileSystem.createTraceFile();
        await this.page.startTrace(traceFile);
        traceStarted = true;
      }

      emittedScreenshotOptions = await this.setCurrentStory(story, deadline);

      if (this.mode === 'managed') {
        if (!this.currentStory) {
          throw new InvalidCurrentStoryStateError();
        }
        if (!emittedScreenshotOptions) {
          throw new InvalidCurrentStoryStateError();
        }
      } else {
        await deadline.wait(this.opt.delay);
        await this.waitBrowserMetricsStable('preEmit', deadline);
        // Use only `baseScreenshotOptions` when simple mode.
        emittedScreenshotOptions = pickupWithVariantKey(this.baseScreenshotOptions, this.currentVariantKey);
      }

      // Set defaultVariantSuffix as soon as it's known
      defaultVariantSuffix = emittedScreenshotOptions.defaultVariantSuffix;

      const mergedScreenshotOptions = mergeScreenshotOptions(this.baseScreenshotOptions, emittedScreenshotOptions);

      // Get keys for variants included in the screenshot options in order to queue capturing them after this sequence.
      const [invalidReason, keys] = extractVariantKeys(mergedScreenshotOptions);
      const variantKeysToPush = this.currentVariantKey.isDefault ? keys : [];
      this.logInvalidVariantKeysReason(invalidReason);

      // End this capturing process as success if `skip` set true.
      if (mergedScreenshotOptions.skip) {
        await Promise.race([this.waitForDebugInput(), deadline.interruption]);
        this.diagnosticOutcome = 'skipped';
        return { buffer: null, succeeded: true, variantKeysToPush, defaultVariantSuffix: '' };
      }

      this.touched = false;

      // Change browser's viewport if needed.
      const previousViewport = JSON.stringify(this.viewport);
      const vpChanged = await this.measurePhase('viewport', () => this.setViewport(mergedScreenshotOptions, deadline));
      // Skip to capture if the viewport option is invalid.
      if (!vpChanged) {
        this.diagnosticOutcome = 'skipped';
        return { buffer: null, succeeded: true, variantKeysToPush: [], defaultVariantSuffix: '' };
      }

      // Modify elements state.
      await this.measurePhase('interaction', async () => {
        await this.setHover(mergedScreenshotOptions);
        await this.setFocus(mergedScreenshotOptions);
        await this.setClick(mergedScreenshotOptions);
        await this.waitIfTouched(deadline);
      });

      // Wait until browser main thread gets stable.
      await this.measurePhase('resource', () => this.waitForResources(mergedScreenshotOptions, deadline));
      await this.measurePhase('metrics', () => this.waitBrowserMetricsStable('postEmit', deadline));

      const viewportChanged = previousViewport !== JSON.stringify(this.viewport);
      if (shouldWaitForVisualCommit(this.mode, viewportChanged, this.touched)) {
        await this.measurePhase('visual-commit', async () => {
          const visualCommitDiagnostic = await this.page.waitForVisualCommit(
            { paintFallbackMs: 250, timeoutMs: deadline.remaining(3000) },
            deadline.signal,
          );
          emitCaptureDiagnostic({
            type: 'visual-commit',
            phase: 'post-mutation',
            ...visualCommitDiagnostic,
            ...this.diagnosticContext(),
          });
        });
      }

      // Get PNG image buffer
      const captureOptions = emittedScreenshotOptions;
      const buffer = await this.measurePhase('screenshot', () =>
        this.page.screenshot({
          fullPage: captureOptions.fullPage,
          omitBackground: captureOptions.omitBackground,
          captureBeyondViewport: captureOptions.captureBeyondViewport,
          clip: captureOptions.clip ?? undefined,
        }),
      );

      // We should reset elements state(e.g. focusing, hovering, clicking) for future screenshot for this story.
      await this.measurePhase('reset', () => this.resetIfTouched());

      await Promise.race([this.waitForDebugInput(), deadline.interruption]);

      this.diagnosticOutcome = 'captured';

      return {
        buffer,
        succeeded: true,
        variantKeysToPush,
        defaultVariantSuffix,
      };
    } finally {
      unsubscribeConsole();

      try {
        if (traceStarted) {
          await this.measurePhase('trace-flush', async () => {
            await this.page.stopTrace();
            const suffix = variantKey.isDefault && defaultVariantSuffix ? [defaultVariantSuffix] : variantKey.keys;
            const logicalId = JSON.stringify({ storyId: story.id, variantKey });
            await traceFile!.commit(story.kind, story.story, suffix, logicalId);
          });
        }
      } finally {
        await traceFile?.discard();
      }
    }
  }
}
