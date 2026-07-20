import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { FileSystem } from './file.js';
import { Logger } from './logger.js';
import { assignStories, createScreenshotService, type ScreenshotWorker } from './screenshot-service.js';
import type { Story } from './story.js';
import type { MainOptions } from './types.js';

const story = (id: string, viewportProfileHint?: string): Story => ({
  id,
  kind: 'Example',
  story: id,
  version: 'v5',
  ...(viewportProfileHint ? { viewportProfileHint } : {}),
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

  it('assigns the largest viewport groups first with deterministic story order', () => {
    const assignments = assignStories(
      [story('mobile-b', 'mobile'), story('desktop-b', 'desktop'), story('mobile-a', 'mobile'), story('plain')],
      2,
    );
    expect(assignments.map(lane => lane.map(item => item.id))).toEqual([
      ['mobile-a', 'mobile-b'],
      ['plain', 'desktop-b'],
    ]);
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
