import { describe, expect, it } from 'vite-plus/test';
import { createBaseScreenshotOptions } from '../shared/screenshot-options-helper.js';
import { selectWorkerCount } from './browser-topology.js';
import { generateCaptureManifest } from './capture-manifest.js';
import { createCapturePlan } from './capture-plan.js';
import { createExecutionWorkload, prepareExecutionPlan } from './execution-plan.js';

function planWithVariants() {
  return createCapturePlan(
    generateCaptureManifest({
      stories: [
        {
          id: 'button--primary',
          title: 'Button',
          name: 'Primary',
          eligibility: 'static',
          screenshotOptions: {
            variants: {
              focused: { focus: '#button' },
              hovered: { hover: '#button' },
            },
          },
        },
      ],
      baseOptions: createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] }),
      deviceDescriptors: [],
      generatedAt: '2026-07-18T00:00:00.000Z',
      mode: 'managed',
    }),
  );
}

describe(createExecutionWorkload, () => {
  it('batches session variants while retaining dormant auto-fallback capacity', () => {
    const workload = createExecutionWorkload(planWithVariants(), 'auto');

    expect(workload.workItems).toHaveLength(1);
    expect(workload.workItems[0]).toMatchObject({ kind: 'story-session', storyId: 'button--primary' });
    expect(workload.workItems[0].captures).toHaveLength(3);
    expect(selectWorkerCount(workload, 4)).toEqual({ initialWorkerCount: 1, workerCount: 4 });
  });

  it('keeps one authoritative work-item order and includes transition cost in worker load', () => {
    const capturePlan = createCapturePlan(
      generateCaptureManifest({
        stories: [
          { id: 'alpha--default', title: 'Alpha', name: 'Default' },
          { id: 'beta--default', title: 'Beta', name: 'Default' },
        ],
        baseOptions: createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] }),
        deviceDescriptors: [],
        generatedAt: '2026-07-18T00:00:00.000Z',
        mode: 'simple',
      }),
    );
    const prepared = prepareExecutionPlan(createExecutionWorkload(capturePlan, 'strict'), 1);

    expect(prepared.workers[0].workItems.map(item => item.storyId)).toEqual(['alpha--default', 'beta--default']);
    expect(prepared.workers[0].estimatedRemainingMs).toBe(capturePlan.estimatedCostMs + 25);
  });

  it('groups runtime-discovery stories by their static viewport key', () => {
    const capturePlan = createCapturePlan(
      generateCaptureManifest({
        stories: Array.from({ length: 8 }, (_, index) => ({
          id: `story-${index}`,
          title: 'Story',
          name: String(index),
          viewportProfileHint: index % 2 === 0 ? 'desktop' : 'mobile',
        })),
        baseOptions: createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] }),
        deviceDescriptors: [],
        generatedAt: '2026-07-19T00:00:00.000Z',
        mode: 'managed',
      }),
    );
    const workload = createExecutionWorkload(capturePlan, 'strict');
    const prepared = prepareExecutionPlan(workload, 4);

    expect(capturePlan.captures.every(capture => capture.executionMode === 'runtime-discovery')).toBe(true);
    expect(workload.profileCount).toBe(2);
    expect(selectWorkerCount(workload, 4)).toEqual({ initialWorkerCount: 4, workerCount: 4 });
    expect(prepared.workers.map(worker => new Set(worker.workItems.map(item => item.profileHint)).size)).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it('balances a dominant viewport group when profiles outnumber workers', () => {
    const profileHints = [...Array.from({ length: 20 }, () => 'desktop'), 'mobile', 'tablet', 'wide', 'compact'];
    const capturePlan = createCapturePlan(
      generateCaptureManifest({
        stories: profileHints.map((viewportProfileHint, index) => ({
          id: `story-${index}`,
          title: 'Story',
          name: String(index),
          viewportProfileHint,
        })),
        baseOptions: createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] }),
        deviceDescriptors: [],
        generatedAt: '2026-07-19T00:00:00.000Z',
        mode: 'managed',
      }),
    );
    const workload = createExecutionWorkload(capturePlan, 'strict');
    const prepared = prepareExecutionPlan(workload, 4);

    expect(workload.profileCount).toBe(5);
    expect(
      prepared.workers.filter(worker => worker.workItems.some(item => item.profileHint === 'desktop')),
    ).toHaveLength(4);
    expect(prepared.workers.map(worker => worker.workItems.length).sort((left, right) => left - right)).toEqual([
      6, 6, 6, 6,
    ]);
  });
});
