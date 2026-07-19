const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PNG } = require('pngjs');

const {
  comparePngDirectories,
  hashPath,
  measureCommand,
  measuredOrder,
  parseCaptureTime,
  readExpectedPaths,
  validateConfig,
} = require('./storycapture-performance-record.js');

test('alternates the paired starting implementation', () => {
  assert.deepEqual(measuredOrder(0, ['storycapture', 'storyfreeze'], 'storycapture'), ['storycapture', 'storyfreeze']);
  assert.deepEqual(measuredOrder(1, ['storycapture', 'storyfreeze'], 'storycapture'), ['storyfreeze', 'storycapture']);
});

test('parses total and per-capture timings', () => {
  assert.equal(parseCaptureTime('Screenshot was ended successfully in 1234.5 msec'), 1234.5);
  assert.equal(parseCaptureTime('Screenshot stored: a.png in 12.5 msec.\nScreenshot stored: b.png in 7 msec.'), 19.5);
});

test('hashes deterministic directory contents and reads path contracts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-record-test-'));
  try {
    fs.writeFileSync(path.join(root, 'paths.txt'), 'A/One.png\nB/Two.png\n');
    fs.mkdirSync(path.join(root, 'static'));
    fs.writeFileSync(path.join(root, 'static', 'index.html'), 'fixture');
    assert.deepEqual(readExpectedPaths({ expectedPngPathsFile: 'paths.txt' }, root), ['A/One.png', 'B/Two.png']);
    assert.equal(hashPath(path.join(root, 'static')), hashPath(path.join(root, 'static')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compares decoded PNG dimensions and RGBA', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-record-png-'));
  try {
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    fs.mkdirSync(left);
    fs.mkdirSync(right);
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([255, 0, 0, 255]);
    fs.writeFileSync(path.join(left, 'same.png'), PNG.sync.write(png));
    fs.writeFileSync(path.join(right, 'same.png'), PNG.sync.write(png));
    assert.equal(comparePngDirectories(left, right, ['same.png']), 0);
    png.data.set([0, 0, 255, 255]);
    fs.writeFileSync(path.join(right, 'same.png'), PNG.sync.write(png));
    assert.equal(comparePngDirectories(left, right, ['same.png']), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requires the fixed representative scenario', () => {
  const config = {
    schemaVersion: 1,
    parallel: 4,
    expectedCaptures: 452,
    storybookUrl: 'http://127.0.0.1:6006',
    staticBuildDir: 'storybook-static',
    chromiumPath: '/chromium',
    commandTimeoutMs: 600_000,
    azureImage: 'ubuntu-24.04@20260720.1',
    invalidPngHashes: ['invalid-preview'],
    rc0: {
      schemaVersion: 1,
      kind: 'storyfreeze-rc0-resource-baseline',
      storyfreeze: { commit: 'commit', packageHash: 'package', tree: 'tree', version: '0.2.0-rc.0' },
      scenario: {
        azureImage: 'ubuntu-24.04@20260720.1',
        chromium: 'Chromium 149.0.0.0',
        expectedCaptures: 452,
        optionsHash: 'options',
        parallel: 4,
        staticBuildHash: 'static',
      },
      runs: Array.from({ length: 3 }, () => ({ cpuTimeMs: 1, peakRssBytes: 1 })),
    },
    implementations: {
      storycapture: {
        command: 'storycapture',
        args: ['{storybookUrl}', '--chromium-path', '{chromiumPath}', '--out-dir', '{outDir}', '--parallel', '4'],
        packagePath: 'storycapture.tgz',
      },
      storyfreeze: {
        command: 'storyfreeze',
        args: ['{storybookUrl}', '--chromium-path', '{chromiumPath}', '--out-dir', '{outDir}', '--parallel=4'],
        packagePath: 'storyfreeze.tgz',
      },
    },
  };
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(() => validateConfig({ ...config, parallel: 8 }), /parallel must be 4/);
  assert.throws(
    () =>
      validateConfig({
        ...config,
        implementations: {
          ...config.implementations,
          storycapture: { ...config.implementations.storycapture, args: [] },
        },
      }),
    /storycapture.args must explicitly set --parallel 4/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        implementations: {
          ...config.implementations,
          storycapture: {
            ...config.implementations.storycapture,
            args: config.implementations.storycapture.args.filter(argument => argument !== '{chromiumPath}'),
          },
        },
      }),
    /storycapture command must include the \{chromiumPath\} placeholder/,
  );
  assert.throws(() => validateConfig({ ...config, commandTimeoutMs: 0 }), /commandTimeoutMs/);
});

test(
  'terminates a command process group at the configured deadline',
  { skip: process.platform !== 'linux' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-record-timeout-'));
    try {
      const measured = await measureCommand({
        implementation: {
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          chromiumPath: '/chromium',
          storybookUrl: 'http://127.0.0.1:6006',
        },
        label: 'timeout',
        outputDir: path.join(root, 'output'),
        expectedPaths: [],
        invalidPngHashes: new Set(),
        artifactDir: path.join(root, 'artifacts'),
        configDir: root,
        commandTimeoutMs: 100,
      });

      assert.notEqual(measured.result.exitCode, 0);
      assert.equal(measured.result.timeoutCount, 1);
      assert.equal(measured.result.residualProcessCount, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
