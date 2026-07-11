#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const packageDir = path.join(rootDir, 'packages', 'storyfreeze');
const expectedFiles = JSON.parse(fs.readFileSync(path.join(__dirname, 'storyfreeze-package-files.json'), 'utf8'));
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-package-smoke-'));
const consumerDir = path.join(temporaryDir, 'consumer');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    encoding: 'utf8',
    env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: '1' },
    maxBuffer: 20 * 1024 * 1024,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/.test(command),
    timeout: options.timeout || 120000,
  });

  if (result.error || result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw result.error || new Error(`${command} exited with status ${result.status}.`);
  }

  return result.stdout.trim();
}

function runNpm(args, cwd) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return run(npmCommand, args, { cwd, timeout: 180000 });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

try {
  const packResult = JSON.parse(runNpm(['pack', '--json', '--pack-destination', temporaryDir], packageDir))[0];
  const actualFiles = packResult.files.map(file => file.path).sort();
  assertEqual(JSON.stringify(actualFiles), JSON.stringify([...expectedFiles].sort()), 'tarball files');

  fs.mkdirSync(consumerDir);
  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'storyfreeze-package-smoke',
        private: true,
        type: 'module',
        dependencies: { storybook: '10.5.0' },
      },
      null,
      2,
    )}\n`,
  );

  const tarballPath = path.join(temporaryDir, packResult.filename);
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath], consumerDir);

  const imported = run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const pkg = await import('storyfreeze'); process.stdout.write(Object.keys(pkg).sort().join(','));",
    ],
    { cwd: consumerDir },
  );
  assertEqual(imported, 'isScreenshot,withScreenshot', 'ESM exports');

  const preview = run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const preview = (await import('storyfreeze/preview')).default; process.stdout.write(Object.keys(preview).sort().join(','));",
    ],
    { cwd: consumerDir },
  );
  assertEqual(preview, 'afterEach,decorators', 'preview exports');

  const requireCheck = run(
    process.execPath,
    [
      '--eval',
      "try { require('storyfreeze'); process.exit(2); } catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }",
    ],
    { cwd: consumerDir },
  );
  assertEqual(requireCheck, '', 'CommonJS rejection');

  const binDir = path.join(consumerDir, 'node_modules', '.bin');
  const cliPath = path.join(binDir, process.platform === 'win32' ? 'storyfreeze.cmd' : 'storyfreeze');
  const version = run(cliPath, ['--version'], { cwd: consumerDir });
  assertEqual(version, packResult.version, 'CLI version');

  const help = run(cliPath, ['--help'], { cwd: consumerDir });
  if (!help.includes('usage: storyfreeze [options] storybook_url')) {
    throw new Error('CLI help did not contain the expected usage line.');
  }

  console.log(`Package smoke passed for ${packResult.id} with ${actualFiles.length} files.`);
} finally {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
}
