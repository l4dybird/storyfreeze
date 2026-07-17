import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createBaseScreenshotOptions } from '../shared/screenshot-options-helper.js';
import { BaseBrowser } from './browser.js';
import { CapturingBrowser } from './capturing-browser.js';
import { Logger } from './logger.js';
import type { ManagedStorybookConnection } from './managed-storybook-connection.js';
import type { Story } from './story.js';
import type { MainOptions } from './types.js';

const story: Story = { id: 'button--primary', kind: 'Button', story: 'Primary', version: 'v5' };
const profileHash = '800:600:1:0:0:1';

describe(CapturingBrowser.prototype.screenshotSessionVariants, () => {
  afterEach(() => vi.restoreAllMocks());

  it('captures a safe hover variant without another Storybook navigation and verifies reset', async () => {
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
    const reset = { ...session, activeElement: null, pendingRequestCount: 0 };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(reset)
      .mockResolvedValueOnce({ ...session, variantId: 'hovered', variantGeneration: 1 })
      .mockResolvedValueOnce(reset)
      .mockResolvedValueOnce(undefined);
    const unsubscribe = vi.fn();
    const page = {
      elementExists: vi.fn(async () => true),
      evaluate,
      hover: vi.fn(async () => {}),
      resetPointer: vi.fn(async () => {}),
      screenshot: vi.fn(async () => Buffer.from('png')),
      setViewport: vi.fn(async () => {}),
      subscribeConsole: vi.fn(() => unsubscribe),
      waitForVisualCommit: vi.fn(async () => ({ didTimeout: false })),
    };
    vi.spyOn(BaseBrowser.prototype, 'page', 'get').mockReturnValue(page as never);
    vi.spyOn(browser as never, 'waitBrowserMetricsStable').mockResolvedValue(undefined);
    const rootOptions = createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] });
    rootOptions.variants = { hovered: { hover: '#button' } };
    Object.assign(browser, {
      _currentStory: story,
      previewRuntimeMetadata: {
        hasCustomReset: false,
        hasRuntimeWaitFor: false,
        runtimeWaitForVariants: [],
      },
      resourceWatcher: {
        clear: vi.fn(),
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
    expect(page.screenshot).toHaveBeenCalledTimes(1);
    expect(page.resetPointer).toHaveBeenCalledTimes(1);
    expect(page.setViewport).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(5);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
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
    const validReset = {
      ...session,
      activeElement: null,
      pendingRequestCount: 0,
      baseRootFingerprint: 'baseline',
      rootFingerprint: 'baseline',
    };
    const invalidReset = { ...validReset, rootFingerprint: 'mutated' };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(validReset)
      .mockResolvedValueOnce({ ...session, variantId: 'hovered', variantGeneration: 1 })
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
});
