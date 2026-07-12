#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { createRequire } = require('module');
const { PNG } = require('pngjs');

const fixtureDir = path.resolve(process.argv[2] || '.');
const outputFile = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const failureArtifactDir = outputFile
  ? path.join(path.dirname(outputFile), `${path.basename(outputFile, '.json')}-failures`)
  : undefined;
const sampleIntervalMs = 50;
const parallel = 4;
const measuredRuns = 3;
const warmupRuns = 1;
const expectedStoryCount = 2;
const expectedPngCount = 9;
const benchmarkExclude = 'Compatibility/Fixture/Retry';
const traceStoryCount = 1;
const tracePngCount = 2;
const traceInclude = 'Compatibility/Fixture/Console Error';
const backends = ['puppeteer', 'playwright'];
const launchOptions = {
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
};
const clockTicksPerSecond =
  process.platform === 'linux' ? Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) : 0;

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
        cpuTicks: Number(fields[11]) + Number(fields[12]),
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
  return isChromiumProcess(process) && !process.argv.some(argument => /(?:^|\s)--type=/.test(argument));
}

function normalizeExecutable(executable) {
  if (!executable) return '';
  try {
    return fs.realpathSync(executable);
  } catch {
    return path.resolve(executable);
  }
}

function listFiles(directory, extension) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.name.endsWith(extension)) files.push(path.relative(directory, entryPath).replaceAll('\\', '/'));
    }
  }
  return files.sort();
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
}

function median(values) {
  return percentile(values, 0.5);
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function parseCaptureLog(log) {
  const plainLog = log.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
  const storyCounts = [...plainLog.matchAll(/Found (\d+) stories\./g)].map(match => Number(match[1]));
  const storyDurationsMs = [...plainLog.matchAll(/Screenshot stored: .*? in (\d+) msec\./g)].map(match =>
    Number(match[1]),
  );
  return {
    storyCount: storyCounts.at(-1) ?? 0,
    storyDurationsMs,
    retryCount: countMatches(plainLog, /Retry to screenshot this story after this sequence\./g),
    timeoutCount: countMatches(plainLog, /(?:preview did not become ready|launch timeout exceeded|TimeoutError)/gi),
    browserCrashCount: countMatches(
      plainLog,
      /(?:Target closed|Failed to launch the browser process|browser process.*crash)/gi,
    ),
  };
}

function writeFailureLog(name, stdout, stderr) {
  if (!failureArtifactDir) return;
  fs.mkdirSync(failureArtifactDir, { recursive: true });
  fs.writeFileSync(path.join(failureArtifactDir, `${name}.log`), `${stdout}\n${stderr}`);
}

function copyFailureFile(category, label, relativePath, source) {
  if (!failureArtifactDir || !fs.existsSync(source)) return;
  const destination = path.join(failureArtifactDir, category, label, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function measureCapture({
  backend,
  browser,
  exclude,
  expectedPngs,
  expectedStories,
  include,
  iteration,
  label,
  trace = false,
}) {
  if (process.platform !== 'linux') throw new Error('The browser performance benchmark requires Linux /proc.');

  const outputDir = path.join(fixtureDir, '__screenshots__', label);
  fs.rmSync(outputDir, { recursive: true, force: true });
  const cli = path.join(fixtureDir, 'node_modules', 'storyfreeze', 'dist', 'node', 'cli.js');
  const args = [
    cli,
    '--verbose',
    '--browser-backend',
    backend,
    '--chromium-path',
    browser.executablePath,
    '--browser-launch-options',
    JSON.stringify(launchOptions),
    '--parallel',
    String(parallel),
    '--out-dir',
    outputDir,
  ];
  if (trace) args.push('--trace');
  if (include) args.push('--include', include);
  if (exclude) args.push('--exclude', exclude);
  args.push('http://127.0.0.1:9013');

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
    const browserExecutables = new Set();
    const cpuTicks = new Map();

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
      for (const process of tree) {
        const key = `${process.pid}:${process.startedAt}`;
        cpuTicks.set(key, Math.max(cpuTicks.get(key) || 0, process.cpuTicks));
      }
      for (const process of browserRoots) {
        browserLaunches.add(`${process.pid}:${process.startedAt}`);
        browserExecutables.add(normalizeExecutable(process.argv[0]));
      }
      samples += 1;
    };
    sample();
    const sampler = setInterval(sample, sampleIntervalMs);

    child.once('error', error => {
      clearInterval(sampler);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearInterval(sampler);
      sample();
      const wallTimeMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const pngPaths = listFiles(outputDir, '.png');
      const tracePaths = listFiles(outputDir, '_trace.json');
      const diagnostics = parseCaptureLog(`${stdout}\n${stderr}`);
      const observedExecutables = [...browserExecutables].sort();
      const errors = [];
      if (code !== 0) errors.push(`CLI exited with code ${code}${signal ? ` (${signal})` : ''}.`);
      if (diagnostics.storyCount !== expectedStories) {
        errors.push(`Expected ${expectedStories} stories, observed ${diagnostics.storyCount}.`);
      }
      if (pngPaths.length !== expectedPngs) errors.push(`Expected ${expectedPngs} PNGs, found ${pngPaths.length}.`);
      if (diagnostics.storyDurationsMs.length !== expectedPngs) {
        errors.push(`Expected ${expectedPngs} capture-request timings, found ${diagnostics.storyDurationsMs.length}.`);
      }
      if (trace && tracePaths.length !== expectedPngs) {
        errors.push(`Expected ${expectedPngs} trace files, found ${tracePaths.length}.`);
      }
      if (peakBrowserRootCount === 0) errors.push('The sampler did not observe a Chromium browser process.');
      if (observedExecutables.some(executable => executable !== browser.realpath)) {
        errors.push(`Observed a different Chromium executable: ${observedExecutables.join(', ')}`);
      }
      if (diagnostics.retryCount !== 0) errors.push(`Observed ${diagnostics.retryCount} capture retry event(s).`);
      if (diagnostics.timeoutCount !== 0) errors.push(`Observed ${diagnostics.timeoutCount} timeout event(s).`);
      if (diagnostics.browserCrashCount !== 0 || signal) {
        errors.push(`Observed ${diagnostics.browserCrashCount + (signal ? 1 : 0)} browser crash event(s).`);
      }
      if (errors.length) writeFailureLog(label, stdout, stderr);

      resolve({
        backend,
        browserCrashCount: diagnostics.browserCrashCount + (signal ? 1 : 0),
        browserExecutables: observedExecutables,
        cpuTimeMs: Math.round(
          ([...cpuTicks.values()].reduce((total, ticks) => total + ticks, 0) / clockTicksPerSecond) * 1000,
        ),
        errors,
        exitCode: code,
        iteration,
        label,
        outputDir,
        peakBrowserRootCount,
        peakChromiumProcessCount,
        peakProcessCount,
        peakTreeRssBytes,
        pngCount: pngPaths.length,
        pngPaths,
        retryCount: diagnostics.retryCount,
        sampleCount: samples,
        signal,
        storyCount: diagnostics.storyCount,
        storyDurationsMs: diagnostics.storyDurationsMs,
        success: errors.length === 0,
        timeoutCount: diagnostics.timeoutCount,
        trace,
        traceCount: tracePaths.length,
        tracePaths,
        uniqueBrowserLaunchCount: browserLaunches.size,
        wallTimeMs: Math.round(wallTimeMs),
      });
    });
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function comparePng(expectedFile, actualFile) {
  if (sha256(expectedFile) === sha256(actualFile)) {
    return { byteIdentical: true, classification: null, differentPixels: 0, maxChannelDelta: 0 };
  }
  const expected = PNG.sync.read(fs.readFileSync(expectedFile));
  const actual = PNG.sync.read(fs.readFileSync(actualFile));
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      actualDimensions: [actual.width, actual.height],
      byteIdentical: false,
      classification: 'REGRESSION_LAYOUT',
      differentPixels: null,
      expectedDimensions: [expected.width, expected.height],
      maxChannelDelta: null,
    };
  }
  let differentPixels = 0;
  let maxChannelDelta = 0;
  for (let index = 0; index < expected.data.length; index += 4) {
    let pixelDiffers = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(expected.data[index + channel] - actual.data[index + channel]);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      pixelDiffers ||= delta !== 0;
    }
    if (pixelDiffers) differentPixels += 1;
  }
  return {
    byteIdentical: false,
    classification: differentPixels === 0 ? null : 'UNKNOWN',
    differentPixels,
    differentPixelRatio: differentPixels / (expected.width * expected.height),
    dimensions: [expected.width, expected.height],
    maxChannelDelta,
  };
}

function copyMismatch(label, relativePath, expectedFile, actualFile) {
  if (!failureArtifactDir) return;
  for (const [side, source] of [
    ['expected', expectedFile],
    ['actual', actualFile],
  ]) {
    const destination = path.join(failureArtifactDir, 'pixels', label, side, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function compareDirectories(label, expectedDirectory, actualDirectory) {
  const expectedPaths = listFiles(expectedDirectory, '.png');
  const actualPaths = listFiles(actualDirectory, '.png');
  const allPaths = [...new Set([...expectedPaths, ...actualPaths])].sort();
  const mismatches = [];
  let byteMismatchCount = 0;
  let differentPixels = 0;

  for (const relativePath of allPaths) {
    const expectedFile = path.join(expectedDirectory, relativePath);
    const actualFile = path.join(actualDirectory, relativePath);
    if (!fs.existsSync(expectedFile) || !fs.existsSync(actualFile)) {
      mismatches.push({
        actualExists: fs.existsSync(actualFile),
        classification: 'REGRESSION_OPTION_MAPPING',
        expectedExists: fs.existsSync(expectedFile),
        path: relativePath,
      });
      continue;
    }
    let comparison;
    try {
      comparison = comparePng(expectedFile, actualFile);
    } catch (error) {
      comparison = {
        byteIdentical: false,
        classification: 'UNKNOWN',
        decodeError: error instanceof Error ? error.message : String(error),
        differentPixels: null,
        maxChannelDelta: null,
      };
    }
    if (!comparison.byteIdentical) byteMismatchCount += 1;
    if (comparison.differentPixels) differentPixels += comparison.differentPixels;
    if (comparison.classification) {
      mismatches.push({ path: relativePath, ...comparison });
      copyMismatch(label, relativePath, expectedFile, actualFile);
    }
  }

  return {
    actualPngCount: actualPaths.length,
    byteMismatchCount,
    differentPixels,
    expectedPngCount: expectedPaths.length,
    label,
    mismatchCount: mismatches.length,
    mismatches,
  };
}

function analyzeTraceDirectory(run) {
  const errors = [];
  let bytes = 0;
  let cpuProfileEventCount = 0;
  let eventCount = 0;
  let timelineEventCount = 0;
  const categories = new Set();
  const files = [];

  for (const relativePath of run.tracePaths) {
    const traceFile = path.join(run.outputDir, relativePath);
    try {
      const content = fs.readFileSync(traceFile);
      bytes += content.length;
      const trace = JSON.parse(content.toString('utf8'));
      if (!Array.isArray(trace.traceEvents) || trace.traceEvents.length === 0) {
        errors.push(`${relativePath} has no traceEvents.`);
        files.push({ bytes: content.length, errors: ['No traceEvents.'], path: relativePath });
        copyFailureFile('traces', run.label, relativePath, traceFile);
        continue;
      }
      let fileCpuProfileEventCount = 0;
      let fileTimelineEventCount = 0;
      const fileCategories = new Set();
      for (const event of trace.traceEvents) {
        const eventCategories = typeof event.cat === 'string' ? event.cat.split(',') : [];
        eventCategories.filter(Boolean).forEach(category => {
          categories.add(category);
          fileCategories.add(category);
        });
        if (eventCategories.some(category => category.includes('devtools.timeline'))) fileTimelineEventCount += 1;
        if (
          eventCategories.some(category => category.includes('v8.cpu_profiler')) ||
          /^(?:Profile|ProfileChunk)$/.test(event.name)
        ) {
          fileCpuProfileEventCount += 1;
        }
      }
      const fileErrors = [];
      if (fileTimelineEventCount === 0) fileErrors.push('No timeline trace events.');
      if (fileCpuProfileEventCount === 0) fileErrors.push('No CPU profile trace events.');
      fileErrors.forEach(error => errors.push(`${relativePath}: ${error}`));
      if (fileErrors.length) copyFailureFile('traces', run.label, relativePath, traceFile);
      cpuProfileEventCount += fileCpuProfileEventCount;
      eventCount += trace.traceEvents.length;
      timelineEventCount += fileTimelineEventCount;
      files.push({
        bytes: content.length,
        categories: [...fileCategories].sort(),
        cpuProfileEventCount: fileCpuProfileEventCount,
        errors: fileErrors,
        eventCount: trace.traceEvents.length,
        path: relativePath,
        timelineEventCount: fileTimelineEventCount,
      });
    } catch (error) {
      errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      files.push({
        errors: [error instanceof Error ? error.message : String(error)],
        path: relativePath,
      });
      copyFailureFile('traces', run.label, relativePath, traceFile);
    }
  }
  if (run.tracePaths.length !== tracePngCount) errors.push(`Expected ${tracePngCount} trace files.`);
  return {
    bytes,
    categories: [...categories].sort(),
    cpuProfileEventCount,
    errors,
    eventCount,
    files,
    timelineEventCount,
    traceCount: run.tracePaths.length,
    valid: errors.length === 0,
  };
}

function summarizeRuns(runs) {
  const successful = runs.filter(run => run.success);
  const storyDurationsMs = successful.flatMap(run => run.storyDurationsMs);
  const expectedCaptures = expectedPngCount * runs.length;
  const captured = runs.reduce((total, run) => total + Math.min(expectedPngCount, run.pngCount), 0);
  return {
    browserCrashEventCount: runs.reduce((total, run) => total + run.browserCrashCount, 0),
    browserCrashRate: runs.filter(run => run.browserCrashCount > 0).length / runs.length,
    captureFailureRate: (expectedCaptures - captured) / expectedCaptures,
    captureTimeP50Ms: percentile(storyDurationsMs, 0.5),
    captureTimeP95Ms: percentile(storyDurationsMs, 0.95),
    maxChromiumProcessCount: Math.max(...runs.map(run => run.peakChromiumProcessCount)),
    maxPeakTreeRssBytes: Math.max(...runs.map(run => run.peakTreeRssBytes)),
    medianCpuTimeMs: median(successful.map(run => run.cpuTimeMs)),
    medianPeakTreeRssBytes: median(successful.map(run => run.peakTreeRssBytes)),
    medianWallTimeMs: median(successful.map(run => run.wallTimeMs)),
    peakBrowserRootCount: Math.max(...runs.map(run => run.peakBrowserRootCount)),
    retryRate: runs.reduce((total, run) => total + run.retryCount, 0) / expectedCaptures,
    runSuccessRate: successful.length / runs.length,
    successfulRuns: successful.length,
    timeoutRate: runs.reduce((total, run) => total + run.timeoutCount, 0) / expectedCaptures,
    totalRuns: runs.length,
    wallTimeP50Ms: percentile(
      successful.map(run => run.wallTimeMs),
      0.5,
    ),
    wallTimeP95Ms: percentile(
      successful.map(run => run.wallTimeMs),
      0.95,
    ),
  };
}

function ratio(numerator, denominator) {
  return typeof numerator === 'number' && typeof denominator === 'number' && denominator !== 0
    ? numerator / denominator
    : null;
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

function browserMetadata() {
  const storyfreezePackagePath = path.join(fixtureDir, 'node_modules', 'storyfreeze', 'package.json');
  const requireFromStoryfreeze = createRequire(fs.realpathSync(storyfreezePackagePath));
  const playwrightPackagePath = requireFromStoryfreeze.resolve('playwright-core/package.json');
  const playwrightPackage = JSON.parse(fs.readFileSync(playwrightPackagePath, 'utf8'));
  const browserRegistry = JSON.parse(
    fs.readFileSync(path.join(path.dirname(playwrightPackagePath), 'browsers.json'), 'utf8'),
  );
  const chromium = requireFromStoryfreeze('playwright-core').chromium;
  const executablePath = chromium.executablePath();
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Playwright Chromium ${executablePath} is not installed for the benchmark.`);
  }
  return {
    executablePath,
    playwrightCore: playwrightPackage.version,
    realpath: normalizeExecutable(executablePath),
    revision: browserRegistry.browsers.find(browser => browser.name === 'chromium')?.revision,
    version: execFileSync(executablePath, ['--version'], { encoding: 'utf8' }).trim(),
  };
}

function publicRun(run) {
  const { outputDir: _, ...record } = run;
  return record;
}

async function main() {
  runPnpm(['run', 'clear']);
  runPnpm(['run', 'build-storybook:managed']);
  const browser = browserMetadata();
  const server = startVitePreview();
  try {
    await waitForServer(server);
    const warmups = { playwright: [], puppeteer: [] };
    for (const backend of backends) {
      for (let iteration = 1; iteration <= warmupRuns; iteration += 1) {
        warmups[backend].push(
          await measureCapture({
            backend,
            browser,
            exclude: benchmarkExclude,
            expectedPngs: expectedPngCount,
            expectedStories: expectedStoryCount,
            iteration,
            label: `benchmark-${backend}-warmup`,
          }),
        );
      }
    }

    const runs = { playwright: [], puppeteer: [] };
    for (let iteration = 1; iteration <= measuredRuns; iteration += 1) {
      const order = iteration % 2 === 1 ? backends : [...backends].reverse();
      for (const backend of order) {
        const run = await measureCapture({
          backend,
          browser,
          exclude: benchmarkExclude,
          expectedPngs: expectedPngCount,
          expectedStories: expectedStoryCount,
          iteration,
          label: `benchmark-${backend}-${iteration}`,
        });
        runs[backend].push(run);
        console.log(
          `${backend} ${iteration}/${measuredRuns}: ${run.wallTimeMs} ms, ${Math.round(run.peakTreeRssBytes / 1024 / 1024)} MiB peak RSS.`,
        );
      }
    }

    const traceControls = {};
    const traceRuns = {};
    for (const backend of backends) {
      traceControls[backend] = await measureCapture({
        backend,
        browser,
        expectedPngs: tracePngCount,
        expectedStories: traceStoryCount,
        include: traceInclude,
        iteration: 1,
        label: `benchmark-${backend}-trace-control`,
        trace: false,
      });
      traceRuns[backend] = await measureCapture({
        backend,
        browser,
        expectedPngs: tracePngCount,
        expectedStories: traceStoryCount,
        include: traceInclude,
        iteration: 1,
        label: `benchmark-${backend}-trace`,
        trace: true,
      });
    }

    const pixelComparisons = [];
    for (let index = 0; index < measuredRuns; index += 1) {
      pixelComparisons.push(
        compareDirectories(
          `driver-run-${index + 1}`,
          runs.puppeteer[index].outputDir,
          runs.playwright[index].outputDir,
        ),
      );
    }
    for (const backend of backends) {
      for (let index = 1; index < measuredRuns; index += 1) {
        pixelComparisons.push(
          compareDirectories(
            `${backend}-stability-${index + 1}`,
            runs[backend][0].outputDir,
            runs[backend][index].outputDir,
          ),
        );
      }
    }
    pixelComparisons.push(
      compareDirectories('driver-trace', traceRuns.puppeteer.outputDir, traceRuns.playwright.outputDir),
    );

    const summaries = {
      playwright: summarizeRuns(runs.playwright),
      puppeteer: summarizeRuns(runs.puppeteer),
    };
    const traces = {
      playwright: analyzeTraceDirectory(traceRuns.playwright),
      puppeteer: analyzeTraceDirectory(traceRuns.puppeteer),
    };
    const gateErrors = [];
    for (const backend of backends) {
      for (const run of warmups[backend]) run.errors.forEach(error => gateErrors.push(`${run.label}: ${error}`));
      for (const run of runs[backend]) run.errors.forEach(error => gateErrors.push(`${run.label}: ${error}`));
      traceControls[backend].errors.forEach(error => gateErrors.push(`${traceControls[backend].label}: ${error}`));
      traceRuns[backend].errors.forEach(error => gateErrors.push(`${traceRuns[backend].label}: ${error}`));
      traces[backend].errors.forEach(error => gateErrors.push(`${backend} trace: ${error}`));
    }
    const tracePathSets = backends.map(backend => traceRuns[backend].tracePaths.join('\n'));
    if (tracePathSets[0] !== tracePathSets[1]) gateErrors.push('Trace output paths differ between browser backends.');
    for (const comparison of pixelComparisons) {
      if (comparison.mismatchCount !== 0)
        gateErrors.push(`${comparison.label}: ${comparison.mismatchCount} PNG mismatch(es).`);
    }

    const storyfreezePackage = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, 'node_modules', 'storyfreeze', 'package.json'), 'utf8'),
    );
    const fixturePackage = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'package.json'), 'utf8'));
    const result = {
      schemaVersion: 2,
      recordedAt: new Date().toISOString(),
      storyfreezeCommit: process.env.STORYFREEZE_BENCHMARK_COMMIT || 'unknown',
      storyfreezeVersion: storyfreezePackage.version,
      provisioning: process.env.STORYFREEZE_BROWSER_PROVISIONING || 'explicit-install',
      scenario: {
        fixture: fixturePackage.name,
        exclude: benchmarkExclude,
        launchOptions,
        measuredRuns,
        mode: 'managed-static',
        parallel,
        pngs: expectedPngCount,
        sampleIntervalMs,
        stories: expectedStoryCount,
        storybook: fixturePackage.devDependencies.storybook,
        trace: { include: traceInclude, pngs: tracePngCount, runs: 1, stories: traceStoryCount },
        warmupRuns,
      },
      environment: {
        arch: process.arch,
        browser,
        cpuCount: os.cpus().length,
        cpuModel: os.cpus()[0]?.model,
        node: process.version,
        platform: process.platform,
        release: os.release(),
        runnerImage: process.env.ImageOS || 'unknown',
        runnerImageVersion: process.env.ImageVersion || 'unknown',
        totalMemoryBytes: os.totalmem(),
      },
      backends: {
        playwright: {
          warmups: warmups.playwright.map(publicRun),
          runs: runs.playwright.map(publicRun),
          summary: summaries.playwright,
          traceControl: publicRun(traceControls.playwright),
          traceRun: publicRun(traceRuns.playwright),
          traceSummary: traces.playwright,
          traceOverhead: {
            cpuTime: ratio(traceRuns.playwright.cpuTimeMs, traceControls.playwright.cpuTimeMs),
            peakTreeRss: ratio(traceRuns.playwright.peakTreeRssBytes, traceControls.playwright.peakTreeRssBytes),
            wallTime: ratio(traceRuns.playwright.wallTimeMs, traceControls.playwright.wallTimeMs),
          },
        },
        puppeteer: {
          warmups: warmups.puppeteer.map(publicRun),
          runs: runs.puppeteer.map(publicRun),
          summary: summaries.puppeteer,
          traceControl: publicRun(traceControls.puppeteer),
          traceRun: publicRun(traceRuns.puppeteer),
          traceSummary: traces.puppeteer,
          traceOverhead: {
            cpuTime: ratio(traceRuns.puppeteer.cpuTimeMs, traceControls.puppeteer.cpuTimeMs),
            peakTreeRss: ratio(traceRuns.puppeteer.peakTreeRssBytes, traceControls.puppeteer.peakTreeRssBytes),
            wallTime: ratio(traceRuns.puppeteer.wallTimeMs, traceControls.puppeteer.wallTimeMs),
          },
        },
      },
      differential: {
        pixelComparisons,
        ratios: {
          cpuTime: ratio(summaries.playwright.medianCpuTimeMs, summaries.puppeteer.medianCpuTimeMs),
          peakTreeRss: ratio(summaries.playwright.medianPeakTreeRssBytes, summaries.puppeteer.medianPeakTreeRssBytes),
          wallTime: ratio(summaries.playwright.medianWallTimeMs, summaries.puppeteer.medianWallTimeMs),
        },
      },
      gate: { errors: gateErrors, passed: gateErrors.length === 0 },
    };

    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, json);
    }
    console.log(`STORYFREEZE_BROWSER_BENCHMARK_RESULT=${JSON.stringify(result)}`);
    if (gateErrors.length) throw new Error(`Browser differential gate failed:\n- ${gateErrors.join('\n- ')}`);
  } finally {
    await stopServer(server);
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  if (outputFile && !fs.existsSync(outputFile)) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(
      outputFile,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          recordedAt: new Date().toISOString(),
          fatalError: message,
          gate: { errors: [message], passed: false },
        },
        null,
        2,
      )}\n`,
    );
  }
  writeFailureLog('fatal', '', message);
  console.error(error);
  process.exitCode = 1;
});
