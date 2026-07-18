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
});
