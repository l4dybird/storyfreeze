import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { FileSystem } from './file.js';
import { Logger } from './logger.js';
import { assignStories, createScreenshotService, type ScreenshotWorker } from './screenshot-service.js';
import type { Story } from './story.js';
import type { MainOptions } from './types.js';

const story = (id: string, viewportProfileHint?: string, estimatedCostMs?: number): Story => ({
  id,
  kind: 'Example',
  story: id,
  version: 'v5',
  ...(viewportProfileHint ? { viewportProfileHint } : {}),
  ...(estimatedCostMs === undefined ? {} : { estimatedCostMs }),
});

describe(createScreenshotService, () => {
  const roots: string[] = [];

  async function output(parallel = 4) {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storyfreeze-service-'));
    roots.push(outDir);
    return new FileSystem({ outDir, flat: false, parallel } as MainOptions);
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  it('balances viewport groups while keeping each group intact', () => {
    const assignments = assignStories(
      [story('mobile-b', 'mobile'), story('desktop-b', 'desktop'), story('mobile-a', 'mobile'), story('plain')],
      2,
    );
    expect(assignments.map(lane => lane.map(item => item.id))).toEqual([
      ['mobile-a', 'mobile-b'],
      ['plain', 'desktop-b'],
    ]);
  });

  it('uses estimated cost when balancing whole viewport groups', () => {
    // Two three-viewport stories cost as much as six plain ones. The expensive
    // group remains intact, while the cheaper group is placed on the other lane.
    const assignments = assignStories(
      [
        story('wide-a', 'wide', 1500),
        story('wide-b', 'wide', 1500),
        story('plain-a', 'plain'),
        story('plain-b', 'plain'),
        story('plain-c', 'plain'),
      ],
      2,
    );
    const lanes = assignments.map(lane => lane.map(item => item.id));
    expect(lanes).toEqual([
      ['wide-a', 'wide-b'],
      ['plain-a', 'plain-b', 'plain-c'],
    ]);
  });

  it('leaves a single viewport group intact for deterministic runtime stealing', () => {
    const assignments = assignStories([story('a'), story('b'), story('c', undefined, 2000)], 2);
    expect(assignments.map(lane => lane.map(item => item.id))).toEqual([['a', 'b', 'c'], []]);
  });

  it('falls back to the default estimate for a group without cost hints', () => {
    const assignments = assignStories(
      [story('hinted', 'wide', 900), story('plain-a', 'plain'), story('plain-b', 'plain')],
      2,
    );
    // 900 outweighs a single default 500, but not two of them.
    expect(assignments.map(lane => lane.map(item => item.id))).toEqual([['plain-a', 'plain-b'], ['hinted']]);
  });

  it('adds discovered variants to the same worker before its next story', async () => {
    const calls: string[] = [];
    const worker: ScreenshotWorker = {
      screenshot: vi.fn(async (_requestId, currentStory, variantKey) => {
        calls.push(`${currentStory.id}:${variantKey.keys.join('/') || 'default'}`);
        return {
          buffer: Buffer.from(calls.at(-1)!),
          succeeded: true,
          variantKeysToPush: variantKey.isDefault
            ? [
                { isDefault: false, keys: ['focused'] },
                { isDefault: false, keys: ['clicked'] },
              ]
            : [],
        };
      }),
    };
    const captured = await createScreenshotService({
      workers: [worker],
      stories: [story('a'), story('b')],
      fileSystem: await output(1),
      logger: new Logger('silent'),
      forwardConsoleLogs: false,
    }).execute();
    expect(captured).toBe(6);
    expect(calls.slice(0, 4)).toEqual(['a:default', 'a:focused', 'a:clicked', 'b:default']);
  });

  it('retries on the owning worker without duplicating the output', async () => {
    let attempts = 0;
    const worker: ScreenshotWorker = {
      screenshot: vi.fn(async () => ({
        buffer: attempts++ === 0 ? null : Buffer.from('ok'),
        succeeded: attempts > 1,
        variantKeysToPush: [],
      })),
    };
    await expect(
      createScreenshotService({
        workers: [worker],
        stories: [story('retry')],
        fileSystem: await output(1),
        logger: new Logger('silent'),
        forwardConsoleLogs: false,
      }).execute(),
    ).resolves.toBe(1);
    expect(worker.screenshot).toHaveBeenCalledTimes(2);
  });

  it('counts and logs a screenshot only once its background write has landed', async () => {
    const fileSystem = await output(1);
    let releaseWrite = () => {};
    const writeReleased = new Promise<void>(resolve => (releaseWrite = resolve));
    const realBegin = fileSystem.beginSaveScreenshot.bind(fileSystem);
    vi.spyOn(fileSystem, 'beginSaveScreenshot').mockImplementation((...args) => {
      const started = realBegin(...args);
      return { outputPath: started.outputPath, written: writeReleased.then(() => started.written) };
    });
    const logger = new Logger('normal');
    const logged: string[] = [];
    vi.spyOn(logger, 'log').mockImplementation((...message) => void logged.push(message.join(' ')));

    const worker: ScreenshotWorker = {
      screenshot: vi.fn(async () => ({ buffer: Buffer.from('png'), succeeded: true, variantKeysToPush: [] })),
    };
    const running = createScreenshotService({
      workers: [worker],
      stories: [story('deferred')],
      fileSystem,
      logger,
      forwardConsoleLogs: false,
    }).execute();

    // The capture loop has finished while the write is still outstanding, so
    // nothing may have been reported as stored yet.
    await vi.waitFor(() => expect(worker.screenshot).toHaveBeenCalledOnce());
    expect(logged.filter(line => line.includes('Screenshot stored'))).toHaveLength(0);

    releaseWrite();
    await expect(running).resolves.toBe(1);
    expect(logged.filter(line => line.includes('Screenshot stored'))).toHaveLength(1);
  });

  it('fails the run and stops every worker when a background write rejects', async () => {
    const fileSystem = await output(2);
    vi.spyOn(fileSystem, 'beginSaveScreenshot').mockImplementation((kind, storyName, suffix) => ({
      outputPath: `${kind}/${storyName}${suffix.join('_')}.png`,
      written: Promise.reject(new Error('disk full')),
    }));
    const captures: string[] = [];
    const worker: ScreenshotWorker = {
      screenshot: vi.fn(async (_requestId, currentStory) => {
        captures.push(currentStory.id);
        return { buffer: Buffer.from('png'), succeeded: true, variantKeysToPush: [] };
      }),
    };

    await expect(
      createScreenshotService({
        workers: [worker],
        stories: [story('a'), story('b'), story('c'), story('d'), story('e')],
        fileSystem,
        logger: new Logger('silent'),
        forwardConsoleLogs: false,
      }).execute(),
    ).rejects.toThrow('disk full');
    // Fail-stop: the queue is stopped as soon as the first write rejects rather
    // than after every story has been captured.
    expect(captures.length).toBeLessThan(5);
  });

  it('fails instead of hanging when success bookkeeping throws', async () => {
    const logger = new Logger('normal');
    vi.spyOn(logger, 'log').mockImplementation(() => {
      throw new Error('log failed');
    });
    const worker: ScreenshotWorker = {
      screenshot: vi.fn(async () => ({ buffer: Buffer.from('png'), succeeded: true, variantKeysToPush: [] })),
    };

    await expect(
      createScreenshotService({
        workers: [worker],
        stories: [story('logging')],
        fileSystem: await output(1),
        logger,
        forwardConsoleLogs: false,
      }).execute(),
    ).rejects.toThrow('log failed');
  });

  it('stops assignment after the first failure and drains the other in-flight worker', async () => {
    let markSecondStarted = () => {};
    const secondStarted = new Promise<void>(resolve => (markSecondStarted = resolve));
    let releaseSecond = () => {};
    const secondReleased = new Promise<void>(resolve => (releaseSecond = resolve));
    const calls: string[] = [];
    const first: ScreenshotWorker = {
      screenshot: vi.fn(async (_requestId, currentStory) => {
        calls.push(currentStory.id);
        await secondStarted;
        throw new Error('first failed');
      }),
    };
    const second: ScreenshotWorker = {
      screenshot: vi.fn(async (_requestId, currentStory) => {
        calls.push(currentStory.id);
        markSecondStarted();
        await secondReleased;
        return { buffer: Buffer.from('in-flight'), succeeded: true, variantKeysToPush: [] };
      }),
    };
    const running = createScreenshotService({
      workers: [first, second],
      stories: [story('a'), story('b'), story('c'), story('d')],
      fileSystem: await output(2),
      logger: new Logger('silent'),
      forwardConsoleLogs: false,
    }).execute();
    await secondStarted;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    releaseSecond();
    await expect(running).rejects.toThrow('first failed');
    expect(calls.sort()).toEqual(['a', 'd']);
  });
});
