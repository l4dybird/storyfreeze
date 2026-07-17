import { fileURLToPath } from 'node:url';
import { BaseBrowser, MetricsWatcher } from './browser.js';
import type { BrowserBackend, BrowserConsoleMessage, BrowserSessionOptions } from './browser-backend.js';
import type { BrowserSessionSource } from './browser-process-coordinator.js';
import type { Story } from './story.js';
import type { ManagedStorybookConnection } from './managed-storybook-connection.js';

import type { MainOptions, RecyclingPolicy, RunMode } from './types.js';
import type {
  VariantKey,
  ScreenshotOptions,
  StrictScreenshotOptions,
  Exposed,
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
import { normalizeEmulationProfile, resolveViewport, sameEmulationProfile, toViewport } from './emulation-profile.js';
import type { PlannedCapture } from './capture-plan.js';
import { createCaptureId, deterministicSerialize, normalizeCaptureOptions } from './capture-manifest.js';
import type { PreviewRuntimeMetadata } from '../shared/preview-protocol.js';
import {
  classifyBatchEligibility,
  type CaptureProtocolMode,
  type SessionVariantExecutionResult,
  type SessionVariantRequest,
} from './story-session.js';
import { StorySessionProtocolClient } from './story-session-protocol.js';

export { resolveViewport } from './emulation-profile.js';

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

export function shouldRecycleContext(
  policy: RecyclingPolicy | undefined,
  capturesInContext: number,
  contextAgeMs: number,
) {
  if (!policy) return false;
  return (
    (policy.maxCapturesPerContext !== undefined &&
      policy.maxCapturesPerContext > 0 &&
      capturesInContext >= policy.maxCapturesPerContext) ||
    (policy.maxContextAgeMs !== undefined && policy.maxContextAgeMs > 0 && contextAgeMs >= policy.maxContextAgeMs)
  );
}

/**
 *
 * A worker to capture screenshot images.
 *
 **/
export class CapturingBrowser extends BaseBrowser {
  private _currentStory?: Story;
  private currentStoryRetryCount = 0;
  private viewport?: import('../shared/types.js').Viewport;
  private baseScreenshotOptions: StrictScreenshotOptions;
  private currentRequestId!: string;
  private currentVariantKey: VariantKey = { isDefault: true, keys: [] };
  private touched = false;
  private resourceWatcher?: ResourceWatcher;
  private navigator?: StoryNavigator;
  private diagnosticLastPhase?: string;
  private diagnosticOutcome: 'captured' | 'failed' | 'retry' | 'skipped' = 'failed';
  private activeDeadline?: CaptureDeadline;
  private contextStartedAt = 0;
  private capturesInContext = 0;
  private contextGeneration = 0;
  private rootScreenshotOptions?: ScreenshotOptions;
  private previewRuntimeMetadata?: PreviewRuntimeMetadata;

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
    const initialViewport =
      sessionOptions?.viewport ?? resolveViewport(this.baseScreenshotOptions.viewport, this.getDeviceDescriptors());
    await super.boot(initialViewport ? { ...sessionOptions, viewport: initialViewport } : sessionOptions);
    this.viewport = initialViewport ? toViewport(normalizeEmulationProfile(initialViewport)) : undefined;
    this.contextStartedAt = performance.now();
    this.capturesInContext = 0;
    this.contextGeneration += 1;
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
      const options = await this.measurePhase('preview-ready', () =>
        this.navigator!.waitForReady(deadline.remaining(), deadline.signal),
      );
      this.rootScreenshotOptions = this.navigator!.rootOptions ?? options;
      this.previewRuntimeMetadata = this.navigator!.runtimeMetadata;
      return options;
    }
    await this.measurePhase('preview-ready', () =>
      this.navigator!.waitForSimpleReady(deadline.remaining(), deadline.signal),
    );
    this.rootScreenshotOptions = this.baseScreenshotOptions;
    this.previewRuntimeMetadata = undefined;
    return undefined;
  }

  private async setViewport(opt: StrictScreenshotOptions, deadline: CaptureDeadline) {
    if (!this.currentStory) {
      throw new InvalidCurrentStoryStateError();
    }

    const resolvedViewport = resolveViewport(opt.viewport, this.getDeviceDescriptors());
    if (!resolvedViewport) {
      this.opt.logger.warn(
        `Skip screenshot for ${this.opt.logger.color.yellow(
          JSON.stringify(this.currentStory),
        )} because the viewport ${this.opt.logger.color.magenta(
          String(opt.viewport),
        )} is not registered in the StoryFreeze device registry.`,
      );
      return false;
    }

    // Sometimes, `page.screenshot` is completed before applying viewport unfortunately.
    // So we compare the current viewport with the next viewport and wait for `opt.viewportDelay` time if they are different.
    const nextProfile = normalizeEmulationProfile(resolvedViewport);
    const nextViewport = resolvedViewport;
    const currentProfile = this.viewport ? normalizeEmulationProfile(this.viewport) : undefined;
    if (!currentProfile || !sameEmulationProfile(currentProfile, nextProfile)) {
      this.debug('Change viewport', JSON.stringify(nextViewport));
      // Changing mobile or touch emulation requires a fresh Storybook navigation.
      const willBeReloaded =
        nextProfile.isMobile !== currentProfile?.isMobile || nextProfile.hasTouch !== currentProfile?.hasTouch;
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
        emitCaptureDiagnostic({
          type: 'viewport-triggered-navigation',
          planned: false,
          ...this.diagnosticContext(),
        });
        await this.setCurrentStory(this.currentStory, deadline);
        await deadline.wait(this.opt.viewportDelay);
      } else {
        await deadline.wait(this.opt.viewportDelay);
      }
    }

    return true;
  }

  private async applyPreNavigationProfile(plannedCapture: PlannedCapture | undefined, deadline: CaptureDeadline) {
    if (!plannedCapture || plannedCapture.executionMode === 'runtime-discovery') return;
    const nextViewport = toViewport(plannedCapture.profile);
    if (this.viewport && sameEmulationProfile(normalizeEmulationProfile(this.viewport), plannedCapture.profile)) return;

    const currentProfile = this.viewport ? normalizeEmulationProfile(this.viewport) : undefined;
    const expensiveSwitch =
      currentProfile !== undefined &&
      (plannedCapture.profile.isMobile !== currentProfile.isMobile ||
        plannedCapture.profile.hasTouch !== currentProfile.hasTouch);
    if (expensiveSwitch) {
      await this.page.goto('about:blank', {
        timeout: deadline.navigationTimeout(),
        waitUntil: 'domcontentloaded',
      });
    }
    await this.page.setViewport(nextViewport);
    this.viewport = nextViewport;
    await deadline.wait(this.opt.viewportDelay);
    emitCaptureDiagnostic({
      type: 'pre-navigation-profile',
      expensiveSwitch,
      executionMode: plannedCapture.executionMode,
      profile: plannedCapture.profile,
      ...this.diagnosticContext(),
    });
  }

  private validatePlannedCapture(plannedCapture: PlannedCapture | undefined, actual: StrictScreenshotOptions) {
    if (!plannedCapture || plannedCapture.executionMode !== 'runtime-validation') return;
    const normalized = normalizeCaptureOptions(actual, this.getDeviceDescriptors());
    const matches =
      normalized !== undefined && deterministicSerialize(normalized) === deterministicSerialize(plannedCapture.options);
    if (matches) return;
    emitCaptureDiagnostic({
      type: 'runtime-validation-mismatch',
      actualOptions: normalized,
      expectedOptions: plannedCapture.options,
      ...this.diagnosticContext(),
    });
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

  private async waitForResources(screenshotOptions: StrictScreenshotOptions, deadline: CaptureDeadline, quietMs = 100) {
    if (!screenshotOptions.waitAssets && !screenshotOptions.waitImages) return;
    const before = this.resourceWatcher!.getDiagnosticSnapshot();
    this.debug('Wait for requested resources resolved', this.resourceWatcher!.getRequestedUrls());
    const result = await this.resourceWatcher!.waitForRequestsComplete({
      quietMs,
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
      quietMs,
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
    this.rootScreenshotOptions = undefined;
    this.previewRuntimeMetadata = undefined;
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

  private async recycleContextIfNeeded() {
    const ageMs = this.contextStartedAt === 0 ? 0 : performance.now() - this.contextStartedAt;
    if (!shouldRecycleContext(this.opt.recyclingPolicy, this.capturesInContext, ageMs)) return;
    emitCaptureDiagnostic({
      type: 'context-recycle',
      ageMs,
      capturesInContext: this.capturesInContext,
      reason:
        this.opt.recyclingPolicy?.maxCapturesPerContext !== undefined &&
        this.capturesInContext >= this.opt.recyclingPolicy.maxCapturesPerContext
          ? 'capture-count'
          : 'context-age',
      ...this.diagnosticContext(),
    });
    await this.restartCaptureSession();
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
    plannedCapture?: PlannedCapture,
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
    let attempt: Promise<ScreenshotResult> | undefined;
    let attemptContextGeneration: number | undefined;

    try {
      await this.recycleContextIfNeeded();
      attemptContextGeneration = this.contextGeneration;
      attempt = this.screenshotAttempt(
        requestId,
        story,
        variantKey,
        logger,
        forwardConsoleLogs,
        trace,
        fileSystem,
        deadline,
        plannedCapture,
      );
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
        await Promise.allSettled([attempt ?? Promise.resolve(), closing]);
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
      if (attemptContextGeneration !== undefined && this.contextGeneration === attemptContextGeneration) {
        this.capturesInContext += 1;
      }
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
    plannedCapture?: PlannedCapture,
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

      await this.measurePhase('pre-navigation-viewport', () =>
        this.applyPreNavigationProfile(plannedCapture, deadline),
      );
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
      this.validatePlannedCapture(plannedCapture, mergedScreenshotOptions);

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

  private sessionRequestId(story: Story, variantKey: VariantKey) {
    const base = encodeURIComponent(story.id);
    return variantKey.keys.length ? `${base}?keys=${encodeURIComponent(variantKey.keys.join(','))}` : base;
  }

  private async resetStorySessionVariant(
    protocol: StorySessionProtocolClient,
    variantId: string,
    baseProfile: ReturnType<typeof normalizeEmulationProfile>,
    deadline: CaptureDeadline,
    requiresSettling: boolean,
  ) {
    if (this.touched) {
      await this.page.resetPointer();
      this.touched = false;
    }
    const currentProfile = this.viewport ? normalizeEmulationProfile(this.viewport) : undefined;
    if (!currentProfile || !sameEmulationProfile(currentProfile, baseProfile)) {
      const baseViewport = toViewport(baseProfile);
      await this.page.setViewport(baseViewport);
      this.viewport = baseViewport;
      await deadline.wait(this.opt.viewportDelay);
    }
    const verification = await protocol.resetVariant(variantId);
    const requests = await this.resourceWatcher!.waitForRequestsComplete({
      quietMs: requiresSettling ? 50 : 0,
      timeoutMs: deadline.remaining(3000),
      signal: deadline.signal,
    });
    const pendingRequestCount = requests.pending.length;
    const activeElementMismatch =
      verification.activeElementMatchesBaseline === undefined
        ? verification.activeElement !== null
        : !verification.activeElementMatchesBaseline;
    if (
      activeElementMismatch ||
      verification.pendingRequestCount !== 0 ||
      pendingRequestCount !== 0 ||
      (verification.argsHash !== undefined && verification.argsHash !== verification.baseArgsHash) ||
      (verification.globalsHash !== undefined && verification.globalsHash !== verification.baseGlobalsHash) ||
      (verification.rootFingerprint !== undefined && verification.rootFingerprint !== verification.baseRootFingerprint)
    ) {
      throw new Error(
        `Story session reset verification failed for ${variantId}: ${JSON.stringify({
          ...verification,
          pendingRequestCount,
        })}.`,
      );
    }
    await this.page.waitForVisualCommit({ paintFallbackMs: 250, timeoutMs: deadline.remaining(3000) }, deadline.signal);
  }

  private async captureStorySessionVariant(
    protocol: StorySessionProtocolClient,
    story: Story,
    request: SessionVariantRequest,
    options: StrictScreenshotOptions,
    baseProfile: ReturnType<typeof normalizeEmulationProfile>,
    logger: Logger,
    forwardConsoleLogs: boolean,
    trace: boolean,
    fileSystem: FileSystem,
  ): Promise<Buffer | null> {
    const variantId = request.variantKey.keys.join('/') || 'default';
    const requestId = this.sessionRequestId(story, request.variantKey);
    this.currentRequestId = requestId;
    this.currentVariantKey = request.variantKey;
    this.currentStoryRetryCount = 0;
    const deadline = new CaptureDeadline(this.opt.captureTimeout, requestId, this.opt.signal);
    this.activeDeadline = deadline;
    this.resourceWatcher!.clear();
    let traceFile: TraceFile | undefined;
    let traceStarted = false;
    let completed = false;
    const unsubscribeConsole = this.page.subscribeConsole(message => {
      const niceMessage = `From ${requestId} (${message.type}): ${message.text}`;
      if (!forwardConsoleLogs) logger.debug(niceMessage);
      else if (message.type === 'warning') logger.warn(niceMessage);
      else if (message.type === 'error') logger.error(niceMessage);
      else logger.log(niceMessage);
    });

    try {
      if (trace) {
        traceFile = await fileSystem.createTraceFile();
        await this.page.startTrace(traceFile);
        traceStarted = true;
      }
      await this.measurePhase('session-apply', () => protocol.applyVariant(variantId));
      if (options.skip) {
        await this.measurePhase('reset', () =>
          this.resetStorySessionVariant(protocol, variantId, baseProfile, deadline, false),
        );
        completed = true;
        return null;
      }
      const targetProfile = normalizeEmulationProfile(
        resolveViewport(options.viewport, this.getDeviceDescriptors()) ?? toViewport(baseProfile),
      );
      if (!sameEmulationProfile(baseProfile, targetProfile)) {
        if (
          targetProfile.deviceScaleFactor !== baseProfile.deviceScaleFactor ||
          targetProfile.isMobile !== baseProfile.isMobile ||
          targetProfile.hasTouch !== baseProfile.hasTouch ||
          targetProfile.isLandscape !== baseProfile.isLandscape
        ) {
          throw new Error(`Variant ${variantId} crosses an unsafe emulation boundary.`);
        }
        const viewport = toViewport(targetProfile);
        await this.measurePhase('viewport', async () => {
          await this.page.setViewport(viewport);
          this.viewport = viewport;
          await deadline.wait(this.opt.viewportDelay);
        });
      }

      await this.measurePhase('interaction', async () => {
        this.touched = false;
        await this.setHover(options);
        await this.setFocus(options);
        await this.setClick(options);
        await this.waitIfTouched(deadline);
        if (options.delay > 0) await deadline.wait(options.delay);
      });
      const requiresSettling = Boolean(options.click || this.previewRuntimeMetadata?.hasCustomReset);
      if (requiresSettling) {
        await this.measurePhase('resource', () => this.waitForResources(options, deadline));
        await this.measurePhase('metrics', () => this.waitBrowserMetricsStable('postEmit', deadline));
        await this.measurePhase('visual-commit', () =>
          this.page.waitForVisualCommit({ paintFallbackMs: 250, timeoutMs: deadline.remaining(3000) }, deadline.signal),
        );
      } else {
        // Passive CSS/screenshot mutations need a committed paint and any requests observed by then, but no quiet delay.
        await this.measurePhase('visual-commit', () =>
          this.page.waitForVisualCommit({ paintFallbackMs: 250, timeoutMs: deadline.remaining(3000) }, deadline.signal),
        );
        await this.measurePhase('resource', () => this.waitForResources(options, deadline, 0));
      }
      const buffer = await this.measurePhase('screenshot', () =>
        this.page.screenshot({
          fullPage: options.fullPage,
          omitBackground: options.omitBackground,
          captureBeyondViewport: options.captureBeyondViewport,
          clip: options.clip ?? undefined,
        }),
      );
      await this.measurePhase('reset', () =>
        this.resetStorySessionVariant(protocol, variantId, baseProfile, deadline, requiresSettling),
      );
      completed = true;
      return buffer;
    } finally {
      unsubscribeConsole();
      try {
        if (traceStarted) {
          await this.page.stopTrace();
          if (completed) {
            const logicalId = JSON.stringify({ storyId: story.id, variantKey: request.variantKey });
            await traceFile!.commit(story.kind, story.story, request.variantKey.keys, logicalId);
          }
        }
      } finally {
        await traceFile?.discard();
        deadline.dispose();
        if (this.activeDeadline === deadline) this.activeDeadline = undefined;
      }
    }
  }

  /** Captures eligible variants in the current Story document and returns unsafe or failed work to strict mode. */
  async screenshotSessionVariants(
    sessionId: string,
    story: Story,
    requests: SessionVariantRequest[],
    logger: Logger,
    forwardConsoleLogs: boolean,
    trace: boolean,
    fileSystem: FileSystem,
    protocolMode: Exclude<CaptureProtocolMode, 'strict'>,
  ): Promise<SessionVariantExecutionResult> {
    if (requests.length === 0) return { outputs: [], strictFallbacks: [] };
    if (this.currentStory?.id !== story.id || !this.rootScreenshotOptions || !this.viewport) {
      return { outputs: [], strictFallbacks: requests };
    }
    const rootOptions = mergeScreenshotOptions(
      this.baseScreenshotOptions,
      this.rootScreenshotOptions,
    ) as StrictScreenshotOptions;
    const normalizedRootOptions = normalizeCaptureOptions(rootOptions, this.getDeviceDescriptors());
    const baseEligibility = normalizedRootOptions
      ? classifyBatchEligibility(
          { options: normalizedRootOptions },
          { hasCustomReset: this.previewRuntimeMetadata?.hasCustomReset },
        )
      : { mode: 'strict' as const, reason: 'base viewport could not be normalized' };
    const unsafeBaseReason = this.previewRuntimeMetadata?.hasRuntimeWaitFor
      ? 'The base capture used a runtime waitFor function.'
      : baseEligibility.mode === 'strict'
        ? `The base capture is not reset-safe: ${baseEligibility.reason}.`
        : undefined;
    if (unsafeBaseReason) {
      const reason = unsafeBaseReason;
      const error = new Error(`${reason} A safe story session cannot be opened.`);
      if (protocolMode === 'story-session') throw error;
      await this.restartCaptureSession(error);
      return { outputs: [], strictFallbacks: requests };
    }

    const baseProfile = normalizeEmulationProfile(this.viewport);
    const eligible: Array<{ request: SessionVariantRequest; options: StrictScreenshotOptions }> = [];
    const strictFallbacks: SessionVariantRequest[] = [];
    const runtimeWaitForVariants = new Set(this.previewRuntimeMetadata?.runtimeWaitForVariants ?? []);

    for (const request of requests) {
      try {
        const selected = mergeScreenshotOptions(
          this.baseScreenshotOptions,
          pickupWithVariantKey(rootOptions, request.variantKey),
        );
        const normalized = normalizeCaptureOptions(selected, this.getDeviceDescriptors());
        const hasRuntimeWait = request.variantKey.keys.some(key => runtimeWaitForVariants.has(key));
        const targetProfile = normalized?.viewport;
        const eligibility = normalized
          ? classifyBatchEligibility(
              {
                options: normalized,
              },
              { hasCustomReset: this.previewRuntimeMetadata?.hasCustomReset },
            )
          : { mode: 'strict' as const, reason: 'viewport could not be normalized' };
        const unsafeProfile =
          !targetProfile ||
          targetProfile.deviceScaleFactor !== baseProfile.deviceScaleFactor ||
          targetProfile.isMobile !== baseProfile.isMobile ||
          targetProfile.hasTouch !== baseProfile.hasTouch ||
          targetProfile.isLandscape !== baseProfile.isLandscape;
        if (hasRuntimeWait || unsafeProfile || eligibility.mode === 'strict') {
          const reason = hasRuntimeWait
            ? 'runtime waitFor cannot be replayed safely'
            : unsafeProfile
              ? 'emulation class differs from the story session'
              : eligibility.mode === 'strict'
                ? eligibility.reason
                : 'unknown';
          if (protocolMode === 'story-session') {
            throw new Error(
              `Variant ${request.variantKey.keys.join('/')} is unsafe for story-session mode: ${reason}.`,
            );
          }
          strictFallbacks.push(request);
        } else {
          eligible.push({ request, options: selected });
        }
      } catch (error) {
        if (protocolMode === 'story-session') throw error;
        strictFallbacks.push(request);
      }
    }

    if (eligible.length === 0) return { outputs: [], strictFallbacks };
    const protocol = new StorySessionProtocolClient(this.page);
    const outputs: SessionVariantExecutionResult['outputs'] = [];
    try {
      await protocol.openSession({ sessionId, storyId: story.id, profile: baseProfile });
      const baselineDeadline = new CaptureDeadline(this.opt.captureTimeout, `${sessionId}:baseline`, this.opt.signal);
      try {
        await this.resetStorySessionVariant(protocol, '__base__', baseProfile, baselineDeadline, false);
      } finally {
        baselineDeadline.dispose();
      }
      for (let index = 0; index < eligible.length; index += 1) {
        const item = eligible[index];
        try {
          const startedAt = performance.now();
          const buffer = await this.captureStorySessionVariant(
            protocol,
            story,
            item.request,
            item.options,
            baseProfile,
            logger,
            forwardConsoleLogs,
            trace,
            fileSystem,
          );
          const durationMs = performance.now() - startedAt;
          outputs.push({ variantKey: item.request.variantKey, buffer, durationMs });
          emitCaptureDiagnostic({
            type: 'story-session-capture',
            durationMs,
            sessionId,
            storyId: story.id,
            variantKey: item.request.variantKey.keys,
          });
        } catch (error) {
          const remaining = eligible.slice(index).map(entry => entry.request);
          await protocol.closeSession().catch(() => {});
          if (protocolMode === 'story-session') throw error;
          await this.restartCaptureSession(error);
          return { outputs, strictFallbacks: [...strictFallbacks, ...remaining] };
        }
      }
      await protocol.closeSession();
      return { outputs, strictFallbacks };
    } catch (error) {
      await protocol.closeSession().catch(() => {});
      await this.restartCaptureSession(error);
      if (protocolMode === 'story-session') throw error;
      const completedIds = new Set(outputs.map(output => createCaptureId(story.id, output.variantKey.keys)));
      return {
        outputs,
        strictFallbacks: [
          ...strictFallbacks,
          ...eligible
            .map(item => item.request)
            .filter(item => !completedIds.has(createCaptureId(story.id, item.variantKey.keys))),
        ],
      };
    }
  }
}
