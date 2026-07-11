#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const minimist = require('minimist');

const argv = minimist(process.argv.slice(2));

function runNpm(args, options) {
  const bundledNpmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const inheritedNpmCli = process.env.npm_execpath;
  const npmCli =
    inheritedNpmCli && path.basename(inheritedNpmCli) === 'npm-cli.js'
      ? inheritedNpmCli
      : fs.existsSync(bundledNpmCli)
        ? bundledNpmCli
        : undefined;
  if (npmCli) return execFileSync(process.execPath, [npmCli, ...args], options);
  return execFileSync('npm', args, options);
}

/**
 * This script sets up for Storybook examples.
 *
 * This script does:
 *
 * - create the storyfreeze npm tarball
 * - install the tarball under the Storybook example project
 *
 */
async function main() {
  const { _ } = argv;
  const target = _[0];
  if (!target) {
    console.log(`Usage:\n\t${process.argv[1]} directory`);
    return 0;
  }
  const prjDir = path.resolve(__dirname, '../packages/storyfreeze');
  const cwd = process.cwd();
  const targetDir = path.resolve(cwd, target);
  const dist = path.resolve(targetDir, 'node_modules/storyfreeze');
  if (prjDir === dist) {
    console.error(`target dir shold not be "${prjDir}".`);
    return 1;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-e2e-'));
  try {
    runNpm(['pack', '--ignore-scripts', '--pack-destination', tempDir], {
      cwd: prjDir,
      stdio: 'inherit',
    });
    const tarballs = fs.readdirSync(tempDir).filter(file => file.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new Error(`Expected one storyfreeze tarball, found ${tarballs.length}.`);

    runNpm(['install', '--no-save', '--package-lock=false', '--ignore-scripts', path.join(tempDir, tarballs[0])], {
      cwd: targetDir,
      stdio: 'inherit',
    });

    const sourceMetadata = JSON.parse(fs.readFileSync(path.join(prjDir, 'package.json'), 'utf8'));
    const installedMetadata = JSON.parse(fs.readFileSync(path.join(dist, 'package.json'), 'utf8'));
    if (installedMetadata.version !== sourceMetadata.version || fs.lstatSync(dist).isSymbolicLink()) {
      throw new Error('StoryFreeze was not installed from the generated package tarball.');
    }
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
