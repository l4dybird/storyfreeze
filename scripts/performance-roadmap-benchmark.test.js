const assert = require('node:assert/strict');
const test = require('node:test');
const {
  comparisonRatios,
  executionOrder,
  parseDiagnostics,
  percentile,
  summarizeRuns,
} = require('./performance-roadmap-benchmark.js');

test('parses roadmap capture diagnostics and fallback console timings', () => {
  const log = [
    'Found 1 stories.',
    'Screenshot stored: example.png in 123 msec.',
    'STORYFREEZE_CAPTURE_DIAGNOSTIC={"type":"capture-output","durationMs":120}',
    'STORYFREEZE_CAPTURE_DIAGNOSTIC={"type":"capture-complete","outcome":"retry"}',
  ].join('\n');
  const parsed = parseDiagnostics(log);
  assert.equal(parsed.storyCount, 1);
  assert.deepEqual(parsed.captureTimesMs, [120]);
  assert.equal(parsed.retryCount, 1);
});

test('summarizes wall, capture, phase, and correctness samples', () => {
  const runs = [
    {
      browserCrashCount: 0,
      captureTimesMs: [100, 200],
      metricsTimesMs: [30, 40],
      navigationTimesMs: [50, 60],
      retryCount: 0,
      screenshotTimesMs: [10, 20],
      sessionCaptureCount: 1,
      success: true,
      timeoutCount: 0,
      wallTimeMs: 500,
    },
    {
      browserCrashCount: 0,
      captureTimesMs: [300],
      metricsTimesMs: [50],
      navigationTimesMs: [70],
      retryCount: 0,
      screenshotTimesMs: [30],
      sessionCaptureCount: 2,
      success: true,
      timeoutCount: 0,
      wallTimeMs: 600,
    },
  ];
  assert.equal(percentile([3, 1, 2], 0.95), 3);
  assert.deepEqual(summarizeRuns(runs), {
    browserCrashCount: 0,
    captureP50Ms: 200,
    captureP95Ms: 300,
    captureSamples: 3,
    metricsP50Ms: 40,
    metricsP95Ms: 50,
    navigationCount: 3,
    navigationP50Ms: 60,
    navigationP95Ms: 70,
    retryCount: 0,
    screenshotP50Ms: 20,
    screenshotP95Ms: 30,
    sessionCaptureCount: 3,
    successfulRuns: 2,
    timeoutCount: 0,
    totalRuns: 2,
    wallP50Ms: 500,
    wallP95Ms: 600,
  });
});

test('rotates all performance lanes and compares Phase 3 directly with Phase 2', () => {
  assert.deepEqual(executionOrder(1), ['stable', 'topology', 'optimized']);
  assert.deepEqual(executionOrder(2), ['topology', 'optimized', 'stable']);
  assert.deepEqual(executionOrder(3), ['optimized', 'stable', 'topology']);
  assert.deepEqual(
    comparisonRatios(
      { captureP50Ms: 60, captureP95Ms: 90, navigationCount: 1, wallP50Ms: 70, wallP95Ms: 100 },
      { captureP50Ms: 100, captureP95Ms: 120, navigationCount: 10, wallP50Ms: 140, wallP95Ms: 200 },
    ),
    { captureP50: 0.6, captureP95: 0.75, navigationCount: 0.1, wallP50: 0.5, wallP95: 0.5 },
  );
});
