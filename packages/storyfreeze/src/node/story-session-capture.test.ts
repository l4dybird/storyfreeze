import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createBaseScreenshotOptions } from '../shared/screenshot-options-helper.js';
import { BaseBrowser } from './browser.js';
import { CaptureDeadline } from './capture-deadline.js';
import { CapturingBrowser } from './capturing-browser.js';
import { Logger } from './logger.js';
import type { ManagedStorybookConnection } from './managed-storybook-connection.js';
import type { Story } from './story.js';
import type { MainOptions } from './types.js';

const story: Story = { id: 'button--primary', kind: 'Button', story: 'Primary', version: 'v5' };
const profileHash = '800:600:1:0:0:1';

function resetVerification(session = { storyId: story.id, sessionGeneration: 1, profileHash }) {
  return {
    ...session,
    activeElement: null,
    activeElementMatchesBaseline: true,
    baseActiveElement: null,
    argsHash: 'args',
    baseArgsHash: 'args',
    baseDocumentFingerprint: 'baseline',
    globalsHash: 'globals',
    baseGlobalsHash: 'globals',
    documentFingerprint: 'baseline',
    scrollPositionMatchesBaseline: true,
  };
}

function createBrowserFixture(captureTimeout = 5000) {
  const logger = new Logger('silent');
  const options = {
    captureTimeout,
    delay: 0,
    disableWaitAssets: false,
    logger,
    metricsWatchRetryCount: 3,
    stateChangeDelay: 0,
    viewportDelay: 0,
    viewports: ['800x600'],
  } as MainOptions;
  const browser = new CapturingBrowser(
    { url: 'https://example.test' } as ManagedStorybookConnection,
    options,
    'managed',
    0,
    { name: 'playwright' } as never,
  );
  return { browser, logger };
}

describe(CapturingBrowser.prototype.screenshotSessionVariants, () => {
  afterEach(() => vi.restoreAllMocks());

  it('drains requests started by reset paint before verifying the restored state', async () => {
    const { browser } = createBrowserFixture();
    const order: string[] = [];
    let paintCount = 0;
    let tickCount = 0;
    let generation = 0;
    let pending = false;
    let observedPaintRequest = false;
    const page = {
      waitForRenderTick: vi.fn(async () => {
        tickCount += 1;
        order.push(`tick-${tickCount}`);
        if (tickCount === 1) {
          pending = true;
          generation += 1;
        }
      }),
      waitForVisualCommit: vi.fn(async () => {
        paintCount += 1;
        order.push(`paint-${paintCount}`);
        return { didTimeout: false };
      }),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    const resourceWatcher = {
      get generation() {
        return generation;
      },
      get pendingCount() {
        return pending ? 1 : 0;
      },
      getDiagnosticSnapshot: vi.fn(() => {
        order.push('snapshot');
        return {
          pending: pending ? [{ method: 'GET', resourceType: 'fetch', url: 'https://example.test/late' }] : [],
          requestedUrls: [],
        };
      }),
      waitForRequestsComplete: vi.fn(async () => {
        order.push('requests');
        observedPaintRequest = pending;
        pending = false;
        generation += 1;
        return {
          didTimeout: false,
          elapsedMs: 0,
          pendingCount: 0,
          pending: [],
          requestedUrlCount: 1,
          requestedUrls: [],
        };
      }),
    };
    const verification = resetVerification();
    const protocol = {
      resetVariant: vi.fn(async () => order.push('reset')),
      verifyReset: vi.fn(async () => {
        order.push('verify');
        return verification;
      }),
    };
    const profile = {
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      isLandscape: true,
    };
    Object.assign(browser, { resourceWatcher, viewport: profile });
    const deadline = new CaptureDeadline(1000, 'reset-paint-request');

    try {
      await (browser as any).resetStorySessionVariant(protocol, 'hovered', profile, deadline, true);
    } finally {
      deadline.dispose();
    }

    expect(observedPaintRequest).toBe(true);
    expect(order).toEqual(['reset', 'tick-1', 'requests', 'tick-2', 'paint-1', 'verify']);
  });

  it('captures a click variant with custom reset without another Storybook navigation and verifies reset', async () => {
    const logger = new Logger('silent');
    const options = {
      captureTimeout: 5000,
      delay: 0,
      disableWaitAssets: false,
      logger,
      metricsWatchRetryCount: 3,
      stateChangeDelay: 0,
      viewportDelay: 0,
      viewports: ['800x600'],
    } as MainOptions;
    const browser = new CapturingBrowser(
      { url: 'https://example.test' } as ManagedStorybookConnection,
      options,
      'managed',
      0,
      { name: 'playwright' } as never,
    );
    const session = { storyId: story.id, sessionGeneration: 1, profileHash };
    const reset = resetVerification(session);
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(reset)
      .mockResolvedValueOnce({ ...session, variantId: 'hovered', variantGeneration: 1 })
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(reset)
      .mockResolvedValueOnce(undefined);
    const unsubscribe = vi.fn();
    const page = {
      elementExists: vi.fn(async () => true),
      evaluate,
      click: vi.fn(async () => {}),
      hover: vi.fn(async () => {}),
      resetPointer: vi.fn(async () => {}),
      screenshot: vi.fn(async () => Buffer.from('png')),
      setViewport: vi.fn(async () => {}),
      subscribeConsole: vi.fn(() => unsubscribe),
      waitForRenderTick: vi.fn(async () => {}),
      waitForVisualCommit: vi.fn(async () => ({ didTimeout: false })),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    vi.spyOn(browser as never, 'waitBrowserMetricsStable').mockResolvedValue(undefined);
    const rootOptions = createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] });
    rootOptions.variants = { hovered: { hover: '#button', click: '#button' } };
    Object.assign(browser, {
      _currentStory: story,
      previewRuntimeMetadata: {
        hasCustomReset: true,
        hasRuntimeWaitFor: false,
        runtimeWaitForVariants: [],
      },
      resourceWatcher: {
        clear: vi.fn(),
        generation: 0,
        pendingCount: 0,
        getDiagnosticSnapshot: vi.fn(() => ({ pending: [], requestedUrls: [] })),
        getRequestedUrls: vi.fn(() => []),
        waitForRequestsComplete: vi.fn(async () => ({
          didTimeout: false,
          elapsedMs: 0,
          pending: [],
          requestedUrls: [],
        })),
      },
      rootScreenshotOptions: rootOptions,
      viewport: { width: 800, height: 600 },
    });

    await expect(
      browser.screenshotSessionVariants(
        'button-desktop',
        story,
        [{ variantKey: { isDefault: false, keys: ['hovered'] } }],
        logger,
        false,
        false,
        {} as never,
        'auto',
      ),
    ).resolves.toEqual({
      outputs: [
        {
          variantKey: { isDefault: false, keys: ['hovered'] },
          buffer: Buffer.from('png'),
          durationMs: expect.any(Number),
        },
      ],
      strictFallbacks: [],
    });
    expect(page.hover).toHaveBeenCalledWith('#button');
    expect(page.click).toHaveBeenCalledWith('#button');
    expect(page.screenshot).toHaveBeenCalledTimes(1);
    expect(page.resetPointer).toHaveBeenCalledTimes(1);
    expect(page.setViewport).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(6);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect((browser as unknown as { capturesInContext: number }).capturesInContext).toBe(1);
  });

  it('does not repeat metrics or capture paint settling for a passive session variant', async () => {
    const { browser, logger } = createBrowserFixture();
    const session = { storyId: story.id, sessionGeneration: 1, profileHash };
    const verification = resetVerification(session);
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(verification)
      .mockResolvedValueOnce({ ...session, variantId: 'transparent', variantGeneration: 1 })
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(verification)
      .mockResolvedValueOnce(undefined);
    const page = {
      evaluate,
      screenshot: vi.fn(async () => Buffer.from('png')),
      subscribeConsole: vi.fn(() => vi.fn()),
      waitForRenderTick: vi.fn(async () => {}),
      waitForVisualCommit: vi.fn(async () => ({ didTimeout: false })),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    const metrics = vi.spyOn(browser as never, 'waitBrowserMetricsStable').mockResolvedValue(undefined);
    const waitForRequestsComplete = vi.fn(async () => ({
      didTimeout: false,
      elapsedMs: 0,
      pendingCount: 0,
      pending: [],
      requestedUrlCount: 0,
      requestedUrls: [],
    }));
    const rootOptions = createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] });
    rootOptions.variants = { transparent: { omitBackground: true } };
    Object.assign(browser, {
      _currentStory: story,
      previewRuntimeMetadata: {
        hasCustomReset: false,
        hasRuntimeWaitFor: false,
        runtimeWaitForVariants: [],
      },
      resourceWatcher: {
        clear: vi.fn(),
        generation: 0,
        pendingCount: 0,
        waitForRequestsComplete,
      },
      rootScreenshotOptions: rootOptions,
      viewport: { width: 800, height: 600 },
    });
    const request = { variantKey: { isDefault: false, keys: ['transparent'] } };

    await expect(
      browser.screenshotSessionVariants('button-desktop', story, [request], logger, false, false, {} as never, 'auto'),
    ).resolves.toEqual({
      outputs: [{ variantKey: request.variantKey, buffer: Buffer.from('png'), durationMs: expect.any(Number) }],
      strictFallbacks: [],
    });
    expect(metrics).not.toHaveBeenCalled();
    expect(page.waitForVisualCommit).toHaveBeenCalledTimes(1);
    expect(waitForRequestsComplete).toHaveBeenCalledTimes(1);
  });

  it('restarts the worker and returns the failed and remaining variants to strict mode after reset mismatch', async () => {
    const logger = new Logger('silent');
    const options = {
      captureTimeout: 5000,
      delay: 0,
      disableWaitAssets: false,
      logger,
      metricsWatchRetryCount: 3,
      stateChangeDelay: 0,
      viewportDelay: 0,
      viewports: ['800x600'],
    } as MainOptions;
    const browser = new CapturingBrowser(
      { url: 'https://example.test' } as ManagedStorybookConnection,
      options,
      'managed',
      0,
      { name: 'playwright' } as never,
    );
    const session = { storyId: story.id, sessionGeneration: 1, profileHash };
    const validReset = resetVerification(session);
    const invalidReset = { ...validReset, documentFingerprint: 'mutated' };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(validReset)
      .mockResolvedValueOnce({ ...session, variantId: 'hovered', variantGeneration: 1 })
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(invalidReset)
      .mockResolvedValueOnce(undefined);
    const page = {
      elementExists: vi.fn(async () => true),
      evaluate,
      focus: vi.fn(async () => {}),
      hover: vi.fn(async () => {}),
      resetPointer: vi.fn(async () => {}),
      screenshot: vi.fn(async () => Buffer.from('png')),
      setViewport: vi.fn(async () => {}),
      subscribeConsole: vi.fn(() => vi.fn()),
      waitForRenderTick: vi.fn(async () => {}),
      waitForVisualCommit: vi.fn(async () => ({ didTimeout: false })),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    vi.spyOn(browser as never, 'waitBrowserMetricsStable').mockResolvedValue(undefined);
    const restart = vi.spyOn(browser as never, 'restartCaptureSession').mockResolvedValue(undefined);
    const rootOptions = createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] });
    rootOptions.variants = {
      hovered: { hover: '#button' },
      focused: { focus: '#button' },
    };
    Object.assign(browser, {
      _currentStory: story,
      previewRuntimeMetadata: {
        hasCustomReset: false,
        hasRuntimeWaitFor: false,
        runtimeWaitForVariants: [],
      },
      resourceWatcher: {
        clear: vi.fn(),
        generation: 0,
        pendingCount: 0,
        getDiagnosticSnapshot: vi.fn(() => ({ pending: [], requestedUrls: [] })),
        getRequestedUrls: vi.fn(() => []),
        waitForRequestsComplete: vi.fn(async () => ({
          didTimeout: false,
          elapsedMs: 0,
          pending: [],
          requestedUrls: [],
        })),
      },
      rootScreenshotOptions: rootOptions,
      viewport: { width: 800, height: 600 },
    });
    const hovered = { variantKey: { isDefault: false, keys: ['hovered'] } };
    const focused = { variantKey: { isDefault: false, keys: ['focused'] } };

    await expect(
      browser.screenshotSessionVariants(
        'button-desktop',
        story,
        [hovered, focused],
        logger,
        false,
        false,
        {} as never,
        'auto',
      ),
    ).resolves.toEqual({ outputs: [], strictFallbacks: [hovered, focused] });
    expect(restart).toHaveBeenCalledOnce();
    expect(page.screenshot).toHaveBeenCalledOnce();
  });

  it('throws in forced story-session mode when the prepared story state is missing', async () => {
    const { browser, logger } = createBrowserFixture();
    const request = { variantKey: { isDefault: false, keys: ['hovered'] } };

    await expect(
      browser.screenshotSessionVariants(
        'button-desktop',
        story,
        [request],
        logger,
        false,
        false,
        {} as never,
        'story-session',
      ),
    ).rejects.toThrow('not ready for forced story-session capture');
  });

  it('restarts an unsafe base capture before falling back in auto mode', async () => {
    const { browser, logger } = createBrowserFixture();
    const request = { variantKey: { isDefault: false, keys: ['hovered'] } };
    const rootOptions = createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] });
    Object.assign(browser, {
      _currentStory: story,
      previewRuntimeMetadata: {
        hasCustomReset: false,
        hasRuntimeWaitFor: true,
        runtimeWaitForVariants: [],
      },
      rootScreenshotOptions: rootOptions,
      viewport: { width: 800, height: 600 },
    });
    const restart = vi.spyOn(browser as never, 'restartCaptureSession').mockResolvedValue(undefined);

    await expect(
      browser.screenshotSessionVariants('button-desktop', story, [request], logger, false, false, {} as never, 'auto'),
    ).resolves.toEqual({ outputs: [], strictFallbacks: [request] });
    expect(restart).toHaveBeenCalledOnce();
  });

  it('defers forced story-session recycling until the session boundary', async () => {
    const { browser, logger } = createBrowserFixture();
    const request = { variantKey: { isDefault: false, keys: ['hovered'] } };
    const session = { storyId: story.id, sessionGeneration: 1, profileHash };
    const validReset = resetVerification(session);
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(validReset)
      .mockResolvedValueOnce(undefined);
    const page = {
      evaluate,
      resetPointer: vi.fn(async () => {}),
      waitForVisualCommit: vi.fn(async () => ({ didTimeout: false })),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    vi.spyOn(browser as never, 'captureStorySessionVariant').mockResolvedValue(Buffer.from('png'));
    const restart = vi.spyOn(browser as never, 'restartCaptureSession').mockImplementation(async () => {
      expect(evaluate).toHaveBeenCalledTimes(3);
    });
    const rootOptions = createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] });
    rootOptions.variants = { hovered: { hover: '#button' } };
    Object.assign(browser, {
      _currentStory: story,
      capturesInContext: 1,
      previewRuntimeMetadata: {
        hasCustomReset: false,
        hasRuntimeWaitFor: false,
        runtimeWaitForVariants: [],
      },
      resourceWatcher: {
        pendingCount: 0,
        getDiagnosticSnapshot: vi.fn(() => ({ pending: [], requestedUrls: [] })),
        waitForRequestsComplete: vi.fn(async () => ({ pending: [] })),
      },
      rootScreenshotOptions: rootOptions,
      viewport: { width: 800, height: 600 },
    });
    Object.assign((browser as unknown as { opt: MainOptions }).opt, {
      recyclingPolicy: { maxCapturesPerContext: 1 },
    });

    await expect(
      browser.screenshotSessionVariants(
        'button-desktop',
        story,
        [request],
        logger,
        false,
        false,
        {} as never,
        'story-session',
      ),
    ).resolves.toEqual({
      outputs: [{ variantKey: request.variantKey, buffer: Buffer.from('png'), durationMs: expect.any(Number) }],
      strictFallbacks: [],
    });
    expect(restart).toHaveBeenCalledOnce();
  });

  it('times out a custom reset evaluate that never settles without an unhandled rejection', async () => {
    const { browser, logger } = createBrowserFixture(25);
    const request = { variantKey: { isDefault: false, keys: ['hovered'] } };
    const session = { storyId: story.id, sessionGeneration: 1, profileHash };
    const validReset = resetVerification(session);
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(validReset)
      .mockResolvedValueOnce({ ...session, variantId: 'hovered', variantGeneration: 1 })
      .mockImplementationOnce(() => new Promise(() => {}));
    const page = {
      elementExists: vi.fn(async () => true),
      evaluate,
      hover: vi.fn(async () => {}),
      resetPointer: vi.fn(async () => {}),
      screenshot: vi.fn(async () => Buffer.from('png')),
      subscribeConsole: vi.fn(() => vi.fn()),
      waitForRenderTick: vi.fn(async () => {}),
      waitForVisualCommit: vi.fn(async () => ({ didTimeout: false })),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    vi.spyOn(browser as never, 'waitBrowserMetricsStable').mockResolvedValue(undefined);
    const rootOptions = createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] });
    rootOptions.variants = { hovered: { hover: '#button' } };
    Object.assign(browser, {
      _currentStory: story,
      previewRuntimeMetadata: {
        hasCustomReset: true,
        hasRuntimeWaitFor: false,
        runtimeWaitForVariants: [],
      },
      resourceWatcher: {
        clear: vi.fn(),
        generation: 0,
        pendingCount: 0,
        getDiagnosticSnapshot: vi.fn(() => ({ pending: [], requestedUrls: [] })),
        getRequestedUrls: vi.fn(() => []),
        waitForRequestsComplete: vi.fn(async () => ({
          didTimeout: false,
          elapsedMs: 0,
          pending: [],
          requestedUrls: [],
        })),
      },
      rootScreenshotOptions: rootOptions,
      viewport: { width: 800, height: 600 },
    });
    const restart = vi.spyOn(browser as never, 'restartCaptureSession').mockResolvedValue(undefined);

    await expect(
      browser.screenshotSessionVariants('button-desktop', story, [request], logger, false, false, {} as never, 'auto'),
    ).resolves.toEqual({ outputs: [], strictFallbacks: [request] });
    expect(restart).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledTimes(4);
    expect(page.screenshot).toHaveBeenCalledOnce();
    expect(page.resetPointer).toHaveBeenCalledOnce();
  });
});
