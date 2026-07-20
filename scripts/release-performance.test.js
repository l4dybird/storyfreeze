const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { PNG } = require('pngjs');

const referenceRcCommit = '63dbda81ee5bb8b4ea46a585b10c0a06fde19fff';
const referenceRcTree = 'f615d6ce72b316ce23ed47c1c3c295777b3918be';

const {
  buildSchedule,
  compareManifests,
  createLogInspector,
  evaluateRecord,
  inspectPngDirectory,
  measuredOrder,
  packCandidatePackage,
  percentile,
  prepareImplementationPackage,
  replacePlaceholders,
  resolvePackageExecutable,
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
    recordedAt: '2026-07-20T01:00:00.000Z',
    scenario: {
      azureImage: 'ubuntu-24.04',
      candidateBuildToolchain: {
        npm: '11.5.1',
        packageManager: 'pnpm@11.11.0',
        pnpm: '11.11.0',
        pnpmLockSha256: hash,
      },
      chromium: 'Chromium 149',
      expectedCaptures: 452,
      invalidPngHashes: [hash],
      node: 'v22.18.0',
      npmBefore: '2026-07-19T00:00:00.000Z',
      options: { npmBefore: '2026-07-19T00:00:00.000Z', parallel: 4 },
      optionsHash: hash,
      parallel: 4,
      staticBuildHash: hash,
    },
    implementations: {
      candidate: {
        binName: 'storyfreeze',
        binPath: 'dist/node/cli.js',
        commit: sha,
        dependencyLockArtifact: 'dependencies/candidate/package-lock.json',
        dependencyLockHash: hash,
        packageArtifact: 'dependencies/candidate/measured-package.tgz',
        packageHash: hash,
        packageIntegrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        packageName: 'storyfreeze',
        tree: sha,
        version: '0.2.0-rc.3',
      },
      rc: {
        binName: 'storyfreeze',
        binPath: 'dist/node/cli.js',
        commit: referenceRcCommit,
        dependencyLockArtifact: 'dependencies/rc/package-lock.json',
        dependencyLockHash: hash,
        packageArtifact: 'dependencies/rc/measured-package.tgz',
        packageHash: hash,
        packageIntegrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        packageName: 'storyfreeze',
        registryIntegrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        tree: referenceRcTree,
        version: '0.2.0-rc.2',
      },
      storycapture: {
        binName: 'storycapture',
        binPath: 'cli.js',
        dependencyLockArtifact: 'dependencies/storycapture/package-lock.json',
        dependencyLockHash: hash,
        packageArtifact: 'dependencies/storycapture/measured-package.tgz',
        packageHash: hash,
        packageIntegrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        packageName: 'storycapture',
        registryIntegrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        version: '9.0.0',
      },
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

test('resolves only an executable declared inside the packed package', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-release-package-'));
  try {
    fs.mkdirSync(path.join(directory, 'dist'));
    fs.writeFileSync(path.join(directory, 'dist', 'cli.js'), '');
    assert.deepEqual(
      resolvePackageExecutable(directory, { name: 'storyfreeze', bin: { storyfreeze: 'dist/cli.js' } }),
      {
        binName: 'storyfreeze',
        binPath: 'dist/cli.js',
        executablePath: path.join(directory, 'dist', 'cli.js'),
      },
    );
    assert.throws(
      () => resolvePackageExecutable(directory, { name: 'storyfreeze', bin: { storyfreeze: '../outside.js' } }),
      /outside the extracted package/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('packs the candidate only from a clean repository HEAD', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-release-candidate-'));
  try {
    const packageDirectory = path.join(directory, 'packages', 'storyfreeze');
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name: 'storyfreeze-candidate-fixture', version: '1.0.0', bin: { fixture: 'cli.js' } })}\n`,
    );
    fs.writeFileSync(path.join(packageDirectory, 'cli.js'), '#!/usr/bin/env node\n');
    execFileSync('git', ['init'], { cwd: directory, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: directory, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'], {
      cwd: directory,
      stdio: 'pipe',
    });

    let buildCount = 0;
    const archive = packCandidatePackage(directory, path.join(directory, 'packed'), () => (buildCount += 1));
    assert.equal(buildCount, 1);
    assert.equal(path.extname(archive), '.tgz');
    assert.equal(fs.statSync(archive).isFile(), true);

    fs.appendFileSync(path.join(packageDirectory, 'cli.js'), '// dirty\n');
    assert.throws(
      () => packCandidatePackage(directory, path.join(directory, 'dirty'), () => (buildCount += 1)),
      /must be clean/,
    );
    assert.equal(buildCount, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('installs and resolves the CLI from the hashed npm archive', { skip: process.platform === 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-release-archive-'));
  try {
    const packageDirectory = path.join(directory, 'source');
    fs.mkdirSync(packageDirectory);
    fs.writeFileSync(
      path.join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name: 'storyfreeze-release-fixture', version: '1.0.0', bin: { fixture: 'cli.js' } })}\n`,
    );
    fs.writeFileSync(path.join(packageDirectory, 'cli.js'), '#!/usr/bin/env node\n');
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--json', '--pack-destination', directory], {
        cwd: packageDirectory,
        encoding: 'utf8',
      }),
    )[0];
    const archivePath = path.join(directory, packed.filename);
    const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(archivePath)).digest('base64')}`;
    assert.throws(
      () =>
        prepareImplementationPackage(
          'fixture',
          { args: [], packagePath: packed.filename, version: '1.0.0' },
          directory,
          path.join(directory, 'rejected'),
          {
            expectedIntegrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
            expectedPackageName: 'storyfreeze-release-fixture',
            npmBefore: '2026-01-01T00:00:00.000Z',
          },
        ),
      /archive integrity does not match/,
    );
    const prepared = prepareImplementationPackage(
      'fixture',
      { args: [], packagePath: packed.filename, version: '1.0.0' },
      directory,
      path.join(directory, 'prepared'),
      {
        dependencyArtifactDir: path.join(directory, 'artifact'),
        expectedIntegrity: integrity,
        expectedPackageName: 'storyfreeze-release-fixture',
        npmBefore: '2026-01-01T00:00:00.000Z',
      },
    );
    assert.equal(prepared.command, process.execPath);
    assert.equal(prepared.packageName, 'storyfreeze-release-fixture');
    assert.equal(prepared.packageBinName, 'fixture');
    assert.equal(prepared.packageBinPath, 'cli.js');
    assert.match(prepared.dependencyLockHash, /^[0-9a-f]{64}$/);
    assert.match(prepared.packageHash, /^[0-9a-f]{64}$/);
    assert.equal(prepared.packageIntegrity, integrity);
    const artifactLockPath = path.join(directory, 'artifact', 'package-lock.json');
    assert.equal(
      prepared.dependencyLockHash,
      crypto.createHash('sha256').update(fs.readFileSync(artifactLockPath)).digest('hex'),
    );
    const artifactLock = JSON.parse(fs.readFileSync(artifactLockPath, 'utf8'));
    assert.equal(artifactLock.packages[''].dependencies['storyfreeze-release-fixture'], 'file:./measured-package.tgz');
    assert.equal(
      artifactLock.packages['node_modules/storyfreeze-release-fixture'].resolved,
      'file:measured-package.tgz',
    );
    assert.equal(
      fs.readFileSync(path.join(directory, 'artifact', 'measured-package.tgz')).equals(fs.readFileSync(archivePath)),
      true,
    );
    assert.equal(fs.readFileSync(prepared.commandPrefixArgs[0], 'utf8'), '#!/usr/bin/env node\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('inspects failures and duplicate output after more than 16 MiB of logs', () => {
  const inspector = createLogInspector();
  const noise = `${'x'.repeat(1024 * 1024)}\n`;
  for (let index = 0; index < 17; index += 1) inspector.push('stdout', noise);
  inspector.push('stdout', 'Screenshot stored: /tmp/A.png in 10 msec.\n');
  inspector.push('stderr', 'Screenshot stored: /tmp/A.png in 11 msec.\n');
  inspector.push('stderr', 'Retry to screenshot this story after this sequence.\n');
  inspector.push('stderr', 'capture failed (error): TimeoutError browser process crash retry budget exhausted\n');
  inspector.push('stdout', 'Screenshot was ended successfully in 123 msec\n');
  assert.deepEqual(inspector.finish(), {
    captureTimeMs: 123,
    crashCount: 1,
    duplicatePngCount: 1,
    failureCount: 2,
    retryCount: 1,
    retryExhaustionLogCount: 1,
    timeoutLogCount: 1,
  });
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

  const unsafeCutoff = record();
  unsafeCutoff.scenario.npmBefore = unsafeCutoff.recordedAt;
  const cutoffEvaluation = evaluateRecord(unsafeCutoff);
  assert.equal(cutoffEvaluation.gate.passed, false);
  assert.match(cutoffEvaluation.gate.errors.join('\n'), /at least 24 hours/);

  const unknownBuildInputs = record();
  delete unknownBuildInputs.scenario.candidateBuildToolchain.pnpmLockSha256;
  const buildInputEvaluation = evaluateRecord(unknownBuildInputs);
  assert.equal(buildInputEvaluation.gate.passed, false);
  assert.match(buildInputEvaluation.gate.errors.join('\n'), /pnpmLockSha256/);

  const mismatchedPackageManager = record();
  mismatchedPackageManager.scenario.candidateBuildToolchain.packageManager = 'pnpm@12.0.0';
  const packageManagerEvaluation = evaluateRecord(mismatchedPackageManager);
  assert.equal(packageManagerEvaluation.gate.passed, false);
  assert.match(packageManagerEvaluation.gate.errors.join('\n'), /must pin the active pnpm version/);
});

test('requires the fixed release scenario and complete package argument templates', () => {
  const sha = 'a'.repeat(40);
  const args = ['--parallel', '4', '--chromium-path', '{chromiumPath}', '--out-dir', '{outDir}', '{storybookUrl}'];
  const candidate = {
    args,
    commit: sha,
    tree: sha,
  };
  const archived = {
    args,
    packagePath: 'package.tgz',
    version: '0.2.0-rc.2',
    commit: referenceRcCommit,
    tree: referenceRcTree,
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
      candidate,
      rc: archived,
      storycapture: { ...archived, version: '9.0.0', commit: undefined, tree: undefined },
    },
  };
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(() => validateConfig({ ...config, parallel: 8 }), /parallel must be 4/);
  assert.throws(
    () =>
      validateConfig({
        ...config,
        implementations: { ...config.implementations, rc: { ...archived, version: '0.2.0-rc.3' } },
      }),
    /rc.version must be 0.2.0-rc.2/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        implementations: {
          ...config.implementations,
          rc: { ...archived, commit: sha, tree: sha },
        },
      }),
    /tagged RC.2 source/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        implementations: {
          ...config.implementations,
          candidate: { ...candidate, command: 'node' },
        },
      }),
    /command is not supported/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        implementations: { ...config.implementations, candidate: { ...candidate, packagePath: 'stale.tgz' } },
      }),
    /derived from repositoryDir HEAD/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        implementations: {
          ...config.implementations,
          storycapture: { ...config.implementations.storycapture, version: '8.0.0' },
        },
      }),
    /storycapture.version must be 9.0.0/,
  );
});
