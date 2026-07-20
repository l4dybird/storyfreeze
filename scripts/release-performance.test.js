const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PNG } = require('pngjs');

const {
  buildSchedule,
  compareManifests,
  evaluateRecord,
  inspectPngDirectory,
  measuredOrder,
  percentile,
  replacePlaceholders,
  summarize,
  validateConfig,
} = require('./release-performance.js');

function successfulRun(wallTimeMs, manifestSha256 = 'a'.repeat(64)) {
  return {
    captureTimeMs: wallTimeMs - 10,
    cpuTimeMs: 1_000,
    peakRssBytes: 2_000,
    wallTimeMs,
    exitCode: 0,
    pngCount: 452,
    cleanupErrorCount: 0,
    logPath: '/tmp/run.log',
    manifestSha256,
    crashCount: 0,
    dimensionMismatchCount: 0,
    duplicatePngCount: 0,
    failureCount: 0,
    invalidPreviewCount: 0,
    missingPngCount: 0,
    residualProcessCount: 0,
    retryExhaustionCount: 0,
    retryCount: 0,
    rgbaMismatchCount: 0,
    timeoutCount: 0,
    unexpectedPngCount: 0,
    unreadablePngCount: 0,
  };
}

function pairs(candidateTime, comparisonLabel, comparisonTime, startingLabel = 'candidate', manifestSha256) {
  return Array.from({ length: 5 }, (_value, index) => ({
    order: measuredOrder(index, ['candidate', comparisonLabel], startingLabel),
    candidate: successfulRun(candidateTime + index, manifestSha256),
    [comparisonLabel]: successfulRun(comparisonTime + index, manifestSha256),
  }));
}

function record() {
  const hash = 'a'.repeat(64);
  const sha = 'b'.repeat(40);
  const reference = Array.from({ length: 452 }, (_value, index) => ({
    path: `Story/${index}.png`,
    width: 800,
    height: 600,
    rgbaSha256: hash,
    visualSha256: hash,
  }));
  const manifestSha256 = crypto.createHash('sha256').update(JSON.stringify(reference)).digest('hex');
  return {
    schemaVersion: 1,
    kind: 'storyfreeze-release-performance',
    scenario: {
      azureImage: 'ubuntu-24.04',
      chromium: 'Chromium 149',
      expectedCaptures: 452,
      invalidPngHashes: [hash],
      node: 'v22.18.0',
      options: { parallel: 4 },
      optionsHash: hash,
      parallel: 4,
      staticBuildHash: hash,
    },
    implementations: {
      candidate: { commit: sha, packageHash: hash, tree: sha, version: '0.2.0-rc.3' },
      rc: { commit: sha, packageHash: hash, tree: sha, version: '0.2.0-rc.2' },
      storycapture: { packageHash: hash, version: '9.0.0' },
    },
    schedule: buildSchedule(),
    reference: {
      source: 'candidate-rc-warmup-rc',
      manifest: reference,
      manifestSha256,
    },
    comparisons: {
      candidateRc: {
        warmups: { candidate: successfulRun(90, manifestSha256), rc: successfulRun(100, manifestSha256) },
        pairs: pairs(100, 'rc', 100, 'candidate', manifestSha256),
      },
      candidateStoryCapture: {
        warmups: {
          candidate: successfulRun(85, manifestSha256),
          storycapture: successfulRun(100, manifestSha256),
        },
        pairs: pairs(85, 'storycapture', 100, 'storycapture', manifestSha256),
      },
    },
  };
}

test('builds one warmup and five alternating pairs for both comparisons', () => {
  const schedule = buildSchedule({ candidateRc: 'rc', candidateStoryCapture: 'candidate' });
  assert.equal(schedule.length, 24);
  const candidateRc = schedule.filter(step => step.comparison === 'candidateRc' && step.kind === 'measured');
  assert.deepEqual(
    candidateRc.filter(step => step.pair === 1).map(step => step.implementation),
    ['rc', 'candidate'],
  );
  assert.deepEqual(
    candidateRc.filter(step => step.pair === 2).map(step => step.implementation),
    ['candidate', 'rc'],
  );
});

test('replaces only release command placeholders', () => {
  assert.equal(
    replacePlaceholders('{storybookUrl} {outDir} {chromiumPath} {other}', {
      storybookUrl: 'http://localhost',
      outDir: '/tmp/output',
      chromiumPath: '/tmp/chrome',
    }),
    'http://localhost /tmp/output /tmp/chrome {other}',
  );
});

test('compares paths, dimensions, and decoded RGBA', () => {
  const reference = [
    { path: 'A.png', width: 10, height: 20, rgbaSha256: 'a' },
    { path: 'B.png', width: 30, height: 40, rgbaSha256: 'b' },
  ];
  const actual = [
    { path: 'A.png', width: 10, height: 21, rgbaSha256: 'z' },
    { path: 'C.png', width: 30, height: 40, rgbaSha256: 'c' },
  ];
  assert.deepEqual(compareManifests(reference, actual), {
    missingPngCount: 1,
    unexpectedPngCount: 1,
    dimensionMismatchCount: 1,
    rgbaMismatchCount: 1,
  });
});

test('decodes a PNG manifest independently of encoded bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-release-manifest-'));
  try {
    const png = new PNG({ width: 2, height: 1 });
    png.data.set([255, 0, 0, 255, 0, 255, 0, 255]);
    fs.writeFileSync(path.join(directory, 'capture.png'), PNG.sync.write(png));
    const inspection = inspectPngDirectory(directory);
    assert.deepEqual(inspection.unreadable, []);
    assert.equal(inspection.manifest.length, 1);
    assert.deepEqual(
      {
        path: inspection.manifest[0].path,
        width: inspection.manifest[0].width,
        height: inspection.manifest[0].height,
      },
      { path: 'capture.png', width: 2, height: 1 },
    );
    assert.match(inspection.manifest[0].rgbaSha256, /^[0-9a-f]{64}$/);
    assert.match(inspection.manifest[0].visualSha256, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('summarizes raw runs without averaging dispatch summaries', () => {
  assert.equal(percentile([1, 2, 100, 3, 4], 0.95), 100);
  assert.deepEqual(summarize([successfulRun(100), successfulRun(80), successfulRun(90)]), {
    runs: 3,
    wallP50Ms: 90,
    wallP95Ms: 100,
    captureP50Ms: 80,
    captureP95Ms: 90,
    cpuP50Ms: 1_000,
    peakRssP50Bytes: 2_000,
  });
});

test('passes only when both RC.2 and StoryCapture ratios pass', () => {
  const evaluation = evaluateRecord(record());
  assert.equal(evaluation.gate.passed, true);
  assert.ok(evaluation.ratios.candidateToRcWallP95 <= 1.05);
  assert.ok(evaluation.ratios.candidateToStoryCaptureWallP50 <= 0.9);

  const failed = record();
  failed.comparisons.candidateStoryCapture.pairs[2].candidate.rgbaMismatchCount = 1;
  const failedEvaluation = evaluateRecord(failed);
  assert.equal(failedEvaluation.gate.passed, false);
  assert.match(failedEvaluation.gate.errors.join('\n'), /rgbaMismatchCount/);
});

test('requires the fixed release scenario and complete command templates', () => {
  const sha = 'a'.repeat(40);
  const implementation = {
    command: 'node',
    args: ['cli.js', '--parallel', '4', '--chromium-path', '{chromiumPath}', '--out-dir', '{outDir}', '{storybookUrl}'],
    packagePath: 'package.tgz',
    version: '0.2.0-rc.3',
    commit: sha,
    tree: sha,
  };
  const config = {
    schemaVersion: 1,
    parallel: 4,
    expectedCaptures: 452,
    azureImage: 'ubuntu-24.04',
    chromiumPath: '/tmp/chrome',
    staticBuildDir: '/tmp/storybook-static',
    storybookUrl: 'http://localhost:6006',
    commandTimeoutMs: 600_000,
    invalidPngHashes: ['a'.repeat(64)],
    implementations: {
      candidate: implementation,
      rc: { ...implementation, version: '0.2.0-rc.2' },
      storycapture: { ...implementation, version: '9.0.0', commit: undefined, tree: undefined },
    },
  };
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(() => validateConfig({ ...config, parallel: 8 }), /parallel must be 4/);
  assert.throws(
    () => validateConfig({ ...config, implementations: { ...config.implementations, rc: implementation } }),
    /rc.version must be 0.2.0-rc.2/,
  );
});
