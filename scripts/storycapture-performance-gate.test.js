const assert = require('node:assert/strict');
const test = require('node:test');

const { evaluateStoryCaptureGate } = require('./storycapture-performance-gate.js');

function run(overrides = {}) {
  return {
    captureTimeMs: 1000,
    cpuTimeMs: 800,
    navigationCount: 4,
    peakRssBytes: 1000,
    sessionGenerationCount: 4,
    wallTimeMs: 900,
    exitCode: 0,
    pngCount: 452,
    crashCount: 0,
    duplicatePngCount: 0,
    failureCount: 0,
    invalidPreviewCount: 0,
    missingPngCount: 0,
    pixelMismatchCount: 0,
    residualProcessCount: 0,
    retryCount: 0,
    timeoutCount: 0,
    ...overrides,
  };
}

function record() {
  const scenario = {
    azureImage: 'ubuntu-24.04',
    chromium: '149.0.0.0',
    expectedCaptures: 452,
    optionsHash: 'options',
    parallel: 4,
    staticBuildHash: 'static',
  };
  return {
    schemaVersion: 1,
    kind: 'storycapture-performance-comparison',
    recordedAt: '2026-07-20T00:00:00.000Z',
    scenario,
    storycapture: { packageHash: 'storycapture', version: '9.0.0' },
    storyfreeze: { commit: 'commit', packageHash: 'storyfreeze', tree: 'tree', version: '0.2.0-rc.1' },
    rc0: {
      schemaVersion: 1,
      kind: 'storyfreeze-rc0-resource-baseline',
      storyfreeze: {
        commit: 'rc0-commit',
        packageHash: 'rc0-package',
        tree: 'rc0-tree',
        version: '0.2.0-rc.0',
      },
      scenario: { ...scenario },
      runs: Array.from({ length: 3 }, () => ({ cpuTimeMs: 1000, peakRssBytes: 1000 })),
    },
    warmups: [
      {
        order: ['storycapture', 'storyfreeze'],
        storycapture: run({ captureTimeMs: 1100, cpuTimeMs: 900, peakRssBytes: 900, wallTimeMs: 1100 }),
        storyfreeze: run(),
      },
    ],
    pairs: Array.from({ length: 5 }, (_, index) => ({
      order: index % 2 === 0 ? ['storycapture', 'storyfreeze'] : ['storyfreeze', 'storycapture'],
      storycapture: run({ captureTimeMs: 1100, cpuTimeMs: 900, peakRssBytes: 900, wallTimeMs: 1100 }),
      storyfreeze: run(),
    })),
  };
}

test('passes the release gate from five clean alternating raw pairs', () => {
  const evaluation = evaluateStoryCaptureGate(record());
  assert.equal(evaluation.gate.passed, true);
  assert.equal(evaluation.ratios.wallP50ToStoryCapture, 900 / 1100);
  assert.equal(evaluation.ratios.wallP95ToStoryCapture, 900 / 1100);
  assert.equal(evaluation.ratios.cpuToRc0, 0.8);
  assert.equal(evaluation.ratios.peakRssToRc0, 1);
  assert.equal(evaluation.stretchGoalPassed, false);
});

test('blocks regressions, invalid output, and unbalanced execution order', () => {
  const input = record();
  input.pairs[1].order = ['storycapture', 'storyfreeze'];
  input.pairs[2].storyfreeze = run({ missingPngCount: 1, pngCount: 451, wallTimeMs: 1300 });
  input.rc0.runs.forEach(run => (run.cpuTimeMs = 700));
  const evaluation = evaluateStoryCaptureGate(input);
  assert.equal(evaluation.gate.passed, false);
  assert.match(evaluation.gate.errors.join('\n'), /does not alternate/);
  assert.match(evaluation.gate.errors.join('\n'), /missingPngCount/);
  assert.match(evaluation.gate.errors.join('\n'), /wall p95 ratio/);
  assert.match(evaluation.gate.errors.join('\n'), /CPU ratio/);
});

test('reports malformed pair records without throwing', () => {
  const input = record();
  input.pairs[2] = null;
  const evaluation = evaluateStoryCaptureGate(input);
  assert.equal(evaluation.gate.passed, false);
  assert.match(evaluation.gate.errors.join('\n'), /pairs\[2\] must be an object/);
  assert.match(evaluation.gate.errors.join('\n'), /pairs\[2\]\.storyfreeze is missing/);
});

test('rejects placeholder provenance instead of accepting an unverifiable record', () => {
  const input = record();
  input.scenario.azureImage = 'unknown@unknown';
  input.storyfreeze.commit = 'unknown';
  const evaluation = evaluateStoryCaptureGate(input);

  assert.equal(evaluation.gate.passed, false);
  assert.match(evaluation.gate.errors.join('\n'), /scenario\.azureImage is required/);
  assert.match(evaluation.gate.errors.join('\n'), /storyfreeze\.commit is required/);
});

test('rejects an RC.0 baseline from a different scenario and a failed warmup', () => {
  const input = record();
  input.rc0.scenario.chromium = '148.0.0.0';
  input.warmups[0].storyfreeze.residualProcessCount = 1;
  const evaluation = evaluateStoryCaptureGate(input);

  assert.equal(evaluation.gate.passed, false);
  assert.match(evaluation.gate.errors.join('\n'), /rc0\.scenario\.chromium must match/);
  assert.match(evaluation.gate.errors.join('\n'), /warmups\[0\]\.storyfreeze\.residualProcessCount/);
});

test('only recommends unlimited session lifetime after the stretch criteria pass', () => {
  const input = record();
  input.noRecyclePairs = Array.from({ length: 3 }, (_, index) => ({
    order: index % 2 === 0 ? ['default128', 'unlimited'] : ['unlimited', 'default128'],
    default128: run({ wallTimeMs: 1000 }),
    unlimited: run({ peakRssBytes: 1050, wallTimeMs: 940 }),
  }));
  const evaluation = evaluateStoryCaptureGate(input);
  assert.equal(evaluation.recycleExperiment.measured, true);
  assert.equal(evaluation.recycleExperiment.adopt, true);
});
