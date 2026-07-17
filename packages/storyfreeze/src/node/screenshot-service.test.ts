import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { FileSystem } from './file.js';
import type { Logger } from './logger.js';
import { createScreenshotService } from './screenshot-service.js';
import type { Story } from './story.js';
import type { VariantKey } from '../shared/types.js';
import { CAPTURE_DIAGNOSTIC_PREFIX } from './capture-diagnostics.js';
import { createBaseScreenshotOptions } from '../shared/screenshot-options-helper.js';
import { generateCaptureManifest } from './capture-manifest.js';
import { createCapturePlan } from './capture-plan.js';

const story: Story = {
  id: 'button--primary',
  kind: 'Button',
  story: 'Primary',
  version: 'v5',
};

describe(createScreenshotService, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('queues a retry before adding all variants from the successful default capture', async () => {
    vi.stubEnv('STORYFREEZE_CAPTURE_DIAGNOSTICS', '1');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
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
      workers: [{ screenshot }],
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
    const events = write.mock.calls
      .map(([chunk]) => String(chunk))
      .filter(line => line.startsWith(CAPTURE_DIAGNOSTIC_PREFIX))
      .map(line => JSON.parse(line.slice(CAPTURE_DIAGNOSTIC_PREFIX.length)));
    expect(events.filter(event => event.type === 'queue-task' && event.state === 'start')).toHaveLength(4);
    expect(events.find(event => event.type === 'queue-summary')).toMatchObject({
      busyWorkerUtilization: expect.any(Number),
      peakInFlight: 1,
      settled: 4,
      totalEnqueued: 4,
      workerCount: 1,
    });
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
      workers: [createWorker('one'), createWorker('two')],
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

  it('boots dormant workers only after runtime discovery expands the queue', async () => {
    const hovered: VariantKey = { isDefault: false, keys: ['hovered'] };
    const focused: VariantKey = { isDefault: false, keys: ['focused'] };
    let secondWorkerBooted = false;
    const createWorker = (workerId: number) => ({
      screenshot: vi.fn(async (_rid: string, _story: Story, variantKey: VariantKey) => {
        if (workerId === 1) expect(secondWorkerBooted).toBe(true);
        return {
          buffer: Buffer.from('png'),
          succeeded: true,
          variantKeysToPush: variantKey.isDefault ? [hovered, focused] : [],
          defaultVariantSuffix: '',
        };
      }),
    });
    const bootWorker = vi.fn(async (workerId: number) => {
      expect(workerId).toBe(1);
      secondWorkerBooted = true;
    });
    const service = createScreenshotService({
      workers: [createWorker(0), createWorker(1)],
      initialWorkerCount: 1,
      bootWorker,
      stories: [story],
      fileSystem: { saveScreenshot: vi.fn(async () => 'screenshot.png') } as unknown as FileSystem,
      logger: {
        log: vi.fn(),
        color: { magenta: (value: string) => value },
      } as unknown as Logger,
      forwardConsoleLogs: false,
      trace: false,
    });

    await expect(service.execute()).resolves.toBe(3);
    expect(bootWorker).toHaveBeenCalledOnce();
  });

  it('leaves dormant workers unbooted when the initial queue drains', async () => {
    const screenshot = vi.fn(async () => ({
      buffer: Buffer.from('png'),
      succeeded: true,
      variantKeysToPush: [],
      defaultVariantSuffix: '',
    }));
    const bootWorker = vi.fn(async () => {});
    const service = createScreenshotService({
      workers: [{ screenshot }, { screenshot }],
      initialWorkerCount: 1,
      bootWorker,
      stories: [story],
      fileSystem: { saveScreenshot: vi.fn(async () => 'screenshot.png') } as unknown as FileSystem,
      logger: {
        log: vi.fn(),
        color: { magenta: (value: string) => value },
      } as unknown as Logger,
      forwardConsoleLogs: false,
      trace: false,
    });

    await expect(service.execute()).resolves.toBe(1);
    expect(bootWorker).not.toHaveBeenCalled();
  });

  it('maps the stored path to the request when capture diagnostics are enabled', async () => {
    vi.stubEnv('STORYFREEZE_CAPTURE_DIAGNOSTICS', '1');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const screenshot = vi.fn(async () => ({
      buffer: Buffer.from('png'),
      succeeded: true,
      variantKeysToPush: [],
      defaultVariantSuffix: 'LARGE',
    }));
    const logger = {
      log: vi.fn(),
      color: { magenta: (value: string) => value },
    } as unknown as Logger;

    const service = createScreenshotService({
      workers: [{ screenshot }],
      stories: [story],
      fileSystem: {
        saveScreenshot: vi.fn(async () => 'screenshots/Button/Primary_LARGE.png'),
      } as unknown as FileSystem,
      logger,
      forwardConsoleLogs: false,
      trace: false,
    });

    await expect(service.execute()).resolves.toBe(1);
    const lines = write.mock.calls.map(call => String(call[0]));
    const queueLine = lines.find(value => value.includes('"type":"queue-task"') && value.includes('"state":"start"'));
    expect(queueLine).toBeDefined();
    expect(JSON.parse(queueLine!.slice(CAPTURE_DIAGNOSTIC_PREFIX.length))).toMatchObject({
      type: 'queue-task',
      state: 'start',
      durationMs: expect.any(Number),
      requestId: 'button--primary',
      storyId: 'button--primary',
      variantKey: [],
    });
    const line = lines.find(value => value.includes('"type":"capture-output"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(line!.indexOf('{')))).toMatchObject({
      type: 'capture-output',
      path: 'screenshots/Button/Primary_LARGE.png',
      requestId: 'button--primary',
      retryCount: 0,
      storyId: 'button--primary',
      variantKey: [],
    });
  });

  it('captures safe variants through one opt-in story session without queueing duplicate navigation', async () => {
    const hovered: VariantKey = { isDefault: false, keys: ['hovered'] };
    const screenshot = vi.fn(async () => ({
      buffer: Buffer.from('default'),
      succeeded: true,
      variantKeysToPush: [hovered],
      defaultVariantSuffix: '',
    }));
    const screenshotSessionVariants = vi.fn(async (_sessionId, _story, requests) => ({
      outputs: requests.map((request: { variantKey: VariantKey }) => ({
        variantKey: request.variantKey,
        buffer: Buffer.from('variant'),
        durationMs: 25,
      })),
      strictFallbacks: [],
    }));
    const saveScreenshot = vi.fn(async () => 'screenshot.png');
    const logger = {
      log: vi.fn(),
      debug: vi.fn(),
      color: { magenta: (value: string) => value },
    } as unknown as Logger;
    const capturePlan = createCapturePlan(
      generateCaptureManifest({
        stories: [
          {
            id: story.id,
            title: story.kind,
            name: story.story,
            screenshotOptions: { variants: { hovered: { hover: '#button' } } },
            eligibility: 'static',
          },
        ],
        baseOptions: createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] }),
        deviceDescriptors: [],
        generatedAt: '2026-07-17T00:00:00.000Z',
        mode: 'managed',
      }),
    );

    const service = createScreenshotService({
      workers: [{ screenshot, screenshotSessionVariants }],
      stories: [story],
      fileSystem: { saveScreenshot } as unknown as FileSystem,
      logger,
      forwardConsoleLogs: false,
      trace: false,
      capturePlan,
      captureProtocol: 'auto',
    });

    await expect(service.execute()).resolves.toBe(2);
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(screenshotSessionVariants).toHaveBeenCalledTimes(1);
    expect(screenshotSessionVariants.mock.calls[0][2]).toEqual([expect.objectContaining({ variantKey: hovered })]);
    expect(saveScreenshot).toHaveBeenCalledTimes(2);
  });

  it('requeues only the remaining variants when a story session falls back to strict capture', async () => {
    const hovered: VariantKey = { isDefault: false, keys: ['hovered'] };
    const focused: VariantKey = { isDefault: false, keys: ['focused'] };
    const screenshot = vi.fn(async (_rid: string, _story: Story, variantKey: VariantKey) => ({
      buffer: Buffer.from(variantKey.isDefault ? 'default' : 'strict'),
      succeeded: true,
      variantKeysToPush: variantKey.isDefault ? [hovered, focused] : [],
      defaultVariantSuffix: '',
    }));
    const screenshotSessionVariants = vi.fn(async () => ({
      outputs: [{ variantKey: hovered, buffer: Buffer.from('fast'), durationMs: 25 }],
      strictFallbacks: [{ variantKey: focused }],
    }));
    const saveScreenshot = vi.fn(async () => 'screenshot.png');
    const logger = {
      log: vi.fn(),
      debug: vi.fn(),
      color: { magenta: (value: string) => value },
    } as unknown as Logger;
    const capturePlan = createCapturePlan(
      generateCaptureManifest({
        stories: [{ id: story.id, title: story.kind, name: story.story }],
        baseOptions: createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] }),
        deviceDescriptors: [],
        generatedAt: '2026-07-17T00:00:00.000Z',
        mode: 'managed',
      }),
    );

    const service = createScreenshotService({
      workers: [{ screenshot, screenshotSessionVariants }],
      stories: [story],
      fileSystem: { saveScreenshot } as unknown as FileSystem,
      logger,
      forwardConsoleLogs: false,
      trace: false,
      capturePlan,
      captureProtocol: 'auto',
    });

    await expect(service.execute()).resolves.toBe(3);
    expect(screenshotSessionVariants).toHaveBeenCalledTimes(1);
    expect(screenshot.mock.calls.map(([, , variantKey]) => variantKey)).toEqual([
      { isDefault: true, keys: [] },
      focused,
    ]);
    expect(saveScreenshot).toHaveBeenCalledTimes(3);
  });
});
