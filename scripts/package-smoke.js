#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const packageDir = path.join(rootDir, 'packages', 'storyfreeze');
const expectedFiles = JSON.parse(fs.readFileSync(path.join(__dirname, 'storyfreeze-package-files.json'), 'utf8'));

function parseTarballArgument(args) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--tarball') {
    throw new Error('Usage: package-smoke.js [--tarball <path>]');
  }
  if (!args[1] || !args[1].endsWith('.tgz')) {
    throw new Error('The --tarball value must be a .tgz file.');
  }

  const tarballPath = path.resolve(rootDir, args[1]);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Tarball does not exist: ${tarballPath}`);
  }
  if (!fs.statSync(tarballPath).isFile()) {
    throw new Error(`Tarball is not a file: ${tarballPath}`);
  }
  return tarballPath;
}

const inputTarballPath = parseTarballArgument(process.argv.slice(2));
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-package-smoke-'));
const consumerDir = path.join(temporaryDir, 'consumer');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    encoding: 'utf8',
    env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: '1' },
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout || 120000,
  });

  if (result.error || result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw result.error || new Error(`${command} exited with status ${result.status}.`);
  }

  return result.stdout.trim();
}

function runFailure(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    encoding: 'utf8',
    env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: '1' },
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout || 120000,
  });
  if (result.error) throw result.error;
  if (result.status === 0) throw new Error(`${command} unexpectedly exited successfully.`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function runNpm(args, cwd) {
  if (process.platform !== 'win32') return run('npm', args, { cwd, timeout: 180000 });
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) {
    throw new Error(`Unable to locate the npm CLI at ${npmCli}.`);
  }
  return run(process.execPath, [npmCli, ...args], { cwd, timeout: 180000 });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

try {
  const packResult = inputTarballPath
    ? JSON.parse(runNpm(['pack', '--json', '--dry-run', '--ignore-scripts', inputTarballPath], rootDir))[0]
    : JSON.parse(runNpm(['pack', '--json', '--pack-destination', temporaryDir], packageDir))[0];
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

  const tarballPath = inputTarballPath || path.join(temporaryDir, packResult.filename);
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath], consumerDir);

  const installedPackageDir = path.join(consumerDir, 'node_modules', 'storyfreeze');
  const installedMetadata = JSON.parse(fs.readFileSync(path.join(installedPackageDir, 'package.json'), 'utf8'));
  if (!installedMetadata.dependencies?.gunshi || installedMetadata.dependencies?.yargs) {
    throw new Error('The installed package did not replace its direct yargs dependency with gunshi.');
  }
  if (installedMetadata.dependencies?.['playwright-core'] !== '1.61.1') {
    throw new Error('The installed package did not declare the pinned Playwright runtime.');
  }
  if (installedMetadata.dependencies?.['puppeteer-core'] || installedMetadata.devDependencies?.puppeteer) {
    throw new Error('The installed package still declares a Puppeteer runtime.');
  }
  if (
    installedMetadata.dependencies?.storycrawler ||
    fs.existsSync(path.join(consumerDir, 'node_modules', 'storycrawler'))
  ) {
    throw new Error('The installed package still depends on storycrawler.');
  }
  for (const declaration of actualFiles.filter(file => file.endsWith('.d.ts'))) {
    const contents = fs.readFileSync(path.join(installedPackageDir, declaration), 'utf8');
    if (contents.includes('storycrawler')) {
      throw new Error(`The declaration ${declaration} still references storycrawler.`);
    }
  }

  fs.writeFileSync(
    path.join(consumerDir, 'contract.ts'),
    `import { isScreenshot, withScreenshot } from 'storyfreeze';
import type {
  ScreenshotOptionFragments,
  ScreenshotOptionFragmentsForVariant,
  ScreenshotOptions,
  Variants,
  Viewport,
} from 'storyfreeze';

const viewport: Viewport = { width: 800, height: 600, deviceScaleFactor: 2 };
const fragments: ScreenshotOptionFragments = { viewport };
const variant: ScreenshotOptionFragmentsForVariant = { extends: 'base', focus: '#target' };
const variants: Variants = { focused: variant };
const options: ScreenshotOptions = { ...fragments, variants };

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
  const typescriptPackagePath = require.resolve('typescript/package.json', { paths: [packageDir] });
  const tscCliPath = path.join(path.dirname(typescriptPackagePath), 'bin', 'tsc');
  run(process.execPath, [tscCliPath, '--project', 'tsconfig.json'], { cwd: consumerDir });

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
  const cliWrapperPath = path.join(binDir, process.platform === 'win32' ? 'storyfreeze.cmd' : 'storyfreeze');
  if (!fs.existsSync(cliWrapperPath)) {
    throw new Error(`The package manager did not create the StoryFreeze CLI wrapper: ${cliWrapperPath}`);
  }

  const cliPath = path.join(installedPackageDir, installedMetadata.bin.storyfreeze);
  const version = run(process.execPath, [cliPath, '--version'], { cwd: consumerDir });
  assertEqual(version, packResult.version, 'CLI version');

  const help = run(process.execPath, [cliPath, '--help'], { cwd: consumerDir });
  if (
    !help.includes('USAGE:') ||
    !help.includes('--server-cmd') ||
    !help.includes('--browser-launch-options') ||
    help.includes('--puppeteer-launch-config') ||
    help.includes('--browser-backend') ||
    !help.includes('--browser-isolation') ||
    !help.includes('(default: process, choices: process | context)')
  ) {
    throw new Error('CLI help did not contain the expected Gunshi usage and kebab-case options.');
  }

  const invalid = runFailure(process.execPath, [cliPath, '--serverCmd', 'echo nope'], { cwd: consumerDir });
  if (!invalid.includes('Unknown option: --serverCmd')) {
    throw new Error('CLI did not reject a legacy camelCase option in strict mode.');
  }

  console.log(`Package smoke passed for ${packResult.id} with ${actualFiles.length} files.`);
} finally {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
}
