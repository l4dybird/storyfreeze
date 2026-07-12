#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function runPnpm(args, options) {
  const inheritedPnpmCli = process.env.npm_execpath;
  if (inheritedPnpmCli && /pnpm(?:\.cjs)?$/i.test(path.basename(inheritedPnpmCli))) {
    return execFileSync(process.execPath, [inheritedPnpmCli, ...args], options);
  }
  return execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    ...options,
    shell: process.platform === 'win32',
  });
}

function runNpm(args, options) {
  const bundledNpmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (fs.existsSync(bundledNpmCli)) {
    return execFileSync(process.execPath, [bundledNpmCli, ...args], options);
  }
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

/**
 * This script sets up for Storybook examples.
 *
 * This script does:
 *
 * - deploy the Storybook example into an isolated directory
 * - create and install the StoryFreeze tarball there
 * - run the compatibility protocol against the deployed fixture
 *
 */
async function main() {
  const target = process.argv[2];
  if (!target) {
    console.log(`Usage:\n\t${process.argv[1]} directory`);
    return 0;
  }

  const repoDir = path.resolve(__dirname, '..');
  const packageDir = path.join(repoDir, 'packages/storyfreeze');
  const sourceFixtureDir = path.resolve(process.cwd(), target);
  const fixtureMetadata = JSON.parse(fs.readFileSync(path.join(sourceFixtureDir, 'package.json'), 'utf8'));
  if (!fixtureMetadata.name) throw new Error(`Fixture package is missing a name: ${sourceFixtureDir}.`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-e2e-'));
  const deployedFixtureDir = path.join(tempDir, 'fixture');
  try {
    runPnpm(['--filter', fixtureMetadata.name, 'deploy', '--legacy', deployedFixtureDir], {
      cwd: repoDir,
      stdio: 'inherit',
    });
    fs.copyFileSync(path.join(repoDir, 'pnpm-workspace.yaml'), path.join(deployedFixtureDir, 'pnpm-workspace.yaml'));

    runNpm(['pack', '--ignore-scripts', '--pack-destination', tempDir], {
      cwd: packageDir,
      stdio: 'inherit',
    });
    const tarballs = fs.readdirSync(tempDir).filter(file => file.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new Error(`Expected one storyfreeze tarball, found ${tarballs.length}.`);

    runPnpm(
      [
        '--dir',
        deployedFixtureDir,
        'add',
        '--workspace-root',
        '--prefer-offline',
        '--ignore-scripts',
        '--save-exact',
        path.join(tempDir, tarballs[0]),
      ],
      {
        cwd: repoDir,
        stdio: 'inherit',
      },
    );

    const dist = path.join(deployedFixtureDir, 'node_modules/storyfreeze');
    const sourceMetadata = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const installedMetadata = JSON.parse(fs.readFileSync(path.join(dist, 'package.json'), 'utf8'));
    const sourceRealpath = fs.realpathSync(packageDir);
    const installedRealpath = fs.realpathSync(dist);
    const normalizePath = value => (process.platform === 'win32' ? value.toLowerCase() : value);
    if (normalizePath(sourceRealpath) === normalizePath(installedRealpath)) {
      throw new Error('StoryFreeze was not installed from the generated package tarball.');
    }

    const metadataKeys = [
      'name',
      'version',
      'type',
      'main',
      'types',
      'exports',
      'bin',
      'engines',
      'dependencies',
      'peerDependencies',
    ];
    for (const key of metadataKeys) {
      if (JSON.stringify(installedMetadata[key]) !== JSON.stringify(sourceMetadata[key])) {
        throw new Error(`Installed StoryFreeze metadata did not match the source package: ${key}.`);
      }
    }

    execFileSync(process.execPath, [path.join(__dirname, 'storybook-preview-protocol.js'), deployedFixtureDir], {
      cwd: sourceFixtureDir,
      stdio: 'inherit',
    });
    return 0;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main()
  .then(code => (process.exitCode = code))
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
