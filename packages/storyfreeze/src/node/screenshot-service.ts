import { time } from './async-utils.js';
import type { FileSystem } from './file.js';
import type { Logger } from './logger.js';
import { storyCostMs, type Story } from './story.js';
import type { VariantKey } from '../shared/types.js';
import { variantKeyIdentifier } from '../shared/screenshot-options-helper.js';

type CaptureRequest = {
  captureId: string;
  requestId: string;
  retryCount: number;
  story: Story;
  variantKey: VariantKey;
};

function captureId(storyId: string, keys: readonly string[]) {
  const variant = keys.length === 0 ? 'root:' : `variant:${keys.map(key => encodeURIComponent(key)).join('/')}`;
  return `${encodeURIComponent(storyId)}::${variant}`;
}

function requestFor(story: Story, variantKey: VariantKey = { isDefault: true, keys: [] }, retryCount = 0) {
  const encodedStory = encodeURIComponent(story.id);
  return {
    captureId: captureId(story.id, variantKey.keys),
    requestId: variantKey.keys.length
      ? `${encodedStory}?keys=${encodeURIComponent(variantKeyIdentifier(variantKey.keys))}`
      : encodedStory,
    retryCount,
    story,
    variantKey,
  } satisfies CaptureRequest;
}

/**
 * Balances viewport groups by estimated cost without splitting a group across
 * lanes, so a worker does not bounce between emulation profiles and a scheduler
 * change cannot alter which stories are each page's first capture. Every tie is
 * resolved deterministically.
 *
 * Balancing by estimated group cost rather than group size still matters because
 * one story expands into one capture per variant, and each of those pays its
 * delay again. Runtime work stealing can split a slow lane after its deterministic
 * initial assignment without changing the initial page lifecycle up front.
 */
export function assignStories(stories: readonly Story[], workerCount: number): Story[][] {
  if (!Number.isSafeInteger(workerCount) || workerCount < 1) throw new Error('workerCount must be at least one.');
  const groups = new Map<string, { stories: Story[]; costMs: number }>();
  for (const story of [...stories].sort((left, right) => left.id.localeCompare(right.id))) {
    const key = story.viewportProfileHint ?? '';
    const group = groups.get(key) ?? { stories: [], costMs: 0 };
    group.stories.push(story);
    group.costMs += storyCostMs(story);
    groups.set(key, group);
  }
  const ordered = [...groups.entries()].sort(
    ([leftKey, left], [rightKey, right]) =>
      right.costMs - left.costMs || right.stories.length - left.stories.length || leftKey.localeCompare(rightKey),
  );
  const assignments = Array.from({ length: workerCount }, () => ({
    stories: [] as Story[],
    costMs: 0,
    storyCount: 0,
  }));
  for (const [, group] of ordered) {
    let target = 0;
    for (let workerId = 1; workerId < assignments.length; workerId += 1) {
      const candidate = assignments[workerId];
      const best = assignments[target];
      if (
        candidate.costMs < best.costMs ||
        (candidate.costMs === best.costMs && candidate.storyCount < best.storyCount)
      ) {
        target = workerId;
      }
    }
    assignments[target].stories.push(...group.stories);
    assignments[target].costMs += group.costMs;
    assignments[target].storyCount += group.stories.length;
  }
  return assignments.map(assignment => assignment.stories);
}

class CaptureQueue {
  private readonly lanes: CaptureRequest[][];
  private readonly known = new Set<string>();
  private readonly waiters: Array<() => void> = [];
  private active = 0;
  private stopped = false;

  constructor(assignments: readonly (readonly Story[])[]) {
    this.lanes = assignments.map(stories => stories.map(story => requestFor(story)));
    for (const lane of this.lanes) for (const request of lane) this.known.add(request.captureId);
  }

  get pendingCount() {
    return this.lanes.reduce((total, lane) => total + lane.length, 0);
  }

  take(workerId: number): CaptureRequest | undefined {
    if (this.stopped) return undefined;
    let request = this.lanes[workerId].shift();
    if (!request) {
      let source = -1;
      for (let candidate = 0; candidate < this.lanes.length; candidate += 1) {
        if (candidate !== workerId && (source < 0 || this.lanes[candidate].length > this.lanes[source].length)) {
          source = candidate;
        }
      }
      if (source >= 0 && this.lanes[source].length > 0) request = this.lanes[source].pop();
    }
    if (request) this.active += 1;
    return request;
  }

  enqueueVariants(workerId: number, story: Story, variants: readonly VariantKey[]) {
    if (this.stopped) return;
    const additions = variants
      .map(variant => requestFor(story, variant))
      .filter(request => {
        if (this.known.has(request.captureId)) return false;
        this.known.add(request.captureId);
        return true;
      });
    this.lanes[workerId].unshift(...additions);
    this.wakeAll();
  }

  retry(workerId: number, request: CaptureRequest) {
    this.active -= 1;
    this.lanes[workerId].unshift(requestFor(request.story, request.variantKey, request.retryCount + 1));
    this.wakeAll();
  }

  complete() {
    this.active -= 1;
    this.wakeAll();
  }

  stop() {
    this.stopped = true;
    this.wakeAll();
  }

  isDrained() {
    return this.active === 0 && this.pendingCount === 0;
  }

  waitForChange() {
    if (this.stopped || this.isDrained() || this.pendingCount > 0) return Promise.resolve();
    return new Promise<void>(resolve => this.waiters.push(resolve));
  }

  private wakeAll() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

/** Executor to capture all stories. */
export interface ScreenshotService {
  execute(): Promise<number>;
}

export interface ScreenshotWorker {
  screenshot(
    requestId: string,
    story: Story,
    variantKey: VariantKey,
    retryCount: number,
    logger: Logger,
    forwardConsoleLogs: boolean,
    fileSystem: FileSystem,
  ): Promise<{
    buffer: Buffer | null;
    succeeded: boolean;
    variantKeysToPush: VariantKey[];
    defaultVariantSuffix?: string;
  }>;
}

export type ScreenshotServiceOptions = {
  logger: Logger;
  workers: ScreenshotWorker[];
  fileSystem: FileSystem;
  stories: Story[];
  forwardConsoleLogs: boolean;
};

/** Create the single deterministic capture queue used by the production runtime. */
export function createScreenshotService({
  fileSystem,
  logger,
  stories,
  workers,
  forwardConsoleLogs,
}: ScreenshotServiceOptions): ScreenshotService {
  if (workers.length === 0) throw new Error('No screenshot workers are available.');
  const queue = new CaptureQueue(assignStories(stories, workers.length));

  return {
    async execute() {
      let captured = 0;
      let firstFailure: { error: unknown } | undefined;
      // Counting and logging happen once a write lands, so they outlive the
      // worker loop and have to be drained separately from the writes.
      const bookkeeping = new Set<Promise<void>>();

      const recordStoredScreenshot = (outputPath: string, durationMs: number, written: Promise<void>) => {
        const task = written.then(() => {
          logger.log(`Screenshot stored: ${logger.color.magenta(outputPath)} in ${durationMs} msec.`);
          captured += 1;
        });
        bookkeeping.add(task);
        void task.then(
          () => {
            bookkeeping.delete(task);
          },
          error => {
            bookkeeping.delete(task);
            // A failed write or its success bookkeeping is fail-stop: stop
            // handing out work immediately.
            if (!firstFailure) firstFailure = { error };
            queue.stop();
          },
        );
      };

      const runWorker = async (worker: ScreenshotWorker, workerId: number) => {
        while (!firstFailure) {
          const request = queue.take(workerId);
          if (!request) {
            if (queue.isDrained()) return;
            await queue.waitForChange();
            continue;
          }

          try {
            const [result, durationMs] = await time(
              worker.screenshot(
                request.requestId,
                request.story,
                request.variantKey,
                request.retryCount,
                logger,
                forwardConsoleLogs,
                fileSystem,
              ),
            );
            if (!result.succeeded) {
              queue.retry(workerId, request);
              continue;
            }

            if (result.buffer) {
              const suffix =
                request.variantKey.isDefault && result.defaultVariantSuffix
                  ? [result.defaultVariantSuffix]
                  : request.variantKey.keys;
              const logicalId = JSON.stringify({ storyId: request.story.id, variantKey: request.variantKey });
              const { outputPath, written } = fileSystem.beginSaveScreenshot(
                request.story.kind,
                request.story.story,
                suffix,
                result.buffer,
                logicalId,
              );
              recordStoredScreenshot(outputPath, durationMs, written);
            }
            queue.enqueueVariants(workerId, request.story, result.variantKeysToPush);
            queue.complete();
          } catch (error) {
            queue.complete();
            if (!firstFailure) firstFailure = { error };
            queue.stop();
          }
        }
      };

      const results = await Promise.allSettled(workers.map((worker, workerId) => runWorker(worker, workerId)));
      for (const result of results) {
        if (result.status === 'rejected' && !firstFailure) firstFailure = { error: result.reason };
      }
      let flushFailure: { error: unknown } | undefined;
      try {
        // Awaits every started write.
        await fileSystem.flush();
      } catch (error) {
        flushFailure = { error };
      }
      // Then awaits the counting and logging chained onto those writes, so the
      // returned total can never miss a screenshot that has already landed.
      while (bookkeeping.size > 0) {
        await Promise.allSettled([...bookkeeping]);
      }
      if (firstFailure && flushFailure) {
        throw new AggregateError([firstFailure.error, flushFailure.error], 'Capture and output flush both failed.');
      }
      if (firstFailure) throw firstFailure.error;
      if (flushFailure) throw flushFailure.error;
      return captured;
    },
  };
}
