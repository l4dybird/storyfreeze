#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getReleaseMetadata } = require('./get-dist-tag.js');

const rootDir = path.resolve(__dirname, '..');

function createPublishArguments(version) {
  const { distTag } = getReleaseMetadata(version);
  return [
    '--filter',
    './packages/**',
    '-r',
    'publish',
    '--dry-run',
    '--no-git-checks',
    '--config.skip-manifest-obfuscation=true',
    '--tag',
    distTag,
    '--access',
    'public',
    '--registry',
    'https://registry.npmjs.org/',
  ];
}

function run() {
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(rootDir, 'packages/storyfreeze/package.json'), 'utf8'));
  const arguments = createPublishArguments(packageMetadata.version);
  const inheritedPnpmCli = process.env.npm_execpath;
  const usesInheritedCli = inheritedPnpmCli && /pnpm(?:\.cjs)?$/i.test(path.basename(inheritedPnpmCli));
  const command = usesInheritedCli ? process.execPath : 'pnpm';
  const commandArguments = usesInheritedCli ? [inheritedPnpmCli, ...arguments] : arguments;
  const options = {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  };
  const result =
    process.platform === 'win32' && !usesInheritedCli
      ? spawnSync(`pnpm ${arguments.map(argument => JSON.stringify(argument)).join(' ')}`, {
          ...options,
          shell: true,
        })
      : spawnSync(command, commandArguments, options);

  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (require.main === module) run();

module.exports = { createPublishArguments };
