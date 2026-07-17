import { describe, expect, it, vi } from 'vite-plus/test';
import { createBaseScreenshotOptions } from '../shared/screenshot-options-helper.js';
import { generateCaptureManifest } from './capture-manifest.js';
import { assignCapturePlan, createCapturePlan } from './capture-plan.js';
import {
  assignWorkersToBrowserProcesses,
  BrowserRuntimeOrchestrator,
  selectTopology,
  selectWorkerCount,
  validateBrowserTopology,
} from './browser-topology.js';
import type { BrowserBackend } from './browser-backend.js';

function plan(captureCount: number, viewports = ['800x600']) {
  const stories = Array.from({ length: captureCount }, (_, index) => ({
    id: `story--${index}`,
    title: 'Story',
    name: String(index),
  }));
  return createCapturePlan(
    generateCaptureManifest({
      stories,
      baseOptions: createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports }),
      deviceDescriptors: [],
      generatedAt: '2026-07-17T00:00:00.000Z',
      mode: 'simple',
    }),
  );
}

function runtimeDiscoveryPlan(captureCount: number) {
  const stories = Array.from({ length: captureCount }, (_, index) => ({
    id: `runtime--${index}`,
    title: 'Runtime',
    name: String(index),
  }));
  return createCapturePlan(
    generateCaptureManifest({
      stories,
      baseOptions: createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports: ['800x600'] }),
      deviceDescriptors: [],
      generatedAt: '2026-07-17T00:00:00.000Z',
      mode: 'managed',
    }),
  );
}

describe(selectTopology, () => {
  it('preserves process/context presets and adds the 2x2 hybrid topology', () => {
    const capturePlan = plan(8);
    expect(selectTopology(capturePlan, { cpuCount: 4 }, 4, 'process').topology).toEqual({
      browserProcessCount: 4,
      contextsPerBrowser: 1,
      workerCount: 4,
    });
    expect(selectTopology(capturePlan, { cpuCount: 4 }, 4, 'context').topology).toEqual({
      browserProcessCount: 1,
      contextsPerBrowser: 4,
      workerCount: 4,
    });
    expect(selectTopology(capturePlan, { cpuCount: 4 }, 4, 'hybrid').topology).toEqual({
      browserProcessCount: 2,
      contextsPerBrowser: 2,
      workerCount: 4,
    });
  });

  it('represents the 2x1 and 1x2 small-plan topology candidates', () => {
    const capturePlan = plan(2);
    expect(selectTopology(capturePlan, { cpuCount: 4 }, 4, 'process').topology).toEqual({
      browserProcessCount: 2,
      contextsPerBrowser: 1,
      workerCount: 2,
    });
    expect(selectTopology(capturePlan, { cpuCount: 4 }, 4, 'hybrid').topology).toEqual({
      browserProcessCount: 2,
      contextsPerBrowser: 1,
      workerCount: 2,
    });
    expect(selectTopology(capturePlan, { cpuCount: 4 }, 4, 'context').topology).toEqual({
      browserProcessCount: 1,
      contextsPerBrowser: 2,
      workerCount: 2,
    });
  });

  it('boots no more workers than captures and grows beyond the initial profile groups only for queue depth', () => {
    expect(selectWorkerCount(plan(2), 4)).toEqual({ initialWorkerCount: 1, workerCount: 2 });
    expect(selectWorkerCount(plan(6), 4)).toEqual({ initialWorkerCount: 1, workerCount: 4 });
    expect(selectWorkerCount(plan(8), 4)).toEqual({ initialWorkerCount: 1, workerCount: 4 });
  });

  it('reserves dormant workers for runtime-discovered variants without booting them initially', () => {
    expect(selectWorkerCount(runtimeDiscoveryPlan(1), 4)).toEqual({ initialWorkerCount: 1, workerCount: 4 });
  });

  it('uses the high-cost ratio to select consolidated, hybrid, or separate-process auto topologies', () => {
    const highCostPlan = plan(8);
    const lowCostPlan = plan(8);
    lowCostPlan.captures.forEach(capture => {
      capture.options.fullPage = false;
      capture.profile.deviceScaleFactor = 1;
    });
    expect(
      selectTopology(highCostPlan, { cpuCount: 4, availableMemoryBytes: 1024 ** 3 }, 4, 'auto').topology,
    ).toMatchObject({ browserProcessCount: 1, workerCount: 4 });
    expect(
      selectTopology(lowCostPlan, { cpuCount: 4, availableMemoryBytes: 8 * 1024 ** 3 }, 4, 'auto').topology,
    ).toEqual({ browserProcessCount: 2, contextsPerBrowser: 2, workerCount: 4 });
    expect(
      selectTopology(highCostPlan, { cpuCount: 4, availableMemoryBytes: 8 * 1024 ** 3 }, 4, 'auto').topology,
    ).toEqual({ browserProcessCount: 4, contextsPerBrowser: 1, workerCount: 4 });
  });

  it('rejects a topology with fewer context slots than workers', () => {
    expect(() => validateBrowserTopology({ browserProcessCount: 1, contextsPerBrowser: 2, workerCount: 3 })).toThrow(
      'enough context slots',
    );
  });
});

describe(BrowserRuntimeOrchestrator, () => {
  it('maps each worker to one coordinator and closes every process generation', async () => {
    const capturePlan = plan(8);
    const workers = assignCapturePlan(capturePlan, 4);
    const mapping = assignWorkersToBrowserProcesses(workers, {
      browserProcessCount: 2,
      contextsPerBrowser: 2,
      workerCount: 4,
    });
    expect(mapping).toHaveLength(4);
    expect(new Set(mapping)).toEqual(new Set([0, 1]));

    const close = vi.fn(async () => {});
    const initial = { close } as never;
    const backend = { name: 'playwright' } as BrowserBackend;
    const runtime = new BrowserRuntimeOrchestrator(
      backend,
      {},
      { browserProcessCount: 2, contextsPerBrowser: 2, workerCount: 4 },
      workers,
      initial,
    );
    expect(runtime.sessionSourceForWorker(0)).toBe(runtime.coordinators[runtime.workerProcessIds[0]]);
    vi.spyOn(runtime.coordinators[1], 'close').mockResolvedValue(undefined);
    await runtime.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
