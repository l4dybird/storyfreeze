#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const fixtureDir = path.resolve(process.cwd(), process.argv[2] || '.');
const npmCli = process.env.npm_execpath;

const interactionScreenshotPaths = [
  'Compatibility/Fixture/Interactions_clicked.png',
  'Compatibility/Fixture/Interactions_LARGE.png',
  'Compatibility/Fixture/Interactions_LARGE_focused.png',
  'Compatibility/Fixture/Interactions_LARGE_hovered.png',
  'Compatibility/Fixture/Interactions_SMALL.png',
  'Compatibility/Fixture/Interactions_SMALL_focused.png',
  'Compatibility/Fixture/Interactions_SMALL_hovered.png',
].sort();
const managedScreenshotPaths = [
  'Compatibility/Fixture/Console Error_LARGE.png',
  'Compatibility/Fixture/Console Error_SMALL.png',
  ...interactionScreenshotPaths,
  'Compatibility/Fixture/Retry_LARGE.png',
  'Compatibility/Fixture/Retry_SMALL.png',
].sort();
const simpleScreenshotPaths = [
  'Compatibility/Fixture/Console Error.png',
  'Compatibility/Fixture/Interactions.png',
  'Compatibility/Fixture/Retry.png',
].sort();
const retryScreenshotPaths = ['Compatibility/Fixture/Retry_LARGE.png', 'Compatibility/Fixture/Retry_SMALL.png'].sort();

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
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180000,
  });

  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    output: output.replace(/\u001b\[[0-9;]*m/g, '').replace(/\\/g, '/'),
  };
}

function assertStaticBuild(directoryName) {
  const buildDir = path.join(fixtureDir, directoryName);
  const index = JSON.parse(fs.readFileSync(path.join(buildDir, 'index.json'), 'utf8'));
  const entries = Object.values(index.entries || {});

  if (!entries.some(entry => entry.type === 'story')) {
    throw new Error(`${directoryName} did not emit a story entry.`);
  }
  if (!entries.some(entry => entry.type === 'docs')) {
    throw new Error(`${directoryName} did not emit a docs entry.`);
  }

  const assets = fs.readdirSync(path.join(buildDir, 'assets'));
  if (!assets.some(asset => asset.endsWith('.woff2'))) {
    throw new Error(`${directoryName} did not bundle the local font asset.`);
  }
  if (!fs.existsSync(path.join(buildDir, 'fixture.svg'))) {
    throw new Error(`${directoryName} did not copy the local image asset.`);
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

function expectedDimensions(relativePath) {
  const logical = relativePath.includes('_SMALL')
    ? [750, 1334]
    : relativePath.includes('_LARGE') || relativePath.endsWith('/Interactions_clicked.png')
      ? [1200, 800]
      : [800, 600];
  const scales = process.platform === 'linux' ? [1] : [1, 1.25, 1.5, 1.75, 2];
  return scales.map(scale => logical.map(value => Math.round(value * scale)));
}

function assertScreenshots(directoryName, expectedPaths) {
  const screenshotDir = path.join(fixtureDir, directoryName);
  const screenshots = findScreenshots(directoryName);
  const actualPaths = screenshots.map(file => path.relative(screenshotDir, file).replaceAll('\\', '/')).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`${directoryName} emitted unexpected screenshots: ${JSON.stringify(actualPaths)}.`);
  }

  for (const screenshot of screenshots) {
    const relativePath = path.relative(screenshotDir, screenshot).replaceAll('\\', '/');
    const png = fs.readFileSync(screenshot);
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new Error(`${relativePath} is not a PNG file.`);
    }
    if (png.length < 24) {
      throw new Error(`${relativePath} has a truncated PNG header.`);
    }

    const dimensions = [png.readUInt32BE(16), png.readUInt32BE(20)];
    const expected = expectedDimensions(relativePath);
    if (
      !expected.some(([width, height]) => Math.abs(dimensions[0] - width) <= 1 && Math.abs(dimensions[1] - height) <= 1)
    ) {
      throw new Error(
        `${relativePath} is ${dimensions.join('x')}; expected ${expected.map(value => value.join('x')).join(' or ')}.`,
      );
    }
  }
}

function assertCapture({ script, mode, directoryName, expectedPaths, extraFragments = [] }) {
  const capture = runNpm(script);
  if (capture.status !== 0) {
    throw new Error(`${script} must complete successfully.`);
  }

  const expectedFragments = [
    `StoryFreeze runs with ${mode} mode`,
    'Shutdown storybook server',
    `capturing ${expectedPaths.length} PNGs`,
    ...extraFragments,
  ];
  const missingFragments = expectedFragments.filter(fragment => !capture.output.includes(fragment));
  if (missingFragments.length > 0) {
    throw new Error(`${script} is missing diagnostics: ${missingFragments.join(', ')}.`);
  }

  const oppositeMode = mode === 'managed' ? 'simple' : 'managed';
  if (capture.output.includes(`StoryFreeze runs with ${oppositeMode} mode`)) {
    throw new Error(`${script} unexpectedly ran in ${oppositeMode} mode.`);
  }
  if (capture.output.includes('Error rendering story')) {
    throw new Error(`${script} rendered a Storybook error page.`);
  }

  assertScreenshots(directoryName, expectedPaths);
}

function requireSuccess(script, message) {
  const result = runNpm(script);
  if (result.status !== 0) throw new Error(message);
}

function main() {
  requireSuccess('clear', 'Failed to clear the Storybook 10 fixture.');
  requireSuccess('build-storybook:simple', 'The simple Storybook 10 static build must succeed.');
  assertStaticBuild('storybook-static/simple');

  requireSuccess('storyfreeze:prepare', 'Failed to install the local StoryFreeze tarball into the fixture.');
  requireSuccess('build-storybook:managed', 'The managed Storybook 10 static build must succeed.');
  assertStaticBuild('storybook-static/managed');

  assertCapture({
    script: 'storyfreeze:simple-dev',
    mode: 'simple',
    directoryName: '__screenshots__/simple-dev',
    expectedPaths: simpleScreenshotPaths,
    extraFragments: ['Found 3 stories.'],
  });
  assertCapture({
    script: 'storyfreeze:managed-dev',
    mode: 'managed',
    directoryName: '__screenshots__/managed-dev',
    expectedPaths: managedScreenshotPaths,
    extraFragments: ['Found 3 stories.'],
  });
  assertCapture({
    script: 'storyfreeze:simple-static',
    mode: 'simple',
    directoryName: '__screenshots__/simple-static',
    expectedPaths: simpleScreenshotPaths,
    extraFragments: ['Found 3 stories.'],
  });
  assertCapture({
    script: 'storyfreeze:managed-static',
    mode: 'managed',
    directoryName: '__screenshots__/managed-static',
    expectedPaths: managedScreenshotPaths,
    extraFragments: ['Found 3 stories.'],
  });
  assertCapture({
    script: 'storyfreeze:filter-dev',
    mode: 'managed',
    directoryName: '__screenshots__/filter-dev',
    expectedPaths: interactionScreenshotPaths,
    extraFragments: ['Found 1 stories.'],
  });
  assertCapture({
    script: 'storyfreeze:filter-static',
    mode: 'managed',
    directoryName: '__screenshots__/filter-static',
    expectedPaths: interactionScreenshotPaths,
    extraFragments: ['Found 1 stories.'],
  });
  assertCapture({
    script: 'storyfreeze:shard-dev',
    mode: 'managed',
    directoryName: '__screenshots__/shard-dev',
    expectedPaths: interactionScreenshotPaths,
    extraFragments: ['Found 3 stories. 1 are being processed by this shard (number 2 of 2).'],
  });
  assertCapture({
    script: 'storyfreeze:shard-static',
    mode: 'managed',
    directoryName: '__screenshots__/shard-static',
    expectedPaths: interactionScreenshotPaths,
    extraFragments: ['Found 3 stories. 1 are being processed by this shard (number 2 of 2).'],
  });
  assertCapture({
    script: 'storyfreeze:retry-dev',
    mode: 'managed',
    directoryName: '__screenshots__/retry-dev',
    expectedPaths: retryScreenshotPaths,
    extraFragments: ['Found 1 stories.', 'Retry to screenshot this story after this sequence.'],
  });
  assertCapture({
    script: 'storyfreeze:retry-static',
    mode: 'managed',
    directoryName: '__screenshots__/retry-static',
    expectedPaths: retryScreenshotPaths,
    extraFragments: ['Found 1 stories.', 'Retry to screenshot this story after this sequence.'],
  });

  console.log(
    'Verified Storybook 10 dev/static, simple/managed, filtering, sharding, retry, and packaged CLI execution.',
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
