const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { buildAggregate } = require('./aggregate-browser-isolation-benchmarks.js');

const commit = '1111111111111111111111111111111111111111';
const tree = '2222222222222222222222222222222222222222';
const workflowRuns = [1, 2, 3, 4].map(run => `https://github.com/example/storyfreeze/actions/runs/${run}`);

function makeRun({
  captureOffset,
  globalIndex,
  isolation,
  iteration,
  label,
  pairStartingIsolation,
  positionInPair,
  sequenceIndex,
}) {
  const storyDurationsMs = Array.from(
    { length: 9 },
    (_, captureIndex) => captureOffset + globalIndex * 10 + captureIndex,
  );
  return {
    backend: 'playwright',
    browserCrashCount: 0,
    captureDiagnostics: storyDurationsMs.map((durationMs, captureIndex) => ({
      durationMs,
      storyId: 'fixture--story',
      type: 'capture-output',
      variantKey: captureIndex === 0 ? [] : [`variant-${captureIndex}`],
    })),
    cpuTimeMs: (isolation === 'process' ? 500 : 400) + globalIndex,
    isolation,
    iteration,
    label,
    pairStartingIsolation,
    peakBrowserRootCount: isolation === 'process' ? 4 : 1,
    peakChromiumProcessCount: isolation === 'process' ? 30 : 10,
    peakTreeRssBytes: (isolation === 'process' ? 1000 : 700) + globalIndex,
    pngCount: 9,
    positionInPair,
    retryCount: 0,
    sequenceIndex,
    storyDurationsMs,
    success: true,
    timeoutCount: 0,
    wallTimeMs: (isolation === 'process' ? 200 : 180) + globalIndex,
  };
}

function makeRecord({
  dispatch = 0,
  measuredRuns = 10,
  parallel = 4,
  profile = 'record',
  runId = dispatch + 1,
  startingIsolation,
}) {
  const warmupRuns = profile === 'record' ? 2 : 1;
  function makeCollection(runKind, runCount) {
    const collection = { context: [], process: [] };
    const executionOrder = [];
    for (let iteration = 1; iteration <= runCount; iteration += 1) {
      const processFirst = startingIsolation === 'process' ? iteration % 2 === 1 : iteration % 2 === 0;
      const order = processFirst ? ['process', 'context'] : ['context', 'process'];
      for (const [positionInPair, isolation] of order.entries()) {
        const label = `${runKind}-${isolation}-${dispatch}-${iteration}`;
        const run = makeRun({
          captureOffset: isolation === 'process' ? 1000 : 800,
          globalIndex: dispatch * runCount + iteration - 1,
          isolation,
          iteration,
          label,
          pairStartingIsolation: order[0],
          positionInPair,
          sequenceIndex: executionOrder.length + 1,
        });
        collection[isolation].push(run);
        executionOrder.push(label);
      }
    }
    return { collection, executionOrder };
  }
  const measured = makeCollection('measured', measuredRuns);
  const warmup = makeCollection('warmup', warmupRuns);
  return {
    schemaVersion: 1,
    kind: 'browser-isolation-differential',
    recordedAt: `2026-07-13T00:00:0${dispatch}.000Z`,
    githubActions: {
      repository: 'example/storyfreeze',
      runAttempt: '1',
      runId: String(runId),
      workflowRef: 'example/storyfreeze/.github/workflows/browser_isolation_benchmark.yml@refs/heads/test',
      workflowSha: commit,
    },
    storyfreezeCommit: commit,
    storyfreezeTree: tree,
    storyfreezeVersion: '0.0.0-test',
    provisioning: 'explicit-install',
    scenario: {
      backend: 'playwright',
      benchmarkProfile: profile,
      exclude: 'Compatibility/Fixture/Retry',
      fixture: 'react-vite-example',
      includeTrace: false,
      launchOptions: { args: ['--no-sandbox'] },
      measuredRuns,
      mode: 'managed-static',
      parallel,
      pngs: 9,
      sampleIntervalMs: 50,
      startingIsolation,
      stories: 2,
      storybook: '^10.1.10',
      warmupRuns,
      warmupExecutionOrder: warmup.executionOrder,
      measuredExecutionOrder: measured.executionOrder,
    },
    environment: {
      arch: 'x64',
      browser: {
        playwrightCore: '1.58.2',
        realpath: '/home/runner/.cache/chromium/chrome',
        revision: '1234',
        version: 'Chromium 150.0.0.0',
      },
      node: 'v22.18.0',
      platform: 'linux',
      release: '6.11.0',
      runnerImage: 'ubuntu24',
      runnerImageVersion: '20260701.1',
    },
    isolations: {
      process: {
        runs: measured.collection.process,
        summary: { medianWallTimeMs: -1 },
        warmups: warmup.collection.process,
      },
      context: {
        runs: measured.collection.context,
        summary: { medianWallTimeMs: Number.MAX_SAFE_INTEGER },
        warmups: warmup.collection.context,
      },
    },
    isolationDifferential: {
      pixelComparisons: Array.from({ length: measuredRuns + 2 * (measuredRuns - 1) }, (_, comparison) => ({
        actualPngCount: 9,
        byteMismatchCount: 0,
        differentPixels: 0,
        expectedPngCount: 9,
        label: `dispatch-${dispatch}-${comparison}`,
        mismatchCount: 0,
        mismatches: [],
      })),
      ratios: { wallTime: 99 },
    },
    gate: { errors: [], passed: true },
  };
}

function aggregateOptions(records) {
  return { commit, records, tree, workflowRuns };
}

test('pools raw runs and captures and evaluates the isolation acceptance gate', () => {
  const records = Array.from({ length: 4 }, (_, dispatch) =>
    makeRecord({ dispatch, startingIsolation: dispatch < 2 ? 'process' : 'context' }),
  );
  const output = buildAggregate({
    ...aggregateOptions(records),
    diagnosticP1: makeRecord({ measuredRuns: 3, parallel: 1, profile: 'pr', runId: 5, startingIsolation: 'process' }),
    diagnosticP1Run: 'https://github.com/example/storyfreeze/actions/runs/5',
    diagnosticP2: makeRecord({ measuredRuns: 3, parallel: 2, profile: 'pr', runId: 6, startingIsolation: 'context' }),
    diagnosticP2Run: 'https://github.com/example/storyfreeze/actions/runs/6',
  });

  assert.equal(output.schemaVersion, 1);
  assert.equal(output.kind, 'browser-isolation-aggregate');
  assert.equal(output.isolations.process.measuredRuns, 40);
  assert.equal(output.isolations.process.captureSampleCount, 360);
  assert.equal(output.isolations.process.captureTimeP50Ms, 1198);
  assert.equal(output.isolations.process.captureTimeP95Ms, 1378);
  assert.equal(output.isolations.process.wallTimeP50Ms, 219);
  assert.equal(output.isolations.process.wallTimeP95Ms, 237);
  assert.equal(output.isolations.process.storyVariants['fixture--story?keys='].samples, 40);
  assert.equal(output.isolations.process.storyVariants['fixture--story?keys='].p95Ms, 1370);
  assert.equal(output.diagnostics.p1.isolations.process.measuredRuns, 3);
  assert.equal(output.diagnostics.p1.workflowRun, 'https://github.com/example/storyfreeze/actions/runs/5');
  assert.equal(output.diagnostics.p2.parallel, 2);
  assert.equal(output.contextToProcessRatios.cpuTimeP50, 419 / 519);
  assert.equal(output.acceptance.passed, true);
});

test('rejects records whose benchmark conditions differ', () => {
  const records = Array.from({ length: 4 }, (_, dispatch) =>
    makeRecord({ dispatch, startingIsolation: dispatch < 2 ? 'process' : 'context' }),
  );
  records[3].environment.browser.playwrightCore = 'different';

  assert.throws(() => buildAggregate(aggregateOptions(records)), /do not match/);
});

test('checks every raw context run for the one-root acceptance requirement', () => {
  const records = Array.from({ length: 4 }, (_, dispatch) =>
    makeRecord({ dispatch, startingIsolation: dispatch < 2 ? 'process' : 'context' }),
  );
  records[0].isolations.context.runs[0].peakBrowserRootCount = 0;

  const output = buildAggregate(aggregateOptions(records));
  assert.equal(output.acceptance.contextMaxBrowserRootCountIsOne, true);
  assert.equal(output.acceptance.contextEveryRunHasOneBrowserRoot, false);
  assert.equal(output.acceptance.passed, false);
});

test('rejects invalid workflow URLs and paired execution order', () => {
  const records = Array.from({ length: 4 }, (_, dispatch) =>
    makeRecord({ dispatch, startingIsolation: dispatch < 2 ? 'process' : 'context' }),
  );
  assert.throws(
    () => buildAggregate({ ...aggregateOptions(records), workflowRuns: ['not-a-url', ...workflowRuns.slice(1)] }),
    /workflow run URL/,
  );
  records[1].githubActions.runId = '999';
  assert.throws(() => buildAggregate(aggregateOptions(records)), /run ID does not match its benchmark artifact/);
  records[1].githubActions.runId = '2';
  records[1].githubActions.runId = '1';
  assert.throws(
    () =>
      buildAggregate({
        ...aggregateOptions(records),
        workflowRuns: [`${workflowRuns[0]}/attempts/1`, `${workflowRuns[0]}/`, ...workflowRuns.slice(2)],
      }),
    /distinct dispatches/,
  );
  records[1].githubActions.runId = '2';
  assert.throws(
    () =>
      buildAggregate({
        ...aggregateOptions(records),
        diagnosticP1: makeRecord({ measuredRuns: 3, parallel: 1, profile: 'pr', startingIsolation: 'process' }),
      }),
    /provided together/,
  );
  assert.throws(
    () => buildAggregate({ ...aggregateOptions(records), diagnosticP1Run: workflowRuns[0] }),
    /provided together/,
  );
  const removedComparison = records[0].isolationDifferential.pixelComparisons.pop();
  assert.throws(() => buildAggregate(aggregateOptions(records)), /expected 28 raw PNG comparisons/);
  records[0].isolationDifferential.pixelComparisons.push(removedComparison);

  records[0].isolations.process.runs[0].positionInPair = 1;
  assert.throws(() => buildAggregate(aggregateOptions(records)), /invalid measured execution order/);
});

test('CLI validates commit provenance and writes the aggregate JSON', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const headTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-isolation-aggregate-'));
  try {
    const recordPaths = Array.from({ length: 4 }, (_, dispatch) => {
      const record = makeRecord({ dispatch, startingIsolation: dispatch < 2 ? 'process' : 'context' });
      record.storyfreezeCommit = head;
      record.storyfreezeTree = headTree;
      const recordPath = path.join(temporaryDirectory, `record-${dispatch}.json`);
      fs.writeFileSync(recordPath, JSON.stringify(record));
      return recordPath;
    });
    const outputPath = path.join(temporaryDirectory, 'aggregate.json');
    const arguments = [path.join(__dirname, 'aggregate-browser-isolation-benchmarks.js')];
    for (const recordPath of recordPaths) arguments.push('--record', recordPath);
    arguments.push('--commit', head, '--tree', headTree);
    for (const workflowRun of workflowRuns) arguments.push('--workflow-run', workflowRun);
    arguments.push('--output', outputPath);

    execFileSync(process.execPath, arguments, { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(output.sourceCommit, head);
    assert.equal(output.sourceTree, headTree);
    assert.equal(output.acceptance.passed, true);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
