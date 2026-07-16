const assert = require('node:assert/strict');
const test = require('node:test');

const { chromiumProcessType, parseParallel, summarizeRuns } = require('./browser-performance-benchmark.js');

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

test('summarizes capture/runtime phases, queue utilization, and topology', () => {
  const summary = summarizeRuns([
    {
      browserCrashCount: 0,
      captureDiagnostics: [
        { durationMs: 100, phase: 'navigation', state: 'end', type: 'capture-phase' },
        { durationMs: 250, phase: 'capture-worker-boot', state: 'end', type: 'runtime-phase' },
        { durationMs: 7, state: 'start', type: 'queue-task' },
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
      runtimeBrowserLaunchCount: 1,
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
  assert.equal(summary.maxPeakProcessCount, 10);
  assert.equal(summary.maxUniqueBrowserLaunchCount, 1);
  assert.equal(summary.maxRuntimeBrowserLaunchCount, 1);
  assert.deepEqual(summary.maxChromiumProcessCountsByType, { browser: 1, renderer: 4 });
});
