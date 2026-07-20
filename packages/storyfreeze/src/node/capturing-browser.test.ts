import { describe, expect, it, vi } from 'vite-plus/test';
import { CapturingBrowser } from './capturing-browser.js';
import { CaptureDeadline } from './capture-deadline.js';
import { Logger } from './logger.js';
import type { MainOptions } from './types.js';

function options(): MainOptions {
  return {
    serverOptions: { storybookUrl: 'https://example.test' },
    captureTimeout: 1000,
    captureMaxRetryCount: 1,
    delay: 0,
    viewports: ['800x600'],
    outDir: '__screenshots__',
    flat: false,
    include: [],
    exclude: [],
    disableCssAnimation: true,
    disableWaitAssets: false,
    forwardConsoleLogs: false,
    parallel: 4,
    shard: { shardNumber: 1, totalShards: 1 },
    chromiumChannel: '*',
    chromiumPath: '',
    launchOptions: { headless: true },
    logger: new Logger('silent'),
  };
}

describe(CapturingBrowser, () => {
  it('recycles a context at the fixed 128-capture boundary', async () => {
    const browser = new CapturingBrowser({ url: 'https://example.test' } as never, options(), 0);
    const restart = vi.fn(async () => {});
    (browser as any).capturesInContext = 127;
    (browser as any).restartCaptureContext = restart;
    await (browser as any).recycleContextIfNeeded();
    expect(restart).not.toHaveBeenCalled();
    (browser as any).capturesInContext = 128;
    await (browser as any).recycleContextIfNeeded();
    expect(restart).toHaveBeenCalledOnce();
  });

  it('live-resizes desktop dimensions and recreates context across an emulation-class boundary', async () => {
    const browser = new CapturingBrowser({ url: 'https://example.test' } as never, options(), 0);
    const setViewport = vi.fn(async () => {});
    (browser as any).capturePage = { setViewport };
    (browser as any).currentStory = { id: 'story', kind: 'Story', story: 'Default', version: 'v5' };
    (browser as any).viewport = { width: 800, height: 600 };
    const deadline = new CaptureDeadline(1000, 'story');
    await (browser as any).setViewport({ viewport: { width: 1280, height: 720 } }, deadline);
    expect(setViewport).toHaveBeenCalledWith({ width: 1280, height: 720 });

    const restart = vi.fn(async () => {});
    const select = vi.fn(async () => ({}));
    (browser as any).restartCaptureContext = restart;
    (browser as any).setCurrentStory = select;
    (browser as any).viewport = { width: 1280, height: 720 };
    await (browser as any).setViewport(
      { viewport: { width: 414, height: 896, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
      deadline,
    );
    expect(restart).toHaveBeenCalledWith(undefined, {
      viewport: { width: 414, height: 896, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    });
    expect(select).toHaveBeenCalledOnce();
    deadline.dispose();
  });
});
