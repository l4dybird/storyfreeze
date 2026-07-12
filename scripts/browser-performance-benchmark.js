#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { pathToFileURL } = require('url');

const fixtureDir = path.resolve(process.argv[2] || '.');
const outputFile = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const sampleIntervalMs = 50;
const parallel = 4;
const measuredRuns = 3;
const warmupRuns = 1;
const expectedPngCount = 11;

function runPnpm(args) {
  const inheritedPnpmCli = process.env.npm_execpath;
  const usesInheritedCli = inheritedPnpmCli && /pnpm(?:\.cjs)?$/i.test(path.basename(inheritedPnpmCli));
  const command = usesInheritedCli ? process.execPath : process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const commandArgs = usesInheritedCli ? [inheritedPnpmCli, ...args] : args;
  execFileSync(command, commandArgs, {
    cwd: fixtureDir,
    env: {
      ...process.env,
      CI: 'true',
      FORCE_COLOR: '0',
      STORYBOOK_DISABLE_TELEMETRY: '1',
    },
    shell: process.platform === 'win32' && !usesInheritedCli,
    stdio: 'inherit',
  });
}

function readLinuxProcesses() {
  const processes = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0);
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      processes.set(pid, {
        argv,
        pid,
        ppid: Number(fields[1]),
        rssBytes: rssKiB * 1024,
        startedAt: fields[19],
      });
    } catch {
      // Processes can exit while /proc is being sampled.
    }
  }
  return processes;
}

function descendantsOf(processes, rootPid) {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes.values()) {
      if (!descendants.has(process.pid) && descendants.has(process.ppid)) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  return [...descendants].map(pid => processes.get(pid)).filter(Boolean);
}

function isChromiumProcess(process) {
  const executable = path.basename(process.argv[0] || '');
  return /(chrome|chromium)/i.test(executable) && !/crashpad/i.test(executable);
}

function isChromiumBrowserRoot(process) {
  return isChromiumProcess(process) && !process.argv.some(argument => argument.startsWith('--type='));
}

function countPngs(directory) {
  if (!fs.existsSync(directory)) return 0;
  let count = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.name.endsWith('.png')) count += 1;
    }
  }
  return count;
}

function measureCapture(iteration, warmup) {
  if (process.platform !== 'linux') throw new Error('The browser performance benchmark requires Linux /proc.');

  const outputDir = path.join(fixtureDir, '__screenshots__', warmup ? 'benchmark-warmup' : `benchmark-${iteration}`);
  fs.rmSync(outputDir, { recursive: true, force: true });
  const cli = path.join(fixtureDir, 'node_modules', 'storyfreeze', 'dist', 'node', 'cli.js');
  const args = [cli, '--verbose', '--parallel', String(parallel), '--out-dir', outputDir, 'http://127.0.0.1:9013'];

  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(process.execPath, args, {
      cwd: fixtureDir,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let peakTreeRssBytes = 0;
    let peakProcessCount = 0;
    let peakChromiumProcessCount = 0;
    let peakBrowserRootCount = 0;
    let samples = 0;
    const browserLaunches = new Set();

    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));

    const sample = () => {
      const tree = descendantsOf(readLinuxProcesses(), child.pid);
      const chromium = tree.filter(isChromiumProcess);
      const browserRoots = chromium.filter(isChromiumBrowserRoot);
      peakTreeRssBytes = Math.max(
        peakTreeRssBytes,
        tree.reduce((total, process) => total + process.rssBytes, 0),
      );
      peakProcessCount = Math.max(peakProcessCount, tree.length);
      peakChromiumProcessCount = Math.max(peakChromiumProcessCount, chromium.length);
      peakBrowserRootCount = Math.max(peakBrowserRootCount, browserRoots.length);
      browserRoots.forEach(process => browserLaunches.add(`${process.pid}:${process.startedAt}`));
      samples += 1;
    };
    sample();
    const sampler = setInterval(sample, sampleIntervalMs);

    child.once('error', error => {
      clearInterval(sampler);
      reject(error);
    });
    child.once('close', code => {
      clearInterval(sampler);
      const wallTimeMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      if (code !== 0) {
        process.stdout.write(stdout);
        process.stderr.write(stderr);
        reject(new Error(`StoryFreeze benchmark capture exited with code ${code}.`));
        return;
      }

      const pngCount = countPngs(outputDir);
      if (pngCount !== expectedPngCount) {
        reject(new Error(`Expected ${expectedPngCount} benchmark PNGs, found ${pngCount}.`));
        return;
      }
      if (peakBrowserRootCount === 0) {
        reject(new Error('The sampler did not observe a Chromium browser process.'));
        return;
      }

      const reportedCaptureMs = Number(
        stdout.match(/Screenshot was ended successfully in (\d+) msec capturing/)?.[1] || 0,
      );
      resolve({
        iteration,
        peakBrowserRootCount,
        peakChromiumProcessCount,
        peakProcessCount,
        peakTreeRssBytes,
        pngCount,
        reportedCaptureMs,
        sampleCount: samples,
        uniqueBrowserLaunchCount: browserLaunches.size,
        wallTimeMs: Math.round(wallTimeMs),
      });
    });
  });
}

function startVitePreview() {
  const vitePackagePath = require.resolve('vite/package.json', { paths: [fixtureDir] });
  const vitePackage = JSON.parse(fs.readFileSync(vitePackagePath, 'utf8'));
  const viteBin = typeof vitePackage.bin === 'string' ? vitePackage.bin : vitePackage.bin.vite;
  return spawn(
    process.execPath,
    [
      path.resolve(path.dirname(vitePackagePath), viteBin),
      'preview',
      '--outDir',
      'storybook-static/managed',
      '--host',
      '127.0.0.1',
      '--port',
      '9013',
      '--strictPort',
    ],
    { cwd: fixtureDir, env: { ...process.env, CI: 'true', FORCE_COLOR: '0' }, stdio: 'inherit' },
  );
}

async function waitForServer(server) {
  const url = 'http://127.0.0.1:9013/index.json';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('Vite preview exited before startup.');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
    } catch {
      // Retry until the deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Vite preview did not start within 30000 msec.');
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function browserMetadata() {
  const adapterUrl = pathToFileURL(
    path.join(fixtureDir, 'node_modules', 'storyfreeze', 'dist', 'node', 'puppeteer-browser-backend.js'),
  );
  const { findChrome } = await import(adapterUrl.href);
  const resolved = await findChrome({ channel: '*' });
  if (!resolved.executablePath) throw new Error('Chromium was not found for the benchmark.');
  return {
    executablePath: resolved.executablePath,
    source: resolved.type,
    version: execFileSync(resolved.executablePath, ['--version'], { encoding: 'utf8' }).trim(),
  };
}

async function main() {
  runPnpm(['run', 'clear']);
  runPnpm(['run', 'build-storybook:managed']);
  const server = startVitePreview();
  try {
    await waitForServer(server);
    for (let iteration = 1; iteration <= warmupRuns; iteration += 1) {
      await measureCapture(iteration, true);
    }

    const runs = [];
    for (let iteration = 1; iteration <= measuredRuns; iteration += 1) {
      const result = await measureCapture(iteration, false);
      runs.push(result);
      console.log(
        `Benchmark ${iteration}/${measuredRuns}: ${result.wallTimeMs} ms, ${Math.round(result.peakTreeRssBytes / 1024 / 1024)} MiB peak RSS.`,
      );
    }

    const storyfreezePackage = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, 'node_modules', 'storyfreeze', 'package.json'), 'utf8'),
    );
    const fixturePackage = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'package.json'), 'utf8'));
    const result = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      storyfreezeCommit: process.env.STORYFREEZE_BENCHMARK_COMMIT || 'unknown',
      storyfreezeVersion: storyfreezePackage.version,
      backend: 'puppeteer',
      scenario: {
        fixture: fixturePackage.name,
        storybook: fixturePackage.devDependencies.storybook,
        mode: 'managed-static',
        parallel,
        stories: 3,
        pngs: expectedPngCount,
        warmupRuns,
        measuredRuns,
        sampleIntervalMs,
      },
      environment: {
        arch: process.arch,
        cpuCount: os.cpus().length,
        cpuModel: os.cpus()[0]?.model,
        node: process.version,
        platform: process.platform,
        release: os.release(),
        runnerImage: process.env.ImageOS || 'unknown',
        runnerImageVersion: process.env.ImageVersion || 'unknown',
        totalMemoryBytes: os.totalmem(),
        chromium: await browserMetadata(),
      },
      summary: {
        medianWallTimeMs: median(runs.map(run => run.wallTimeMs)),
        medianPeakTreeRssBytes: median(runs.map(run => run.peakTreeRssBytes)),
        maxPeakTreeRssBytes: Math.max(...runs.map(run => run.peakTreeRssBytes)),
        peakBrowserRootCount: Math.max(...runs.map(run => run.peakBrowserRootCount)),
        maxChromiumProcessCount: Math.max(...runs.map(run => run.peakChromiumProcessCount)),
      },
      runs,
    };

    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, json);
    }
    console.log(`STORYFREEZE_BROWSER_BENCHMARK_RESULT=${JSON.stringify(result)}`);
  } finally {
    await stopServer(server);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
