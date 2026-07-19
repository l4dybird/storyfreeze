const assert = require('node:assert/strict');
const test = require('node:test');
const {
  comparisonRatios,
  executionOrder,
  fatalBenchmarkRecord,
  parseDiagnostics,
  percentile,
  profileDefinitions,
  summarizeRuns,
} = require('./performance-roadmap-benchmark.js');

test('creates an uploadable fatal benchmark record', () => {
  assert.deepEqual(profileDefinitions.record, { measuredRuns: 9, warmupRuns: 2 });
  const record = fatalBenchmarkRecord(new Error('benchmark exploded'));
  assert.equal(record.kind, 'performance-roadmap-matrix');
  assert.equal(record.measuredRuns, 3);
  assert.match(record.fatalError, /benchmark exploded/);
  assert.deepEqual(record.gate, { errors: [record.fatalError], passed: false });
});

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
      screenshotBudgetEvents: [
        {
          durationMs: 4,
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
      ],
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
      screenshotBudgetEvents: [
        {
          durationMs: 6,
          maximumBufferedBytes: 64,
          peakActiveReservations: 3,
          peakRetainedBytes: 48,
          reservationBytes: 24,
          state: 'acquired',
          type: 'screenshot-budget',
        },
        {
          actualBytes: 12,
          maximumBufferedBytes: 64,
          peakActiveReservations: 3,
          peakRetainedBytes: 48,
          state: 'captured',
          type: 'screenshot-budget',
        },
      ],
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
    screenshotBudget: {
      actualBytesMax: 12,
      actualBytesP50: 8,
      actualBytesP95: 12,
      capturedSamples: 2,
      failedSamples: 0,
      maximumBufferedBytes: 64,
      peakActiveReservations: 3,
      peakRetainedBytes: 48,
      reservationBytesP50: 16,
      reservationBytesP95: 24,
      waitMaxMs: 6,
      waitP50Ms: 4,
      waitP95Ms: 6,
      waitSamples: 2,
    },
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
