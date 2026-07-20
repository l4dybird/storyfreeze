#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const packageDir = path.join(rootDir, 'packages', 'storyfreeze');
const sourceMetadata = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
const npmBefore = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();

function parseTarballArgument(args) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--tarball') {
    throw new Error('Usage: package-smoke.js [--tarball <path>]');
  }
  const tarball = path.resolve(rootDir, args[1]);
  if (!tarball.endsWith('.tgz') || !fs.statSync(tarball, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`The --tarball value must be an existing .tgz file: ${tarball}`);
  }
  return tarball;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: 'utf8',
    env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: '1' },
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
  });
  if (result.error || result.status !== 0) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw result.error ?? new Error(`${command} exited with status ${result.status}.`);
  }
  return result.stdout.trim();
}

function runFailure(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: '1' },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status === 0) throw new Error(`${command} unexpectedly exited successfully.`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function runNpm(args, cwd) {
  if (process.platform !== 'win32') return run('npm', args, { cwd });
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) throw new Error(`Unable to locate the npm CLI at ${npmCli}.`);
  return run(process.execPath, [npmCli, ...args], { cwd });
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

function writeConsumerPackage(directory, version, tarball) {
  fs.mkdirSync(directory);
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: `storyfreeze-smoke-storybook-${version}`,
        private: true,
        type: 'module',
        dependencies: { storybook: version, storyfreeze: `file:${tarball}` },
      },
      null,
      2,
    )}\n`,
  );
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', `--before=${npmBefore}`], directory);
}

function verifyCompatibility(temporaryDir, tarball, version) {
  const directory = path.join(temporaryDir, `storybook-${version}`);
  writeConsumerPackage(directory, version, tarball);
  const actualVersion = JSON.parse(
    fs.readFileSync(path.join(directory, 'node_modules', 'storybook', 'package.json'), 'utf8'),
  ).version;
  assertEqual(actualVersion, version, `Storybook ${version} compatibility version`);
  const exports = run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const [preset, preview] = await Promise.all([import('storyfreeze/preset'), import('storyfreeze/preview')]); process.stdout.write(`${Object.keys(preset).sort().join(',')}|${Object.keys(preview.default).sort().join(',')}`);",
    ],
    { cwd: directory },
  );
  assertEqual(exports, 'experimental_indexers|afterEach,decorators', `Storybook ${version} addon exports`);
}

function verifyTypes(consumerDir) {
  fs.writeFileSync(
    path.join(consumerDir, 'contract.ts'),
    `import { isScreenshot, withScreenshot } from 'storyfreeze';
import type {
  ScreenshotOptionFragments,
  ScreenshotOptionFragmentsForVariant,
  ScreenshotOptions,
  StorySessionResetContext,
  Variants,
  Viewport,
} from 'storyfreeze';

const viewport: Viewport = { width: 800, height: 600, deviceScaleFactor: 2 };
const fragments: ScreenshotOptionFragments = { viewport, waitImages: true };
const variant: ScreenshotOptionFragmentsForVariant = { extends: 'base', focus: '#target' };
const variants: Variants = { focused: variant };
const reset = async ({ storyId, variantId }: StorySessionResetContext) => void [storyId, variantId];
const options: ScreenshotOptions = { ...fragments, variants, reset };

void isScreenshot;
void withScreenshot;
void options;
`,
  );
  fs.writeFileSync(
    path.join(consumerDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2022', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
          target: 'ES2022',
        },
        files: ['contract.ts'],
      },
      null,
      2,
    )}\n`,
  );
  const typescriptPackage = require.resolve('typescript/package.json', { paths: [packageDir] });
  run(process.execPath, [path.join(path.dirname(typescriptPackage), 'bin', 'tsc'), '--project', 'tsconfig.json'], {
    cwd: consumerDir,
  });
}

const inputTarball = parseTarballArgument(process.argv.slice(2));
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-package-smoke-'));

try {
  const pack = inputTarball
    ? JSON.parse(runNpm(['pack', '--json', '--dry-run', '--ignore-scripts', inputTarball], rootDir))[0]
    : JSON.parse(runNpm(['pack', '--json', '--pack-destination', temporaryDir], packageDir))[0];
  const tarball = inputTarball ?? path.join(temporaryDir, pack.filename);
  const consumerDir = path.join(temporaryDir, 'consumer');
  writeConsumerPackage(consumerDir, '10.5.2', tarball);

  const installedDir = path.join(consumerDir, 'node_modules', 'storyfreeze');
  const installed = JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8'));
  assertEqual(installed.name, sourceMetadata.name, 'package name');
  assertEqual(installed.version, sourceMetadata.version, 'package version');
  assertEqual(installed.engines, sourceMetadata.engines, 'package engines');
  assertEqual(installed.dependencies, sourceMetadata.dependencies, 'production dependencies');
  if (fs.realpathSync(installedDir) === fs.realpathSync(packageDir)) {
    throw new Error('The consumer resolved workspace source instead of the packed tarball.');
  }

  const rootExports = run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const value=await import('storyfreeze');process.stdout.write(Object.keys(value).sort().join(','));",
    ],
    { cwd: consumerDir },
  );
  assertEqual(rootExports, 'isScreenshot,withScreenshot', 'root exports');
  const previewExports = run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const value=(await import('storyfreeze/preview')).default;process.stdout.write(Object.keys(value).sort().join(','));",
    ],
    { cwd: consumerDir },
  );
  assertEqual(previewExports, 'afterEach,decorators', 'preview exports');
  const presetExports = run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const value=await import('storyfreeze/preset');process.stdout.write(Object.keys(value).sort().join(','));",
    ],
    { cwd: consumerDir },
  );
  assertEqual(presetExports, 'experimental_indexers', 'preset exports');

  verifyTypes(consumerDir);

  const cli = path.join(installedDir, installed.bin.storyfreeze);
  const help = run(process.execPath, [cli, '--help'], { cwd: consumerDir });
  for (const option of ['--browser-launch-options', '--capture-timeout', '--exclude', '--include', '--shard']) {
    if (!help.includes(option)) throw new Error(`CLI help does not include ${option}.`);
  }
  for (const removed of ['--browser-isolation', '--capture-protocol', '--mode', '--server-cmd', '--trace']) {
    if (help.includes(removed)) throw new Error(`CLI help still includes removed option ${removed}.`);
  }
  const invalid = runFailure(process.execPath, [cli, '--mode', 'simple'], consumerDir);
  if (!invalid.includes('Unknown option: --mode')) throw new Error('CLI did not reject a removed option.');

  for (const version of ['10.0.0', '10.4.0']) verifyCompatibility(temporaryDir, tarball, version);

  console.log(`Package smoke passed for ${installed.name}@${installed.version}.`);
} finally {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
}
