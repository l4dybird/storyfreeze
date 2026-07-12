import { describe, expect, it, vi } from 'vite-plus/test';
import type { CapturingBrowser } from './capturing-browser.js';
import type { FileSystem } from './file.js';
import type { Logger } from './logger.js';
import { createScreenshotService } from './screenshot-service.js';
import type { Story } from './story.js';
import type { VariantKey } from '../shared/types.js';

const story: Story = {
  id: 'button--primary',
  kind: 'Button',
  story: 'Primary',
  version: 'v5',
};

describe(createScreenshotService, () => {
  it('queues a retry before adding all variants from the successful default capture', async () => {
    const hovered: VariantKey = { isDefault: false, keys: ['hovered'] };
    const small: VariantKey = { isDefault: false, keys: ['SMALL'] };
    const screenshot = vi.fn(async (_rid: string, _story: Story, variantKey: VariantKey, count: number) => {
      if (variantKey.isDefault && count === 0) {
        return { buffer: null, succeeded: false, variantKeysToPush: [], defaultVariantSuffix: '' };
      }
      return {
        buffer: Buffer.from('png'),
        succeeded: true,
        variantKeysToPush: variantKey.isDefault ? [hovered, small] : [],
        defaultVariantSuffix: variantKey.isDefault ? 'LARGE' : '',
      };
    });
    const saveScreenshot = vi.fn(
      async (_kind: string, _story: string, _suffix: string[], _buffer: Buffer) => 'screenshot.png',
    );
    const logger = {
      log: vi.fn(),
      color: { magenta: (value: string) => value },
    } as unknown as Logger;

    const service = createScreenshotService({
      workers: [{ screenshot }] as unknown as CapturingBrowser[],
      stories: [story],
      fileSystem: { saveScreenshot } as unknown as FileSystem,
      logger,
      forwardConsoleLogs: false,
      trace: false,
    });

    await expect(service.execute()).resolves.toBe(3);
    expect(screenshot).toHaveBeenCalledTimes(4);
    expect(screenshot.mock.calls.map(([, , variantKey, count]) => ({ variantKey, count }))).toEqual([
      { variantKey: { isDefault: true, keys: [] }, count: 0 },
      { variantKey: { isDefault: true, keys: [] }, count: 1 },
      { variantKey: hovered, count: 0 },
      { variantKey: small, count: 0 },
    ]);
    expect(saveScreenshot.mock.calls.map(([, , suffix]) => suffix)).toEqual([['LARGE'], ['hovered'], ['SMALL']]);
  });

  it('keeps retry and dynamically added variants alive across two workers', async () => {
    const hovered: VariantKey = { isDefault: false, keys: ['hovered'] };
    const small: VariantKey = { isDefault: false, keys: ['SMALL'] };
    const calls: Array<{ worker: string; variantKey: VariantKey; count: number }> = [];
    const createWorker = (worker: string) => ({
      screenshot: vi.fn(async (_rid: string, _story: Story, variantKey: VariantKey, count: number) => {
        calls.push({ worker, variantKey, count });
        if (variantKey.isDefault && count === 0) {
          return { buffer: null, succeeded: false, variantKeysToPush: [], defaultVariantSuffix: '' };
        }
        return {
          buffer: Buffer.from('png'),
          succeeded: true,
          variantKeysToPush: variantKey.isDefault ? [hovered, small] : [],
          defaultVariantSuffix: variantKey.isDefault ? 'LARGE' : '',
        };
      }),
    });
    const saveScreenshot = vi.fn(
      async (_kind: string, _story: string, _suffix: string[], _buffer: Buffer) => 'screenshot.png',
    );
    const logger = {
      log: vi.fn(),
      color: { magenta: (value: string) => value },
    } as unknown as Logger;

    const service = createScreenshotService({
      workers: [createWorker('one'), createWorker('two')] as unknown as CapturingBrowser[],
      stories: [story],
      fileSystem: { saveScreenshot } as unknown as FileSystem,
      logger,
      forwardConsoleLogs: false,
      trace: false,
    });

    await expect(service.execute()).resolves.toBe(3);
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map(call => call.worker))).toEqual(new Set(['one', 'two']));
    expect(saveScreenshot.mock.calls.map(([, , suffix]) => suffix.join(',')).sort()).toEqual([
      'LARGE',
      'SMALL',
      'hovered',
    ]);
  });
});
