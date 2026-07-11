#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const fixtureDir = path.resolve(process.cwd(), process.argv[2] || '.');
const npmCli = process.env.npm_execpath;

function runNpm(script) {
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = npmCli ? [npmCli, 'run', script] : ['run', script];
  const result = spawnSync(command, args, {
    cwd: fixtureDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: 'true',
      FORCE_COLOR: '0',
      STORYBOOK_DISABLE_TELEMETRY: '1',
    },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000,
  });

  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    output: output.replace(/\u001b\[[0-9;]*m/g, ''),
  };
}

function assertBaseline() {
  const indexPath = path.join(fixtureDir, 'storybook-static-baseline', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const entries = Object.values(index.entries || {});

  if (!entries.some(entry => entry.type === 'story')) {
    throw new Error('The Storybook 10 baseline did not emit a story entry.');
  }
  if (!entries.some(entry => entry.type === 'docs')) {
    throw new Error('The Storybook 10 baseline did not emit a docs entry.');
  }

  const assetsDir = path.join(fixtureDir, 'storybook-static-baseline', 'assets');
  const assets = fs.readdirSync(assetsDir);
  if (!assets.some(asset => asset.endsWith('.woff2'))) {
    throw new Error('The Storybook 10 baseline did not bundle the local font asset.');
  }
  if (!fs.existsSync(path.join(fixtureDir, 'storybook-static-baseline', 'fixture.svg'))) {
    throw new Error('The Storybook 10 baseline did not copy the local image asset.');
  }
}

function assertNoScreenshots() {
  const screenshotDir = path.join(fixtureDir, '__screenshots__');
  if (!fs.existsSync(screenshotDir)) {
    return;
  }

  const pending = [screenshotDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.name.endsWith('.png')) {
        throw new Error(`Unexpected screenshot generated: ${entryPath}`);
      }
    }
  }
}

function main() {
  const clear = runNpm('clear');
  if (clear.status !== 0) {
    throw new Error('Failed to clear the Storybook 10 fixture.');
  }

  const baseline = runNpm('build-storybook:baseline');
  if (baseline.status !== 0) {
    throw new Error('The Storybook 10 baseline build must succeed.');
  }
  assertBaseline();

  const prepare = runNpm('storyfreeze:prepare');
  if (prepare.status !== 0) {
    throw new Error('Failed to install the local StoryFreeze build into the fixture.');
  }

  const compatibility = runNpm('build-storybook');
  if (compatibility.status === 0) {
    throw new Error('StoryFreeze unexpectedly passed its Storybook 10 compatibility check.');
  }

  const expectedFragments = [
    'SB_CORE-SERVER_0002',
    'ERR_MODULE_NOT_FOUND',
    'storyfreeze/lib-esm/client/with-screenshot',
  ];
  const missingFragments = expectedFragments.filter(
    fragment => !compatibility.output.replace(/\\/g, '/').includes(fragment),
  );
  if (missingFragments.length > 0) {
    throw new Error(`StoryFreeze failed at an unexpected point. Missing: ${missingFragments.join(', ')}`);
  }

  assertNoScreenshots();
  console.log('Observed the expected Storybook 10 compatibility failure.');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
