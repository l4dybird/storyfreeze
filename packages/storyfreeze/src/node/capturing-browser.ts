import { fileURLToPath } from 'node:url';
import { BaseBrowser, MetricsWatcher } from './browser.js';
import type { BrowserBackend, BrowserConsoleMessage } from './browser-backend.js';
import { sleep } from './async-utils.js';
import type { Story } from './story.js';
import type { ManagedStorybookConnection } from './managed-storybook-connection.js';

import type { MainOptions, RunMode } from './types.js';
import type { VariantKey, ScreenshotOptions, StrictScreenshotOptions, Exposed, Viewport } from '../shared/types.js';
import { InvalidCurrentStoryStateError, PreviewReadyTimeoutError } from './errors.js';
import {
  createBaseScreenshotOptions,
  mergeScreenshotOptions,
  extractVariantKeys,
  pickupWithVariantKey,
  type InvalidVariantKeysReason,
} from '../shared/screenshot-options-helper.js';
import { Logger } from './logger.js';
import { FileSystem } from './file.js';
import { ResourceWatcher } from './resource-watcher.js';
import { StoryNavigator } from './story-navigator.js';

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
  private navigator!: StoryNavigator;

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
  ) {
    super(opt, backend);
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
  async boot() {
    await super.boot();
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
    await Promise.all(Object.entries(exposed).map(([k, f]) => this.page.exposeFunction(k, f)));
  }

  private async waitIfTouched() {
    if (!this.touched) return;
    await sleep(this.opt.stateChangeDelay);
  }

  private async resetIfTouched(screenshotOptions: StrictScreenshotOptions) {
    const story = this.currentStory;
    if (!this.touched || !story) return;
    this.debug('Reset story because page state got dirty in this request.', this.currentRequestId);

    // Clear the browser's mouse state.
    if (screenshotOptions.click) {
      await this.page.blur(screenshotOptions.click);
    }
    if (screenshotOptions.focus) {
      await this.page.blur(screenshotOptions.focus);
    }
    await this.page.resetPointer();

    await this.setCurrentStory(story);
    this.touched = false;

    return;
  }

  private async setCurrentStory(story: Story): Promise<ScreenshotOptions | undefined> {
    this._currentStory = story;
    this.debug('Set story', story.id);
    await this.navigator.navigate(story.id);
    await this.addStyles();
    if (this.mode === 'managed') {
      return this.navigator.waitForReady(this.opt.captureTimeout, this.opt.signal);
    }
    return undefined;
  }

  private async setViewport(opt: StrictScreenshotOptions) {
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
        // Handle as Puppeteer device descriptor.
        const hit = this.getDeviceDescriptors().find(d => d.name === opt.viewport);
        if (!hit) {
          this.opt.logger.warn(
            `Skip screenshot for ${this.opt.logger.color.yellow(
              JSON.stringify(this.currentStory),
            )} because the viewport ${this.opt.logger.color.magenta(
              opt.viewport,
            )} is not registered in 'puppeteer/DeviceDescriptor'.`,
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
      // Setting isMobile or hasTouch properties will reload the page.
      // See also https://github.com/puppeteer/puppeteer/blob/main/docs/api/puppeteer.viewport.md
      const willBeReloaded =
        nextViewport.isMobile !== this.viewport?.isMobile || nextViewport.hasTouch !== this.viewport?.hasTouch;
      if (willBeReloaded) {
        // Avoid racing Puppeteer's implicit reload against Storybook's preview lifecycle.
        await this.page.goto('about:blank', { waitUntil: 'domcontentloaded' });
      }
      await this.page.setViewport(nextViewport);
      this.viewport = nextViewport;
      if (willBeReloaded || this.opt.reloadAfterChangeViewport) {
        // Start a fresh owned request after the viewport has settled.
        await this.setCurrentStory(this.currentStory);
        await sleep(this.opt.viewportDelay);
      } else {
        await sleep(this.opt.viewportDelay);
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

  private async waitForResources(screenshotOptions: StrictScreenshotOptions) {
    if (!screenshotOptions.waitAssets && !screenshotOptions.waitImages) return;
    this.debug('Wait for requested resources resolved', this.resourceWatcher!.getRequestedUrls());
    await this.resourceWatcher!.waitForRequestsComplete();
  }

  private async waitBrowserMetricsStable(phase: 'preEmit' | 'postEmit') {
    const mw = new MetricsWatcher(this.page, this.opt.metricsWatchRetryCount);
    const checkCountUntillStable = await mw.waitForStable();
    this.debug(`[${phase}] Browser metrics got stable in ${checkCountUntillStable} times checks.`);
    if (checkCountUntillStable >= this.opt.metricsWatchRetryCount) {
      this.opt.logger.warn(
        `Metrics is not stable while ${this.opt.metricsWatchRetryCount} times. ${this.opt.logger.color.yellow(
          JSON.stringify(this.currentStory),
        )}`,
      );
    }
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
    this.currentRequestId = requestId;
    this.currentVariantKey = variantKey;
    this.currentStoryRetryCount = retryCount;
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

    if (trace) {
      // Begin CPU trace, don't write to file, store it in memory
      await this.page.startTrace();
    }

    // Capture this outside so it can be used for the filePath generation for the trace
    let defaultVariantSuffix: string | undefined;

    try {
      try {
        emittedScreenshotOptions = await this.setCurrentStory(story);
      } catch (error) {
        if (error instanceof PreviewReadyTimeoutError && this.currentStoryRetryCount < this.opt.captureMaxRetryCount) {
          this.opt.logger.warn(`${error.message} Retry to screenshot this story after this sequence.`);
          return { buffer: null, succeeded: false, variantKeysToPush: [], defaultVariantSuffix: '' };
        }
        throw error;
      }

      if (this.mode === 'managed') {
        if (!this.currentStory) {
          throw new InvalidCurrentStoryStateError();
        }
        if (!emittedScreenshotOptions) {
          throw new InvalidCurrentStoryStateError();
        }
      } else {
        await sleep(this.opt.delay);
        await this.waitBrowserMetricsStable('preEmit');
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
        await this.waitForDebugInput();
        return { buffer: null, succeeded: true, variantKeysToPush, defaultVariantSuffix: '' };
      }

      this.touched = false;

      // Change browser's viewport if needed.
      const vpChanged = await this.setViewport(mergedScreenshotOptions);
      // Skip to capture if the viewport option is invalid.
      if (!vpChanged) return { buffer: null, succeeded: true, variantKeysToPush: [], defaultVariantSuffix: '' };

      // Modify elements state.
      await this.setHover(mergedScreenshotOptions);
      await this.setFocus(mergedScreenshotOptions);
      await this.setClick(mergedScreenshotOptions);
      await this.waitIfTouched();

      // Wait until browser main thread gets stable.
      await this.waitForResources(mergedScreenshotOptions);
      await this.waitBrowserMetricsStable('postEmit');

      await this.page.evaluate(() => new Promise(res => (window as any).requestIdleCallback(res, { timeout: 3000 })));

      // Get PNG image buffer
      const buffer = await this.page.screenshot({
        fullPage: emittedScreenshotOptions.fullPage,
        omitBackground: emittedScreenshotOptions.omitBackground,
        captureBeyondViewport: emittedScreenshotOptions.captureBeyondViewport,
        clip: emittedScreenshotOptions.clip ?? undefined,
      });

      // We should reset elements state(e.g. focusing, hovering, clicking) for future screenshot for this story.
      await this.resetIfTouched(mergedScreenshotOptions);

      await this.waitForDebugInput();

      return {
        buffer,
        succeeded: true,
        variantKeysToPush,
        defaultVariantSuffix,
      };
    } finally {
      unsubscribeConsole();

      if (trace) {
        // Finish CPU trace.
        const traceBuffer = await this.page.stopTrace();

        // Calculate the suffix and save the trace to the file.
        const suffix = variantKey.isDefault && defaultVariantSuffix ? [defaultVariantSuffix] : variantKey.keys;
        await fileSystem.saveTrace(story.kind, story.story, suffix, traceBuffer);
      }
    }
  }
}
