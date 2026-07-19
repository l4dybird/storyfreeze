const assert = require('node:assert/strict');
const test = require('node:test');

const {
  benchmarkProfilesForComparison,
  chromiumProcessType,
  findObservedProcesses,
  isolationExecutionOrder,
  parseParallel,
  processIdentity,
  summarizeRuns,
} = require('./browser-performance-benchmark.js');

test('uses complete measured rotations for each comparison profile', () => {
  assert.deepEqual(benchmarkProfilesForComparison('topology'), {
    pr: { measuredRuns: 3, warmupRuns: 1 },
    record: { measuredRuns: 9, warmupRuns: 2 },
  });
  assert.deepEqual(benchmarkProfilesForComparison('isolation').record, { measuredRuns: 10, warmupRuns: 2 });
});

test('rotates every benchmark lane through every execution position', () => {
  const topology = ['process', 'context', 'hybrid'];
  assert.deepEqual(isolationExecutionOrder(1, topology, 'process'), topology);
  assert.deepEqual(isolationExecutionOrder(2, topology, 'process'), ['context', 'hybrid', 'process']);
  assert.deepEqual(isolationExecutionOrder(3, topology, 'process'), ['hybrid', 'process', 'context']);
  assert.deepEqual(isolationExecutionOrder(2, ['process', 'context'], 'process'), ['context', 'process']);
});

test('accepts exploratory parallel values without accepting arbitrary worker counts', () => {
  assert.equal(parseParallel('1'), 1);
  assert.equal(parseParallel('16'), 16);
  assert.throws(() => parseParallel('3'), /Unsupported benchmark parallel value/);
  assert.throws(() => parseParallel('many'), /Unsupported benchmark parallel value/);
});

test('classifies independently sampled Chromium process types', () => {
  const chromium = 'chrome';
  assert.equal(chromiumProcessType({ argv: [chromium] }), 'browser');
  assert.equal(chromiumProcessType({ argv: [chromium, '--type=renderer'] }), 'renderer');
  assert.equal(chromiumProcessType({ argv: [chromium, '--type=gpu-process'] }), 'gpu-process');
  assert.equal(chromiumProcessType({ argv: [chromium, '--type=utility'] }), 'utility');
  assert.equal(chromiumProcessType({ argv: [chromium, '--type=zygote'] }), 'zygote');
  assert.equal(chromiumProcessType({ argv: [chromium, '--type=broker'] }), 'other');
});

test('tracks observed processes by PID and Linux start time', () => {
  const first = { pid: 101, startedAt: '1000' };
  const reusedPid = { pid: 101, startedAt: '2000' };
  const second = { pid: 202, startedAt: '3000' };
  const processes = new Map([
    [reusedPid.pid, reusedPid],
    [second.pid, second],
  ]);

  assert.equal(processIdentity(first), '101:1000');
  assert.deepEqual(findObservedProcesses(processes, new Set(['101:1000', '202:3000'])), [second]);
});

test('summarizes capture/runtime phases, queue utilization, and topology', () => {
  const summary = summarizeRuns([
    {
      browserCrashCount: 0,
      browserCloseErrorCount: 0,
      browserCloseEventCount: 5,
      captureDiagnostics: [
        { durationMs: 100, phase: 'navigation', state: 'end', type: 'capture-phase' },
        { durationMs: 250, phase: 'capture-worker-boot', state: 'end', type: 'runtime-phase' },
        { durationMs: 7, state: 'start', type: 'queue-task' },
        {
          durationMs: 3,
          maximumBufferedBytes: 64,
          peakActiveReservations: 2,
          peakRetainedBytes: 32,
          reservationBytes: 16,
          state: 'acquired',
          type: 'screenshot-budget',
        },
        {
          actualBytes: 8,
          maximumBufferedBytes: 64,
          peakActiveReservations: 2,
          peakRetainedBytes: 32,
          state: 'captured',
          type: 'screenshot-budget',
        },
        {
          busyWorkerUtilization: 0.75,
          peakInFlight: 4,
          peakQueued: 9,
          type: 'queue-summary',
        },
        { type: 'browser-launch' },
      ],
      cpuTimeMs: 500,
      peakBrowserRootCount: 1,
      peakChromiumProcessCount: 8,
      peakChromiumProcessCountsByType: { browser: 1, renderer: 4 },
      peakProcessCount: 10,
      peakTreeRssBytes: 1000,
      pngCount: 1,
      retryCount: 0,
      residualChromiumProcessCount: 0,
      runtimeBrowserLaunchCount: 1,
      runtimeDisposeEventCount: 1,
      storyDurationsMs: [800],
      success: true,
      timeoutCount: 0,
      uniqueBrowserLaunchCount: 1,
      wallTimeMs: 1200,
    },
  ]);

  assert.deepEqual(summary.diagnostics.phaseTimings.navigation, { p50Ms: 100, p95Ms: 100, samples: 1 });
  assert.deepEqual(summary.diagnostics.runtimePhaseTimings['capture-worker-boot'], {
    p50Ms: 250,
    p95Ms: 250,
    samples: 1,
  });
  assert.deepEqual(summary.diagnostics.queue, {
    busyWorkerUtilizationP50: 0.75,
    busyWorkerUtilizationP95: 0.75,
    peakInFlight: 4,
    peakQueued: 9,
    waitMaxMs: 7,
    waitP50Ms: 7,
    waitP95Ms: 7,
    waitSamples: 1,
  });
  assert.deepEqual(summary.diagnostics.screenshotBudget, {
    actualBytesMax: 8,
    actualBytesP50: 8,
    actualBytesP95: 8,
    capturedSamples: 1,
    failedSamples: 0,
    maximumBufferedBytes: 64,
    peakActiveReservations: 2,
    peakRetainedBytes: 32,
    reservationBytesP50: 16,
    reservationBytesP95: 16,
    waitMaxMs: 3,
    waitP50Ms: 3,
    waitP95Ms: 3,
    waitSamples: 1,
  });
  assert.equal(summary.maxPeakProcessCount, 10);
  assert.equal(summary.maxUniqueBrowserLaunchCount, 1);
  assert.equal(summary.maxRuntimeBrowserLaunchCount, 1);
  assert.equal(summary.maxResidualChromiumProcessCount, 0);
  assert.equal(summary.sessionOrBrowserCloseErrorCount, 0);
  assert.deepEqual(summary.maxChromiumProcessCountsByType, { browser: 1, renderer: 4 });
});
