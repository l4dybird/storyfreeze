import { describe, expect, it } from 'vite-plus/test';
import { createBaseScreenshotOptions } from '../shared/screenshot-options-helper.js';
import { generateCaptureManifest } from './capture-manifest.js';
import {
  assignCapturePlan,
  assignmentCost,
  createCapturePlan,
  profileSwitchCost,
  type PlannedCapture,
  type WorkerPlan,
} from './capture-plan.js';

const desktop = {
  width: 800,
  height: 600,
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  isLandscape: true,
};
const resized = { ...desktop, width: 1024 };
const highDpr = { ...desktop, deviceScaleFactor: 2 };
const mobile = { ...desktop, width: 390, height: 844, isMobile: true, hasTouch: true, isLandscape: false };

describe(profileSwitchCost, () => {
  it('weights mobile/touch, DPR/orientation, and resize switches separately', () => {
    expect(profileSwitchCost(undefined, desktop)).toBe(0);
    expect(profileSwitchCost(desktop, desktop)).toBe(0);
    expect(profileSwitchCost(desktop, resized)).toBe(15);
    expect(profileSwitchCost(desktop, highDpr)).toBe(100);
    expect(profileSwitchCost(desktop, mobile)).toBe(350);
  });
});

describe(assignCapturePlan, () => {
  it('assigns every capture exactly once while balancing estimated worker cost', () => {
    const baseOptions = createBaseScreenshotOptions({
      delay: 0,
      disableWaitAssets: false,
      viewports: ['800x600', 'Phone'],
    });
    const manifest = generateCaptureManifest({
      stories: [
        { id: 'button--primary', title: 'Button', name: 'Primary' },
        { id: 'dialog--default', title: 'Dialog', name: 'Default' },
      ],
      baseOptions,
      deviceDescriptors: [{ name: 'Phone', viewport: mobile }],
      generatedAt: '2026-07-17T00:00:00.000Z',
      mode: 'managed',
    });
    const plan = createCapturePlan(manifest);
    const workers = assignCapturePlan(plan, 2);
    const captures = workers.flatMap(worker => worker.captures);

    expect(captures).toHaveLength(plan.captures.length);
    expect(new Set(captures.map(capture => capture.captureId)).size).toBe(plan.captures.length);
    expect(workers.every(worker => worker.estimatedRemainingMs > 0)).toBe(true);
  });

  it('includes affinity penalties in assignment cost', () => {
    const capture = { storyId: 'a', profile: mobile, estimatedCostMs: 500 } as PlannedCapture;
    const worker = {
      workerId: 0,
      captures: [],
      estimatedRemainingMs: 200,
      lastProfile: desktop,
      lastStoryId: 'b',
    } satisfies WorkerPlan;
    expect(assignmentCost(worker, capture)).toBe(575);
  });
});
