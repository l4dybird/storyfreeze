#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const fixtureDir = path.resolve(process.cwd(), process.argv[2] || '.');
const npmCli = process.env.npm_execpath;
const managedScreenshotPaths = [
  'Compatibility/Fixture/Console Error_LARGE.png',
  'Compatibility/Fixture/Console Error_SMALL.png',
  'Compatibility/Fixture/Interactions_clicked.png',
  'Compatibility/Fixture/Interactions_LARGE.png',
  'Compatibility/Fixture/Interactions_LARGE_focused.png',
  'Compatibility/Fixture/Interactions_LARGE_hovered.png',
  'Compatibility/Fixture/Interactions_SMALL.png',
  'Compatibility/Fixture/Interactions_SMALL_focused.png',
  'Compatibility/Fixture/Interactions_SMALL_hovered.png',
].sort();
const simpleScreenshotPaths = [
  'Compatibility/Fixture/Console Error.png',
  'Compatibility/Fixture/Interactions.png',
].sort();

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

function findScreenshots(directoryName) {
  const screenshotDir = path.join(fixtureDir, directoryName);
  if (!fs.existsSync(screenshotDir)) {
    return [];
  }

  const screenshots = [];
  const pending = [screenshotDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.name.endsWith('.png')) {
        screenshots.push(entryPath);
      }
    }
  }
  return screenshots;
}

function assertScreenshots(screenshots, directoryName, expectedPaths) {
  const screenshotDir = path.join(fixtureDir, directoryName);
  const actualPaths = screenshots.map(file => path.relative(screenshotDir, file).replaceAll('\\', '/')).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`Unexpected screenshots: ${JSON.stringify(actualPaths)}.`);
  }

  for (const screenshot of screenshots) {
    const png = fs.readFileSync(screenshot);
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new Error(`${screenshot} is not a PNG file.`);
    }
    if (png.length < 24 || png.readUInt32BE(16) === 0 || png.readUInt32BE(20) === 0) {
      throw new Error(`${screenshot} has invalid PNG dimensions.`);
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
  if (compatibility.status !== 0) {
    throw new Error('The managed Storybook 10 build must succeed after ESM packaging.');
  }

  const simpleCapture = runNpm('storyfreeze:simple-dev');
  if (simpleCapture.status !== 0) {
    throw new Error('StoryFreeze must complete the Storybook 10 simple-mode capture.');
  }
  for (const fragment of ['StoryFreeze runs with simple mode', 'Shutdown storybook server', 'capturing 2 PNGs']) {
    if (!simpleCapture.output.replace(/\\/g, '/').includes(fragment)) {
      throw new Error(`Simple-mode capture is missing diagnostic: ${fragment}.`);
    }
  }
  if (simpleCapture.output.includes('StoryFreeze runs with managed mode')) {
    throw new Error('Simple mode unexpectedly detected the managed preview protocol.');
  }
  if (simpleCapture.output.includes('Error rendering story')) {
    throw new Error('Storybook rendered an error page during simple-mode capture.');
  }
  assertScreenshots(findScreenshots('__screenshots__/simple'), '__screenshots__/simple', simpleScreenshotPaths);

  const capture = runNpm('storyfreeze:dev');
  if (capture.status !== 0) {
    throw new Error('StoryFreeze must complete the Storybook 10 capture.');
  }
  const expectedFragments = ['StoryFreeze runs with managed mode', 'Shutdown storybook server', 'capturing 9 PNGs'];
  const missingFragments = expectedFragments.filter(fragment => !capture.output.replace(/\\/g, '/').includes(fragment));
  if (missingFragments.length > 0) {
    throw new Error(`StoryFreeze failed at an unexpected point. Missing: ${missingFragments.join(', ')}`);
  }
  if (capture.output.includes('StoryFreeze runs with simple mode')) {
    throw new Error('Managed mode handshake was not detected on the Storybook preview.');
  }
  if (capture.output.includes('Error rendering story')) {
    throw new Error('Storybook rendered an error page during capture.');
  }

  const screenshots = findScreenshots('__screenshots__/managed');
  assertScreenshots(screenshots, '__screenshots__/managed', managedScreenshotPaths);
  console.log('Verified the Storybook 10 simple mode and managed preview protocol.');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
