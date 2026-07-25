const assert = require('node:assert/strict');
const test = require('node:test');
const {
  aggregateParityComparisons,
  buildSchedule,
  findCrossShardDuplicatePaths,
  combinedFailure,
  memoryRunFailures,
  normalizeExitCode,
  parityHasMismatch,
  parseArgs,
  startMemorySampler,
  windowsProcessTreeScript,
} = require('./local-ab.js');

test('alternates two-arm measurements and balances larger rotations', () => {
  assert.deepEqual(buildSchedule(['baseline', 'candidate'], 5), [
    ['baseline', 'candidate'],
    ['candidate', 'baseline'],
    ['baseline', 'candidate'],
    ['candidate', 'baseline'],
    ['baseline', 'candidate'],
  ]);
  const schedule = buildSchedule(['a', 'b', 'c'], 6);
  for (const arm of ['a', 'b', 'c']) {
    assert.deepEqual(
      [0, 1, 2].map(position => schedule.filter(order => order[position] === arm).length),
      [2, 2, 2],
    );
  }
});

test('aggregates parity failures from every healthy repetition', () => {
  const aggregate = aggregateParityComparisons([
    {
      missingPngCount: 0,
      unexpectedPngCount: 0,
      dimensionMismatchCount: 0,
      byteMismatchCount: 0,
      byteMismatches: [],
    },
    {
      missingPngCount: 0,
      unexpectedPngCount: 0,
      dimensionMismatchCount: 1,
      byteMismatchCount: 1,
      byteMismatches: ['changed.png'],
    },
  ]);
  assert.equal(aggregate.checkedRuns, 2);
  assert.equal(aggregate.dimensionMismatchCount, 1);
  assert.equal(aggregate.byteMismatchCount, 1);
  assert.deepEqual(aggregate.byteMismatches, ['changed.png']);
  assert.equal(parityHasMismatch(aggregate, 'bytes'), true);
});

const byteMismatch = {
  missingPngCount: 0,
  unexpectedPngCount: 0,
  dimensionMismatchCount: 0,
  byteMismatchCount: 1,
  rgba: {
    missingPngCount: 0,
    unexpectedPngCount: 0,
    dimensionMismatchCount: 0,
    rgbaMismatchCount: 0,
    referenceUnreadableCount: 0,
    candidateUnreadableCount: 0,
  },
};

test('defaults to byte parity and requires an explicit RGBA mode', () => {
  assert.equal(parseArgs([]).parity, 'bytes');
  assert.equal(parseArgs(['--parity', 'rgba']).parity, 'rgba');
  assert.throws(() => parseArgs(['--parity', 'pixels']), /bytes.*rgba/);
});

test('accepts compression-only changes only in RGBA mode', () => {
  assert.equal(parityHasMismatch(byteMismatch, 'bytes'), true);
  assert.equal(parityHasMismatch(byteMismatch, 'rgba'), false);
  assert.equal(
    parityHasMismatch({ ...byteMismatch, rgba: { ...byteMismatch.rgba, rgbaMismatchCount: 1 } }, 'rgba'),
    true,
  );
});

test('Windows memory sampling is rooted at one process tree', () => {
  const script = windowsProcessTreeScript(1234);
  assert.match(script, /\$rootPid = 1234/);
  assert.match(script, /ParentProcessId/);
  assert.doesNotMatch(script, /Get-Process -Name/);
});

test('detects duplicate PNG paths across shard manifests', () => {
  assert.deepEqual(
    findCrossShardDuplicatePaths([
      [{ path: 'one.png' }, { path: 'shared.png' }],
      [{ path: 'two.png' }, { path: 'shared.png' }],
      [{ path: 'shared.png' }],
    ]),
    ['shared.png'],
  );
});

test('normalizes signal termination to a failing exit code', () => {
  assert.equal(normalizeExitCode(0), 0);
  assert.equal(normalizeExitCode(2), 2);
  assert.equal(normalizeExitCode(null), 1);
});

test('rejects unhealthy memory runs', () => {
  const healthy = {
    exitCode: 0,
    pngCount: 1,
    log: { duplicatePngCount: 0, retryCount: 0 },
    crossShardDuplicatePngCount: 0,
  };
  assert.deepEqual(memoryRunFailures(healthy), []);
  assert.deepEqual(
    memoryRunFailures({
      ...healthy,
      exitCode: 1,
      terminationSignal: 'SIGKILL',
      log: { duplicatePngCount: 1, retryCount: 2 },
      crossShardDuplicatePngCount: 1,
    }),
    [
      'exited 1 after signal SIGKILL',
      'retried 2 capture(s)',
      'logged duplicate PNG lines',
      'produced 1 duplicate PNG path(s) across shards',
    ],
  );
  assert.deepEqual(memoryRunFailures({ ...healthy, pngCount: 0 }), ['produced no PNG files']);
});

test('keeps the primary failure visible when cleanup also fails', () => {
  const primary = new Error('spawn failed');
  const cleanup = new Error('sampler failed');
  const combined = combinedFailure('Memory run or cleanup failed', [primary, cleanup]);
  assert.ok(combined instanceof AggregateError);
  assert.equal(combined.errors[0], primary);
  assert.match(combined.message, /spawn failed/);
});

test('memory sampling does not block the measured process and drains its final sample', async () => {
  let finishSample;
  const sampler = startMemorySampler({
    intervalMs: 60_000,
    sample: () =>
      new Promise(resolve => {
        finishSample = resolve;
      }),
  });

  sampler.track(1234);
  const stopping = sampler.stop();
  let stopped = false;
  void stopping.then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);

  finishSample(4096);
  assert.deepEqual(await stopping, {
    samples: 1,
    peakProcessTreeBytes: 4096,
    medianProcessTreeBytes: 4096,
  });
});

test('memory sampling rejects a report with no valid samples', async () => {
  const sampler = startMemorySampler({
    intervalMs: 60_000,
    sample: async () => undefined,
  });

  sampler.track(1234);
  await assert.rejects(sampler.stop(), /no valid samples/);
});
