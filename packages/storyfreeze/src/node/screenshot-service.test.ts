import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import fs from 'node:fs';
import type { FileSystem } from './file.js';
import type { Logger } from './logger.js';
import { createScreenshotService } from './screenshot-service.js';
import type { Story } from './story.js';
import type { VariantKey } from '../shared/types.js';
import { CAPTURE_DIAGNOSTIC_PREFIX } from './capture-diagnostics.js';
import { createBaseScreenshotOptions } from '../shared/screenshot-options-helper.js';
import { generateCaptureManifest } from './capture-manifest.js';
import { createCapturePlan } from './capture-plan.js';
import { createExecutionWorkload, prepareExecutionPlan } from './execution-plan.js';

function completeStdoutWrite(...args: unknown[]) {
  const callback = args.find(value => typeof value === 'function') as (() => void) | undefined;
  callback?.();
  return true;
}

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
    const write = vi.spyOn(fs, 'write').mockImplementation(completeStdoutWrite as never);
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
      .map(([, chunk]) => String(chunk))
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

  it('leaves dormant workers unbooted when one active worker can perform its retry', async () => {
    let attempt = 0;
    const screenshot = vi.fn(async () => ({
      buffer: Buffer.from('png'),
      succeeded: ++attempt > 1,
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
    expect(screenshot).toHaveBeenCalledTimes(2);
    expect(bootWorker).not.toHaveBeenCalled();
  });

  it('maps the stored path to the request when capture diagnostics are enabled', async () => {
    vi.stubEnv('STORYFREEZE_CAPTURE_DIAGNOSTICS', '1');
    const write = vi.spyOn(fs, 'write').mockImplementation(completeStdoutWrite as never);
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
    const lines = write.mock.calls.map(call => String(call[1]));
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
    const screenshotSessionVariants = vi.fn(
      async (
        _sessionId,
        _story,
        requests,
        _logger,
        _forwardConsoleLogs,
        _trace,
        _fileSystem,
        _protocolMode,
        onOutput: (output: { variantKey: VariantKey; buffer: Buffer; durationMs: number }) => Promise<void>,
      ) => {
        for (const request of requests as Array<{ variantKey: VariantKey }>) {
          await onOutput({ variantKey: request.variantKey, buffer: Buffer.from('variant'), durationMs: 25 });
        }
        return { outputs: [], strictFallbacks: [] };
      },
    );
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
      executionPlan: prepareExecutionPlan(createExecutionWorkload(capturePlan, 'auto'), 1),
    });

    await expect(service.execute()).resolves.toBe(2);
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(screenshotSessionVariants).toHaveBeenCalledTimes(1);
    expect(screenshotSessionVariants.mock.calls[0][2]).toEqual([expect.objectContaining({ variantKey: hovered })]);
    expect(screenshotSessionVariants.mock.calls[0][8]).toEqual(expect.any(Function));
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
      executionPlan: prepareExecutionPlan(createExecutionWorkload(capturePlan, 'auto'), 1),
    });

    await expect(service.execute()).resolves.toBe(3);
    expect(screenshotSessionVariants).toHaveBeenCalledTimes(1);
    expect(screenshot.mock.calls.map(([, , variantKey]) => variantKey)).toEqual([
      { isDefault: true, keys: [] },
      focused,
    ]);
    expect(saveScreenshot).toHaveBeenCalledTimes(3);
  });

  it('propagates a screenshot failure and releases its active lease', async () => {
    const service = createScreenshotService({
      workers: [{ screenshot: vi.fn(async () => Promise.reject(new Error('worker screenshot failed'))) }],
      stories: [story],
      fileSystem: { saveScreenshot: vi.fn() } as unknown as FileSystem,
      logger: {
        log: vi.fn(),
        color: { magenta: (value: string) => value },
      } as unknown as Logger,
      forwardConsoleLogs: false,
      trace: false,
    });

    await expect(service.execute()).rejects.toThrow('worker screenshot failed');
  });

  it('preserves an undefined worker rejection as a failed run', async () => {
    const service = createScreenshotService({
      workers: [{ screenshot: vi.fn(() => Promise.reject(undefined)) }],
      stories: [story],
      fileSystem: { saveScreenshot: vi.fn() } as unknown as FileSystem,
      logger: {
        log: vi.fn(),
        color: { magenta: (value: string) => value },
      } as unknown as Logger,
      forwardConsoleLogs: false,
      trace: false,
    });
    let rejected = false;

    try {
      await service.execute();
    } catch (error) {
      rejected = true;
      expect(error).toBeUndefined();
    }

    expect(rejected).toBe(true);
  });

  it('times out a screenshot operation that never settles', async () => {
    const close = vi.fn(async () => {});
    const service = createScreenshotService({
      workers: [{ close, screenshot: vi.fn(() => new Promise(() => {})) }],
      stories: [story],
      fileSystem: { saveScreenshot: vi.fn() } as unknown as FileSystem,
      logger: {
        log: vi.fn(),
        color: { magenta: (value: string) => value },
      } as unknown as Logger,
      forwardConsoleLogs: false,
      trace: false,
      operationTimeoutMs: 25,
    });

    await expect(service.execute()).rejects.toThrow('did not settle within 25 msec');
    expect(close).toHaveBeenCalledOnce();
  });

  it('aborts a stalled screenshot write and releases its buffer after the writer settles', async () => {
    const buffer = Buffer.from('retained output');
    const releaseScreenshotBuffer = vi.fn();
    const saveScreenshot = vi.fn((...args: unknown[]) => {
      const captured = args[3] as Buffer;
      const signal = args[5] as AbortSignal;
      return new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }).finally(() => releaseScreenshotBuffer(captured));
    });
    const service = createScreenshotService({
      workers: [
        {
          screenshot: vi.fn(async () => ({
            buffer,
            succeeded: true,
            variantKeysToPush: [],
            defaultVariantSuffix: '',
          })),
        },
      ],
      stories: [story],
      fileSystem: {
        releaseScreenshotBuffer,
        saveScreenshot,
      } as unknown as FileSystem,
      logger: {
        log: vi.fn(),
        color: { magenta: (value: string) => value },
      } as unknown as Logger,
      forwardConsoleLogs: false,
      trace: false,
      operationTimeoutMs: 25,
    });

    await expect(service.execute()).rejects.toThrow('Screenshot output button--primary::root: did not settle');
    expect(saveScreenshot).toHaveBeenCalledOnce();
    expect(releaseScreenshotBuffer).toHaveBeenCalledWith(buffer);
  });

  it('times out a stalled output flush', async () => {
    const service = createScreenshotService({
      workers: [
        {
          screenshot: vi.fn(async () => ({
            buffer: Buffer.from('png'),
            succeeded: true,
            variantKeysToPush: [],
            defaultVariantSuffix: '',
          })),
        },
      ],
      stories: [story],
      fileSystem: {
        flush: vi.fn(() => new Promise(() => {})),
        saveScreenshot: vi.fn(async () => 'screenshot.png'),
      } as unknown as FileSystem,
      logger: {
        log: vi.fn(),
        color: { magenta: (value: string) => value },
      } as unknown as Logger,
      forwardConsoleLogs: false,
      trace: false,
      operationTimeoutMs: 25,
    });

    await expect(service.execute()).rejects.toThrow('Screenshot output flush did not settle');
  });

  it('preserves both capture and output flush failures', async () => {
    const captureError = new Error('capture failed first');
    const flushError = new Error('flush failed second');
    const service = createScreenshotService({
      workers: [{ screenshot: vi.fn(async () => Promise.reject(captureError)) }],
      stories: [story],
      fileSystem: {
        flush: vi.fn(async () => Promise.reject(flushError)),
        saveScreenshot: vi.fn(),
      } as unknown as FileSystem,
      logger: {
        log: vi.fn(),
        color: { magenta: (value: string) => value },
      } as unknown as Logger,
      forwardConsoleLogs: false,
      trace: false,
    });

    try {
      await service.execute();
      throw new Error('Expected screenshot execution to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([captureError, flushError]);
    }
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('lazy boot failed')), /lazy boot failed/],
    ['never settles', () => new Promise<void>(() => {}), /did not settle within 25 msec/],
  ])('propagates a lazy worker boot that %s', async (_label, bootWorker, expected) => {
    const secondStory = { ...story, id: 'button--secondary', story: 'Secondary' };
    const screenshot = vi.fn(async () => ({
      buffer: Buffer.from('png'),
      succeeded: true,
      variantKeysToPush: [],
      defaultVariantSuffix: '',
    }));
    const service = createScreenshotService({
      workers: [{ screenshot }, { screenshot }],
      initialWorkerCount: 1,
      bootWorker,
      stories: [story, secondStory],
      fileSystem: { saveScreenshot: vi.fn(async () => 'screenshot.png') } as unknown as FileSystem,
      logger: {
        log: vi.fn(),
        color: { magenta: (value: string) => value },
      } as unknown as Logger,
      forwardConsoleLogs: false,
      trace: false,
      operationTimeoutMs: 25,
    });

    await expect(service.execute()).rejects.toThrow(expected);
  });

  it('reuses a runtime-discovered profile for later captures with the same hint', async () => {
    const stories = [
      { ...story, id: 'button--primary', story: 'Primary' },
      { ...story, id: 'button--secondary', story: 'Secondary' },
    ];
    const descriptors = stories.map(item => ({
      id: item.id,
      title: item.kind,
      name: item.story,
      viewportProfileHint: 'desktop',
    }));
    const executionPlan = prepareExecutionPlan(
      createExecutionWorkload(
        createCapturePlan(
          generateCaptureManifest({
            stories: descriptors,
            baseOptions: createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] }),
            deviceDescriptors: [],
            mode: 'managed',
          }),
        ),
        'auto',
      ),
      1,
    );
    const resolvedProfile = {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
    };
    const plannedProfiles: unknown[] = [];
    const screenshot = vi.fn(async (...args: unknown[]) => {
      const plannedCapture = args[8] as { profile: unknown; runtimeProfileResolved?: boolean };
      plannedProfiles.push({
        profile: plannedCapture.profile,
        runtimeProfileResolved: plannedCapture.runtimeProfileResolved,
      });
      return {
        buffer: Buffer.from('png'),
        resolvedProfile,
        succeeded: true,
        variantKeysToPush: [],
        defaultVariantSuffix: '',
      };
    });
    const service = createScreenshotService({
      workers: [{ screenshot }],
      stories,
      executionPlan,
      fileSystem: { saveScreenshot: vi.fn(async () => 'screenshot.png') } as unknown as FileSystem,
      logger: {
        log: vi.fn(),
        color: { magenta: (value: string) => value },
      } as unknown as Logger,
      forwardConsoleLogs: false,
      trace: false,
    });

    await expect(service.execute()).resolves.toBe(2);
    expect(plannedProfiles[0]).toMatchObject({ runtimeProfileResolved: undefined });
    expect(plannedProfiles[1]).toEqual({ profile: resolvedProfile, runtimeProfileResolved: true });
  });
});
