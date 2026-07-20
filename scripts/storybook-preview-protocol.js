#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { resolvePnpmCommand } = require('./pnpm-command.js');

const fixtureDir = path.resolve(process.cwd(), process.argv[2] || '.');
const repoDir = path.resolve(__dirname, '..');

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
const retryScreenshotPaths = ['Compatibility/Fixture/Retry_LARGE.png', 'Compatibility/Fixture/Retry_SMALL.png'].sort();

function runPnpm(script) {
  const invocation = resolvePnpmCommand(['--dir', fixtureDir, 'run', script]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoDir,
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

function runPnpmAsync(script) {
  const invocation = resolvePnpmCommand(['--dir', fixtureDir, 'run', script]);

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: repoDir,
      env: {
        ...process.env,
        CI: 'true',
        FORCE_COLOR: '0',
        STORYBOOK_DISABLE_TELEMETRY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout;
    const finish = action => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };
    const append = (target, chunk) => {
      const next = target + chunk;
      if (Buffer.byteLength(next) > 20 * 1024 * 1024) {
        child.kill('SIGKILL');
        finish(() => reject(new Error(`${script} exceeded the 20 MiB output limit.`)));
      }
      return next;
    };
    child.stdout.on('data', chunk => (stdout = append(stdout, chunk)));
    child.stderr.on('data', chunk => (stderr = append(stderr, chunk)));
    child.once('error', error => finish(() => reject(error)));
    child.once('close', status =>
      finish(() => {
        const output = `${stdout}${stderr}`;
        process.stdout.write(output);
        resolve({
          status,
          output: output.replace(/\u001b\[[0-9;]*m/g, '').replace(/\\/g, '/'),
        });
      }),
    );
    timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`${script} exceeded the 180000 msec timeout.`)));
    }, 180000);
  });
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

function validateCapture({ script, directoryName, expectedPaths, extraFragments = [] }, capture) {
  if (capture.status !== 0) {
    throw new Error(`${script} must complete successfully.`);
  }

  const expectedFragments = [
    'StoryFreeze runs with managed mode',
    `capturing ${expectedPaths.length} PNGs`,
    'Found Storybook server',
    ...extraFragments,
  ];
  const missingFragments = expectedFragments.filter(fragment => !capture.output.includes(fragment));
  if (missingFragments.length > 0) {
    throw new Error(`${script} is missing diagnostics: ${missingFragments.join(', ')}.`);
  }

  if (capture.output.includes('Error rendering story')) {
    throw new Error(`${script} rendered a Storybook error page.`);
  }

  assertScreenshots(directoryName, expectedPaths);
}

function assertCapture(options) {
  validateCapture(options, runPnpm(options.script));
}

async function assertCapturesConcurrently(options) {
  const results = await Promise.allSettled(
    options.map(async captureOptions => validateCapture(captureOptions, await runPnpmAsync(captureOptions.script))),
  );
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'One or more concurrent StoryFreeze captures failed.');
}

function requireSuccess(script, message) {
  const result = runPnpm(script);
  if (result.status !== 0) throw new Error(message);
}

function startVitePreview(directoryName, port) {
  const vitePackagePath = require.resolve('vite/package.json', { paths: [fixtureDir] });
  const vitePackage = JSON.parse(fs.readFileSync(vitePackagePath, 'utf8'));
  const viteBin = typeof vitePackage.bin === 'string' ? vitePackage.bin : vitePackage.bin.vite;
  const child = spawn(
    process.execPath,
    [
      path.resolve(path.dirname(vitePackagePath), viteBin),
      'preview',
      '--outDir',
      directoryName,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: fixtureDir,
      env: {
        ...process.env,
        CI: 'true',
        FORCE_COLOR: '0',
      },
      stdio: 'inherit',
    },
  );

  let spawnError;
  child.once('error', error => {
    spawnError = error;
  });

  return { child, getSpawnError: () => spawnError };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForServer(server, url, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastError;

  while (Date.now() < deadline) {
    const spawnError = server.getSpawnError();
    if (spawnError) throw spawnError;
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      const reason =
        server.child.exitCode !== null ? `code ${server.child.exitCode}` : `signal ${server.child.signalCode}`;
      throw new Error(`Vite preview exited with ${reason} before becoming ready.`);
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      lastError = new Error(`${url} returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }

    await delay(250);
  }

  throw new Error(`Vite preview did not become ready within ${timeout} msec.`, { cause: lastError });
}

function isServerStopped(server) {
  return server.getSpawnError() || server.child.exitCode !== null || server.child.signalCode !== null;
}

function waitForServerStop(server, timeout) {
  if (isServerStopped(server)) return Promise.resolve(true);

  return new Promise(resolve => {
    let timer;
    const finish = stopped => {
      clearTimeout(timer);
      server.child.off('exit', onStop);
      server.child.off('error', onStop);
      resolve(stopped);
    };
    const onStop = () => finish(true);

    server.child.once('exit', onStop);
    server.child.once('error', onStop);
    timer = setTimeout(() => finish(false), timeout);
    if (isServerStopped(server)) finish(true);
  });
}

async function stopServer(server) {
  if (isServerStopped(server)) return;

  server.child.kill('SIGTERM');
  if (await waitForServerStop(server, 5000)) return;

  server.child.kill('SIGKILL');
  if (!(await waitForServerStop(server, 5000))) throw new Error('Vite preview did not stop after SIGKILL.');
}

async function main() {
  requireSuccess('clear', 'Failed to clear the Storybook 10 fixture.');
  requireSuccess('build-storybook:managed', 'The managed Storybook 10 static build must succeed.');
  assertStaticBuild('storybook-static/managed');

  const managedPreview = startVitePreview('storybook-static/managed', 9013);
  try {
    await waitForServer(managedPreview, 'http://127.0.0.1:9013/index.json');

    assertCapture({
      script: 'storyfreeze:managed-static',
      directoryName: '__screenshots__/managed-static',
      expectedPaths: managedScreenshotPaths,
      extraFragments: [
        'Browser backend: playwright',
        'Runtime: managed persistent Preview with process-isolated workers',
        'Found 3 stories.',
      ],
    });
    await assertCapturesConcurrently([
      {
        script: 'storyfreeze:filter-static',
        directoryName: '__screenshots__/filter-static',
        expectedPaths: interactionScreenshotPaths,
        extraFragments: ['Found 1 stories.'],
      },
      {
        script: 'storyfreeze:shard-static',
        directoryName: '__screenshots__/shard-static',
        expectedPaths: interactionScreenshotPaths,
        extraFragments: ['Found 3 stories. 1 are being processed by this shard (number 2 of 2).'],
      },
      {
        script: 'storyfreeze:retry-static',
        directoryName: '__screenshots__/retry-static',
        expectedPaths: retryScreenshotPaths,
        extraFragments: ['Found 1 stories.', 'Retry to screenshot this story after this sequence.'],
      },
    ]);
  } finally {
    await stopServer(managedPreview);
  }

  console.log(
    'Verified Storybook 10 managed static build reuse, filtering, sharding, retry, and packaged CLI execution.',
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
