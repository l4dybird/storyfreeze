import { fileURLToPath } from 'node:url';
import { PlaywrightRuntime, type BrowserConsoleMessage, type BrowserSessionOptions } from './playwright-runtime.js';
import type { Story } from './story.js';
import type { ManagedStorybookConnection } from './managed-storybook-connection.js';
import type { MainOptions } from './types.js';
import type { Exposed, StrictScreenshotOptions, VariantKey } from '../shared/types.js';
import {
  CaptureAttemptDidNotDrainError,
  InvalidCurrentStoryStateError,
  PreviewReadyTimeoutError,
  PreviewStateMismatchError,
} from './errors.js';
import {
  createBaseScreenshotOptions,
  extractVariantKeys,
  mergeScreenshotOptions,
  pickupWithVariantKey,
  variantKeyIdentifier,
  type InvalidVariantKeysReason,
} from '../shared/screenshot-options-helper.js';
import type { Logger } from './logger.js';
import { estimateScreenshotBufferReservation, type FileSystem } from './file.js';
import { ResourceWatcher } from './resource-watcher.js';
import { StoryNavigator } from './story-navigator.js';
import { CaptureDeadline } from './capture-deadline.js';
import {
  normalizeEmulationProfile,
  resolveViewport,
  sameEmulationClass,
  sameEmulationProfile,
  toViewport,
} from './emulation-profile.js';
import { raceAgainstTimeout } from './async-utils.js';
import { isWorkerSessionProtocolFault } from './worker-session-protocol.js';

const disableAnimationStylePath = fileURLToPath(new URL('../../assets/disable-animation.css', import.meta.url));
const maximumCapturesPerContext = 128;

interface ScreenshotResult {
  buffer: Buffer | null;
  succeeded: boolean;
  variantKeysToPush: VariantKey[];
  defaultVariantSuffix?: string;
}

/** One Playwright/Chromium process with one persistent managed Preview page. */
export class CapturingBrowser extends PlaywrightRuntime {
  private currentStory?: Story;
  private currentRetryCount = 0;
  private currentVariantKey: VariantKey = { isDefault: true, keys: [] };
  private viewport?: import('../shared/types.js').Viewport;
  private readonly baseScreenshotOptions: StrictScreenshotOptions;
  private resourceWatcher?: ResourceWatcher;
  private navigator?: StoryNavigator;
  private touched = false;
  private capturesInContext = 0;

  constructor(
    private readonly connection: ManagedStorybookConnection,
    protected opt: MainOptions,
    private readonly workerId: number,
  ) {
    super(opt);
    this.baseScreenshotOptions = createBaseScreenshotOptions(opt);
  }

  private debug(...args: unknown[]) {
    this.opt.logger.debug(`[cid: ${this.workerId}]`, ...args);
  }

  protected override prepareSessionOptions(sessionOptions?: BrowserSessionOptions) {
    const initialViewport =
      sessionOptions?.viewport ?? resolveViewport(this.baseScreenshotOptions.viewport, this.getDeviceDescriptors());
    return initialViewport ? { ...sessionOptions, viewport: initialViewport } : sessionOptions;
  }

  protected override async onBooted(sessionOptions?: BrowserSessionOptions) {
    this.viewport = sessionOptions?.viewport
      ? toViewport(normalizeEmulationProfile(sessionOptions.viewport))
      : resolveViewport(this.baseScreenshotOptions.viewport, this.getDeviceDescriptors());
    this.capturesInContext = 0;
    await this.expose();
    this.resourceWatcher = new ResourceWatcher(this.page).init();
    this.navigator = new StoryNavigator(this.page, new URL(this.connection.url), this.workerId);
  }

  protected override async onClosing() {
    const watcher = this.resourceWatcher;
    this.resourceWatcher = undefined;
    this.navigator = undefined;
    try {
      watcher?.dispose();
    } catch {
      // Browser cleanup remains authoritative when listener removal fails.
    }
  }

  private async expose() {
    const exposed: Exposed = {
      getBaseScreenshotOptions: () => this.baseScreenshotOptions,
      getCurrentVariantKey: () => this.currentVariantKey,
    };
    await Promise.all(Object.entries(exposed).map(([name, handler]) => this.page.exposeFunction(name, handler)));
  }

  private async addStyles() {
    if (this.opt.disableCssAnimation) await this.page.addStyleFile(disableAnimationStylePath);
  }

  private async setCurrentStory(story: Story, deadline: CaptureDeadline) {
    this.currentStory = story;
    this.debug('Set story', story.id);
    if (this.navigator!.canSelectStory) {
      await this.navigator!.selectStory(story.id);
    } else {
      await this.navigator!.navigate(story.id, deadline.navigationTimeout(), this.currentRetryCount);
      await this.addStyles();
    }
    const options = await this.navigator!.waitForReady(deadline.remaining(), deadline.signal);
    if (!(await this.navigator!.detectWorkerSessionSupport())) {
      throw new Error('StoryFreeze requires its managed persistent Preview protocol, but the addon is unavailable.');
    }
    return options;
  }

  private async restartCaptureContext(originalError?: unknown, sessionOptions?: BrowserSessionOptions) {
    this.currentStory = undefined;
    this.viewport = undefined;
    this.touched = false;
    try {
      await this.recreateContext(sessionOptions);
    } catch (restartError) {
      if (originalError !== undefined) {
        throw new AggregateError([originalError, restartError], 'Failed to restart the Playwright capture worker.');
      }
      throw restartError;
    }
  }

  private async recycleContextIfNeeded() {
    if (this.capturesInContext < maximumCapturesPerContext) return;
    await this.restartCaptureContext(undefined, this.viewport ? { viewport: this.viewport } : undefined);
  }

  private async setViewport(options: StrictScreenshotOptions, deadline: CaptureDeadline) {
    if (!this.currentStory) throw new InvalidCurrentStoryStateError();
    const resolved = resolveViewport(options.viewport, this.getDeviceDescriptors());
    if (!resolved) {
      this.opt.logger.warn(
        `Skip screenshot for ${this.opt.logger.color.yellow(JSON.stringify(this.currentStory))} because viewport ${this.opt.logger.color.magenta(String(options.viewport))} is unknown.`,
      );
      return false;
    }
    const nextProfile = normalizeEmulationProfile(resolved);
    const currentProfile = this.viewport ? normalizeEmulationProfile(this.viewport) : undefined;
    if (!currentProfile || !sameEmulationProfile(currentProfile, nextProfile)) {
      if (currentProfile && !sameEmulationClass(currentProfile, nextProfile)) {
        const story = this.currentStory;
        await this.restartCaptureContext(undefined, { viewport: resolved });
        await this.setCurrentStory(story, deadline);
      } else {
        await this.page.setViewport(resolved);
        this.viewport = resolved;
      }
    }
    return true;
  }

  private warnInvalidVariants(reason: InvalidVariantKeysReason | null) {
    if (!reason) return;
    if (reason.type === 'notFound') {
      this.opt.logger.warn(`Invalid variant '${reason.to}' in story ${this.currentStory!.id}.`);
    } else {
      this.opt.logger.warn(`Circular variants ${reason.refs.join(' -> ')} in story ${this.currentStory!.id}.`);
    }
  }

  private async warnIfMissing(selector: string) {
    if (this.currentStory && !(await this.page.elementExists(selector))) {
      this.opt.logger.warn(`No matched element for "${selector}" in story "${this.currentStory.id}".`);
    }
  }

  private async applyInteractions(options: StrictScreenshotOptions) {
    this.touched = false;
    if (options.hover) {
      await this.warnIfMissing(options.hover);
      await this.page.hover(options.hover);
      this.touched = true;
    }
    if (options.focus) {
      await this.warnIfMissing(options.focus);
      await this.page.focus(options.focus);
      this.touched = true;
    }
    if (options.click) {
      await this.warnIfMissing(options.click);
      await this.page.click(options.click);
      this.touched = true;
    }
  }

  private async waitForResources(options: StrictScreenshotOptions, deadline: CaptureDeadline) {
    if (!options.waitAssets && !options.waitImages) return;
    const result = await this.resourceWatcher!.waitForRequestsComplete({
      timeoutMs: deadline.remaining(3000),
      signal: deadline.signal,
    });
    if (result.didTimeout) {
      this.opt.logger.warn(`Resources did not settle within 3000 msec for story ${this.currentStory?.id}.`);
    }
  }

  private async interruptAttempt(attempt: Promise<unknown>) {
    const closing = this.discardContext();
    void closing.catch(() => {});
    const result = await raceAgainstTimeout(
      Promise.allSettled([attempt, closing]).then(() => undefined),
      1000,
    );
    return !result.timedOut;
  }

  async screenshot(
    requestId: string,
    story: Story,
    variantKey: VariantKey,
    retryCount: number,
    logger: Logger,
    forwardConsoleLogs: boolean,
    fileSystem: FileSystem,
  ): Promise<ScreenshotResult> {
    this.currentVariantKey = variantKey;
    this.currentRetryCount = retryCount;
    const deadline = new CaptureDeadline(this.opt.captureTimeout, requestId, this.opt.signal);
    let abandoned = false;
    let retainedBuffer: Buffer | null = null;
    const releaseAbandonedBuffer = () => {
      if (abandoned) fileSystem.releaseScreenshotBuffer(retainedBuffer);
    };
    const attempt = (async () => {
      await this.recycleContextIfNeeded();
      const result = await this.captureAttempt(
        requestId,
        story,
        variantKey,
        logger,
        forwardConsoleLogs,
        fileSystem,
        deadline,
      );
      if (result.buffer) this.capturesInContext += 1;
      retainedBuffer = result.buffer;
      releaseAbandonedBuffer();
      return result;
    })();

    try {
      return await Promise.race([attempt, deadline.interruption]);
    } catch (error) {
      abandoned = true;
      releaseAbandonedBuffer();
      const interrupted = deadline.signal.aborted || error instanceof PreviewReadyTimeoutError;
      if (interrupted) {
        const interruption = this.opt.signal?.aborted
          ? this.opt.signal.reason instanceof Error
            ? this.opt.signal.reason
            : new Error('StoryFreeze was interrupted.')
          : deadline.timeoutError;
        if (!(await this.interruptAttempt(attempt))) {
          throw new CaptureAttemptDidNotDrainError(
            'The interrupted capture did not stop after its browser context was closed.',
            interruption,
          );
        }
        if (!this.opt.signal?.aborted && retryCount < this.opt.captureMaxRetryCount) {
          this.opt.logger.warn(`${interruption.message} Retry to screenshot this story after this sequence.`);
          await this.boot();
          return { buffer: null, succeeded: false, variantKeysToPush: [] };
        }
        throw interruption;
      }

      const recoverable =
        retryCount < this.opt.captureMaxRetryCount &&
        !this.opt.signal?.aborted &&
        (!this.isSessionHealthy() || isWorkerSessionProtocolFault(error) || error instanceof PreviewStateMismatchError);
      if (!recoverable) throw error;
      await this.restartCaptureContext(error);
      return { buffer: null, succeeded: false, variantKeysToPush: [] };
    } finally {
      deadline.dispose();
    }
  }

  private async captureAttempt(
    requestId: string,
    story: Story,
    variantKey: VariantKey,
    logger: Logger,
    forwardConsoleLogs: boolean,
    fileSystem: FileSystem,
    deadline: CaptureDeadline,
  ): Promise<ScreenshotResult> {
    this.resourceWatcher!.clear();
    const unsubscribeConsole = this.page.subscribeConsole((message: BrowserConsoleMessage) => {
      const text = `From ${requestId} (${message.type}): ${message.text}`;
      if (!forwardConsoleLogs) logger.debug(text);
      else if (message.type === 'warning') logger.warn(text);
      else if (message.type === 'error') logger.error(text);
      else logger.log(text);
    });
    let buffer: Buffer | null = null;
    let result: ScreenshotResult | undefined;
    let attemptFailure: { error: unknown } | undefined;

    try {
      const emittedOptions = await this.setCurrentStory(story, deadline);
      const rootOptions = this.navigator!.rootOptions ?? emittedOptions;
      const mergedRoot = mergeScreenshotOptions(this.baseScreenshotOptions, rootOptions);
      const merged = mergeScreenshotOptions(
        this.baseScreenshotOptions,
        pickupWithVariantKey(mergedRoot, this.currentVariantKey),
      );
      const [invalidReason, variants] = extractVariantKeys(mergedRoot);
      this.warnInvalidVariants(invalidReason);
      const variantKeysToPush = this.currentVariantKey.isDefault ? variants : [];

      if (merged.skip) {
        await Promise.race([this.waitForDebugInput(), deadline.interruption]);
        result = { buffer: null, succeeded: true, variantKeysToPush, defaultVariantSuffix: '' };
      } else if (await this.setViewport(merged, deadline)) {
        await this.applyInteractions(merged);
        await this.waitForResources(merged, deadline);
        const visual = await this.page.waitForVisualCommit(
          { paintFallbackMs: 250, timeoutMs: deadline.remaining(3000) },
          deadline.signal,
        );
        if (visual.didTimeout) this.opt.logger.warn(`Visual commit timed out for story ${story.id}; capturing anyway.`);

        buffer = await this.page.screenshot(
          {
            fullPage: merged.fullPage,
            omitBackground: merged.omitBackground,
            captureBeyondViewport: merged.captureBeyondViewport,
            clip: merged.clip ?? undefined,
          },
          (dimensions, capture) =>
            fileSystem.captureScreenshot(estimateScreenshotBufferReservation(dimensions), capture, deadline.signal),
        );
        if (this.touched) {
          await this.page
            .resetPointer()
            .catch(error => this.debug('Pointer reset failed; remount will isolate state.', error));
          this.touched = false;
        }
        await Promise.race([this.waitForDebugInput(), deadline.interruption]);
        result = {
          buffer,
          succeeded: true,
          variantKeysToPush,
          defaultVariantSuffix: emittedOptions.defaultVariantSuffix,
        };
      } else {
        result = { buffer: null, succeeded: true, variantKeysToPush: [] };
      }
    } catch (error) {
      attemptFailure = { error };
    }

    let cleanupFailure: { error: unknown } | undefined;
    try {
      unsubscribeConsole();
    } catch (error) {
      cleanupFailure = { error };
    }
    try {
      await this.navigator?.completeCapture(variantKeyIdentifier(variantKey.keys));
    } catch (error) {
      cleanupFailure = cleanupFailure ? { error: new AggregateError([cleanupFailure.error, error]) } : { error };
    }
    if (attemptFailure || cleanupFailure) {
      fileSystem.releaseScreenshotBuffer(buffer);
      if (attemptFailure && cleanupFailure) {
        throw new AggregateError([attemptFailure.error, cleanupFailure.error], 'Capture and cleanup both failed.');
      }
      throw (attemptFailure ?? cleanupFailure)!.error;
    }
    return result!;
  }
}
