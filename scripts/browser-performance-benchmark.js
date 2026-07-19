#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { createRequire } = require('module');
const { PNG } = require('pngjs');
const { resolvePnpmCommand } = require('./pnpm-command.js');
const { summarizeScreenshotBudget } = require('./screenshot-budget-summary.js');

const fixtureDir = path.resolve(process.argv[2] || '.');
const outputFile = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const failureArtifactDir = outputFile
  ? path.join(path.dirname(outputFile), `${path.basename(outputFile, '.json')}-failures`)
  : undefined;
const sampleIntervalMs = 50;
const processExitTimeoutMs = 2000;
const benchmarkComparison = process.env.STORYFREEZE_BENCHMARK_COMPARISON || 'isolation';
if (!['isolation', 'topology'].includes(benchmarkComparison)) {
  throw new Error(`Unsupported browser benchmark comparison: ${benchmarkComparison}`);
}
function benchmarkProfilesForComparison(comparison) {
  return comparison === 'topology'
    ? { pr: { measuredRuns: 3, warmupRuns: 1 }, record: { measuredRuns: 9, warmupRuns: 2 } }
    : { pr: { measuredRuns: 3, warmupRuns: 1 }, record: { measuredRuns: 10, warmupRuns: 2 } };
}
const benchmarkProfiles = benchmarkProfilesForComparison(benchmarkComparison);
const benchmarkProfile = process.env.STORYFREEZE_BENCHMARK_PROFILE || 'pr';
if (!Object.hasOwn(benchmarkProfiles, benchmarkProfile)) {
  throw new Error(`Unknown browser benchmark profile: ${benchmarkProfile}`);
}
const { measuredRuns, warmupRuns } = benchmarkProfiles[benchmarkProfile];
function parseParallel(value) {
  const parsed = Number(value);
  if (![1, 2, 4, 8, 16].includes(parsed)) throw new Error(`Unsupported benchmark parallel value: ${value}`);
  return parsed;
}
const parallel = parseParallel(process.env.STORYFREEZE_BENCHMARK_PARALLEL || 4);
const startingIsolation = process.env.STORYFREEZE_BENCHMARK_START_ISOLATION || 'process';
const isolations = benchmarkComparison === 'topology' ? ['process', 'hybrid', 'context'] : ['process', 'context'];
if (!isolations.includes(startingIsolation)) {
  throw new Error(`Unsupported starting isolation: ${startingIsolation}`);
}
if (process.env.STORYFREEZE_BENCHMARK_TRACE === 'true') {
  throw new Error('Browser isolation comparison does not support trace capture.');
}

function isolationExecutionOrder(iteration, values = isolations, first = startingIsolation) {
  const firstIndex = values.indexOf(first);
  if (firstIndex < 0) throw new Error(`Unknown starting isolation: ${first}`);
  const seeded = [...values.slice(firstIndex), ...values.slice(0, firstIndex)];
  const offset = (iteration - 1) % seeded.length;
  return [...seeded.slice(offset), ...seeded.slice(0, offset)];
}
const expectedStoryCount = 2;
const expectedPngCount = 9;
const benchmarkExclude = 'Compatibility/Fixture/Retry';
const captureDiagnosticPrefix = 'STORYFREEZE_CAPTURE_DIAGNOSTIC=';
const launchOptions = {
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
};
const clockTicksPerSecond =
  process.platform === 'linux' ? Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) : 0;

function runPnpm(args) {
  const invocation = resolvePnpmCommand(args);
  execFileSync(invocation.command, invocation.args, {
    cwd: fixtureDir,
    env: {
      ...process.env,
      CI: 'true',
      FORCE_COLOR: '0',
      STORYBOOK_DISABLE_TELEMETRY: '1',
    },
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

function processIdentity(process) {
  return `${process.pid}:${process.startedAt}`;
}

function findObservedProcesses(processes, observedIdentities) {
  return [...processes.values()].filter(process => observedIdentities.has(processIdentity(process)));
}

async function waitForObservedProcessesToExit(observedIdentities, timeoutMs = processExitTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = findObservedProcesses(readLinuxProcesses(), observedIdentities);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    remaining = findObservedProcesses(readLinuxProcesses(), observedIdentities);
  }
  return remaining;
}

function isChromiumProcess(process) {
  const executable = path.basename(process.argv[0] || '');
  return /(chrome|chromium)/i.test(executable) && !/crashpad/i.test(executable);
}

function isChromiumBrowserRoot(process) {
  return isChromiumProcess(process) && !process.argv.some(argument => /(?:^|\s)--type=/.test(argument));
}

function chromiumProcessType(process) {
  if (isChromiumBrowserRoot(process)) return 'browser';
  const value = process.argv.find(argument => argument.startsWith('--type='))?.slice('--type='.length);
  return ['gpu-process', 'renderer', 'utility', 'zygote'].includes(value) ? value : 'other';
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
  const captureDiagnostics = plainLog
    .split(/\r?\n/)
    .filter(line => line.startsWith(captureDiagnosticPrefix))
    .map(line => JSON.parse(line.slice(captureDiagnosticPrefix.length)));
  for (const output of captureDiagnostics.filter(event => event.type === 'capture-output')) {
    const context = captureDiagnostics.find(
      event =>
        event.type === 'capture-complete' &&
        event.requestId === output.requestId &&
        event.retryCount === output.retryCount &&
        JSON.stringify(event.variantKey) === JSON.stringify(output.variantKey),
    );
    if (context) {
      output.backend = context.backend;
      output.workerId = context.workerId;
    }
  }
  return {
    storyCount: storyCounts.at(-1) ?? 0,
    storyDurationsMs,
    retryCount: countMatches(plainLog, /Retry to screenshot this story after this sequence\./g),
    timeoutCount: countMatches(plainLog, /(?:preview did not become ready|launch timeout exceeded|TimeoutError)/gi),
    browserCrashCount: countMatches(
      plainLog,
      /(?:Target closed|Failed to launch the browser process|browser process.*crash)/gi,
    ),
    captureDiagnostics,
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
  captureTimeoutMs,
  exclude,
  expectedPngs,
  expectedStories,
  include,
  iteration,
  isolation,
  label,
  pairStartingIsolation,
  positionInPair,
  sequenceIndex,
  trace = false,
}) {
  if (process.platform !== 'linux') throw new Error('The browser performance benchmark requires Linux /proc.');

  const outputDir = path.join(fixtureDir, '__screenshots__', label);
  fs.rmSync(outputDir, { recursive: true, force: true });
  const cli = path.join(fixtureDir, 'node_modules', 'storyfreeze', 'dist', 'node', 'cli.js');
  const args = [
    cli,
    '--verbose',
    '--chromium-path',
    browser.executablePath,
    '--browser-launch-options',
    JSON.stringify(launchOptions),
    '--parallel',
    String(parallel),
    '--out-dir',
    outputDir,
    '--browser-isolation',
    isolation || 'process',
  ];
  if (captureTimeoutMs !== undefined) args.push('--capture-timeout', String(captureTimeoutMs));
  if (trace) args.push('--trace');
  if (include) args.push('--include', include);
  if (exclude) args.push('--exclude', exclude);
  args.push('http://127.0.0.1:9013');

  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(process.execPath, args, {
      cwd: fixtureDir,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0', STORYFREEZE_CAPTURE_DIAGNOSTICS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let peakTreeRssBytes = 0;
    let peakProcessCount = 0;
    let peakChromiumProcessCount = 0;
    const peakChromiumProcessCountsByType = {
      browser: 0,
      'gpu-process': 0,
      other: 0,
      renderer: 0,
      utility: 0,
      zygote: 0,
    };
    let peakBrowserRootCount = 0;
    let samples = 0;
    const browserLaunches = new Set();
    const browserExecutables = new Set();
    const observedChromiumProcesses = new Set();
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
      const chromiumProcessCountsByType = Object.fromEntries(
        Object.keys(peakChromiumProcessCountsByType).map(type => [
          type,
          chromium.filter(process => chromiumProcessType(process) === type).length,
        ]),
      );
      for (const type of Object.keys(peakChromiumProcessCountsByType)) {
        peakChromiumProcessCountsByType[type] = Math.max(
          peakChromiumProcessCountsByType[type],
          chromiumProcessCountsByType[type],
        );
      }
      for (const process of tree) {
        const key = `${process.pid}:${process.startedAt}`;
        cpuTicks.set(key, Math.max(cpuTicks.get(key) || 0, process.cpuTicks));
      }
      for (const process of browserRoots) {
        browserLaunches.add(processIdentity(process));
        browserExecutables.add(normalizeExecutable(process.argv[0]));
      }
      for (const process of chromium) observedChromiumProcesses.add(processIdentity(process));
      samples += 1;
    };
    sample();
    const sampler = setInterval(sample, sampleIntervalMs);

    child.once('error', error => {
      clearInterval(sampler);
      reject(error);
    });
    child.once('close', async (code, signal) => {
      clearInterval(sampler);
      sample();
      const wallTimeMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const pngPaths = listFiles(outputDir, '.png');
      const tracePaths = listFiles(outputDir, '_trace.json');
      const diagnostics = parseCaptureLog(`${stdout}\n${stderr}`);
      const runtimeBrowserLaunchCount = diagnostics.captureDiagnostics.filter(
        event => event.type === 'browser-launch',
      ).length;
      const topologyDiagnostic = diagnostics.captureDiagnostics.findLast(event => event.type === 'browser-topology');
      const queueSummary = diagnostics.captureDiagnostics.findLast(event => event.type === 'queue-summary');
      const topology = topologyDiagnostic
        ? (() => {
            const configuredWorkerCount = topologyDiagnostic.workerCount;
            const workerCount = queueSummary?.bootedWorkerCount ?? configuredWorkerCount;
            const workerProcessIds = Array.isArray(topologyDiagnostic.workerProcessIds)
              ? topologyDiagnostic.workerProcessIds.slice(0, workerCount)
              : [];
            return {
              browserProcessCount: workerProcessIds.length
                ? new Set(workerProcessIds).size
                : topologyDiagnostic.browserProcessCount,
              configuredBrowserProcessCount: topologyDiagnostic.browserProcessCount,
              configuredWorkerCount,
              contextsPerBrowser: topologyDiagnostic.contextsPerBrowser,
              workerCount,
            };
          })()
        : {
            browserProcessCount: isolation === 'context' ? 1 : parallel,
            contextsPerBrowser: isolation === 'context' ? parallel : 1,
            workerCount: parallel,
          };
      const browserCloseEvents = diagnostics.captureDiagnostics.filter(event => event.type === 'browser-close');
      const browserCloseErrorCount = browserCloseEvents.filter(
        event => event.browserCloseError || event.sessionCloseError,
      ).length;
      const runtimeDisposeEvents = diagnostics.captureDiagnostics.filter(
        event => event.type === 'runtime-phase' && event.phase === 'runtime-dispose' && event.state === 'end',
      );
      const remainingChromiumProcesses = await waitForObservedProcessesToExit(observedChromiumProcesses);
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
      if (diagnostics.captureDiagnostics.filter(event => event.type === 'capture-output').length !== expectedPngs) {
        errors.push(
          `Expected ${expectedPngs} capture diagnostic output mappings, found ${diagnostics.captureDiagnostics.filter(event => event.type === 'capture-output').length}.`,
        );
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
      const expectedBrowserCloseEvents = (topology.configuredWorkerCount ?? topology.workerCount) + 1;
      if (browserCloseEvents.length < expectedBrowserCloseEvents) {
        errors.push(
          `Expected at least ${expectedBrowserCloseEvents} browser close events, observed ${browserCloseEvents.length}.`,
        );
      }
      if (browserCloseErrorCount !== 0) {
        errors.push(`Observed ${browserCloseErrorCount} session or browser close error(s).`);
      }
      if (runtimeDisposeEvents.length !== 1) {
        errors.push(`Expected one completed runtime dispose event, observed ${runtimeDisposeEvents.length}.`);
      } else if (runtimeDisposeEvents[0].error) {
        errors.push(`Runtime disposal failed: ${JSON.stringify(runtimeDisposeEvents[0].error)}.`);
      }
      if (remainingChromiumProcesses.length !== 0) {
        errors.push(
          `Observed ${remainingChromiumProcesses.length} Chromium process(es) still alive after ${processExitTimeoutMs} msec: ${remainingChromiumProcesses.map(process => processIdentity(process)).join(', ')}.`,
        );
      }
      if (errors.length) writeFailureLog(label, stdout, stderr);

      resolve({
        backend,
        browserCrashCount: diagnostics.browserCrashCount + (signal ? 1 : 0),
        browserCloseErrorCount,
        browserCloseEventCount: browserCloseEvents.length,
        browserExecutables: observedExecutables,
        cpuTimeMs: Math.round(
          ([...cpuTicks.values()].reduce((total, ticks) => total + ticks, 0) / clockTicksPerSecond) * 1000,
        ),
        captureDiagnostics: diagnostics.captureDiagnostics,
        errors,
        exitCode: code,
        iteration,
        ...(isolation ? { isolation } : {}),
        label,
        outputDir,
        ...(pairStartingIsolation ? { pairStartingIsolation } : {}),
        peakBrowserRootCount,
        peakChromiumProcessCount,
        peakChromiumProcessCountsByType,
        peakProcessCount,
        peakTreeRssBytes,
        pngCount: pngPaths.length,
        pngPaths,
        positionInPair,
        retryCount: diagnostics.retryCount,
        residualChromiumProcessCount: remainingChromiumProcesses.length,
        runtimeBrowserLaunchCount,
        runtimeDisposeEventCount: runtimeDisposeEvents.length,
        sampleCount: samples,
        sequenceIndex,
        signal,
        storyCount: diagnostics.storyCount,
        storyDurationsMs: diagnostics.storyDurationsMs,
        success: errors.length === 0,
        timeoutCount: diagnostics.timeoutCount,
        topology,
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
  const diagnosticEvents = successful.flatMap(run => run.captureDiagnostics);
  const phaseNames = [
    ...new Set(
      diagnosticEvents
        .filter(event => event.type === 'capture-phase' && event.state === 'end')
        .map(event => event.phase),
    ),
  ];
  const phaseTimings = Object.fromEntries(
    phaseNames.sort().map(phase => {
      const values = diagnosticEvents
        .filter(
          event =>
            event.type === 'capture-phase' &&
            event.state === 'end' &&
            event.phase === phase &&
            typeof event.durationMs === 'number',
        )
        .map(event => event.durationMs);
      return [phase, { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), samples: values.length }];
    }),
  );
  const runtimePhaseNames = [
    ...new Set(
      diagnosticEvents
        .filter(event => event.type === 'runtime-phase' && event.state === 'end')
        .map(event => event.phase),
    ),
  ];
  const runtimePhaseTimings = Object.fromEntries(
    runtimePhaseNames.sort().map(phase => {
      const values = diagnosticEvents
        .filter(
          event =>
            event.type === 'runtime-phase' &&
            event.state === 'end' &&
            event.phase === phase &&
            typeof event.durationMs === 'number',
        )
        .map(event => event.durationMs);
      return [phase, { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), samples: values.length }];
    }),
  );
  const queueWaitTimes = diagnosticEvents
    .filter(event => event.type === 'queue-task' && event.state === 'start' && typeof event.durationMs === 'number')
    .map(event => event.durationMs);
  const queueSummaries = diagnosticEvents.filter(event => event.type === 'queue-summary');
  const queueUtilization = queueSummaries
    .map(event => event.busyWorkerUtilization)
    .filter(value => typeof value === 'number');
  const idleEvents = diagnosticEvents.filter(event => event.type === 'idle-wait');
  const visualCommitEvents = diagnosticEvents.filter(event => event.type === 'visual-commit');
  return {
    browserCrashEventCount: runs.reduce((total, run) => total + run.browserCrashCount, 0),
    browserCrashRate: runs.filter(run => run.browserCrashCount > 0).length / runs.length,
    captureFailureRate: (expectedCaptures - captured) / expectedCaptures,
    captureTimeP50Ms: percentile(storyDurationsMs, 0.5),
    captureTimeP95Ms: percentile(storyDurationsMs, 0.95),
    diagnostics: {
      idleEventCount: idleEvents.length,
      idleTimeoutEventCount: idleEvents.filter(event => event.didTimeout).length,
      idleTimeoutRate: idleEvents.length ? idleEvents.filter(event => event.didTimeout).length / idleEvents.length : 0,
      phaseTimings,
      screenshotBudget: summarizeScreenshotBudget(diagnosticEvents),
      queue: {
        busyWorkerUtilizationP50: percentile(queueUtilization, 0.5),
        busyWorkerUtilizationP95: percentile(queueUtilization, 0.95),
        peakInFlight: queueSummaries.length ? Math.max(...queueSummaries.map(event => event.peakInFlight)) : null,
        peakQueued: queueSummaries.length ? Math.max(...queueSummaries.map(event => event.peakQueued)) : null,
        waitMaxMs: queueWaitTimes.length ? Math.max(...queueWaitTimes) : null,
        waitP50Ms: percentile(queueWaitTimes, 0.5),
        waitP95Ms: percentile(queueWaitTimes, 0.95),
        waitSamples: queueWaitTimes.length,
      },
      runtimePhaseTimings,
      threeSecondTailEventCount: diagnosticEvents.filter(
        event => event.type === 'capture-output' && typeof event.durationMs === 'number' && event.durationMs >= 3000,
      ).length,
      visualCommitEventCount: visualCommitEvents.length,
      visualCommitFallbackCount: visualCommitEvents.filter(event => event.usedAnimationFrameFallback).length,
      visualCommitTimeoutCount: visualCommitEvents.filter(event => event.didTimeout).length,
    },
    maxChromiumProcessCount: Math.max(...runs.map(run => run.peakChromiumProcessCount)),
    maxChromiumProcessCountsByType: Object.fromEntries(
      Object.keys(successful[0]?.peakChromiumProcessCountsByType ?? {}).map(type => [
        type,
        Math.max(...successful.map(run => run.peakChromiumProcessCountsByType[type])),
      ]),
    ),
    maxPeakProcessCount: Math.max(...runs.map(run => run.peakProcessCount)),
    maxUniqueBrowserLaunchCount: Math.max(...runs.map(run => run.uniqueBrowserLaunchCount)),
    maxRuntimeBrowserLaunchCount: Math.max(...runs.map(run => run.runtimeBrowserLaunchCount)),
    maxResidualChromiumProcessCount: Math.max(...runs.map(run => run.residualChromiumProcessCount ?? 0)),
    maxPeakTreeRssBytes: Math.max(...runs.map(run => run.peakTreeRssBytes)),
    medianCpuTimeMs: median(successful.map(run => run.cpuTimeMs)),
    medianPeakTreeRssBytes: median(successful.map(run => run.peakTreeRssBytes)),
    medianWallTimeMs: median(successful.map(run => run.wallTimeMs)),
    peakBrowserRootCount: Math.max(...runs.map(run => run.peakBrowserRootCount)),
    retryRate: runs.reduce((total, run) => total + run.retryCount, 0) / expectedCaptures,
    sessionOrBrowserCloseErrorCount: runs.reduce((total, run) => total + (run.browserCloseErrorCount ?? 0), 0),
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

async function runIsolationComparison(browser) {
  const warmups = Object.fromEntries(isolations.map(isolation => [isolation, []]));
  const warmupExecutionOrder = [];
  let warmupSequenceIndex = 0;
  for (let iteration = 1; iteration <= warmupRuns; iteration += 1) {
    const order = isolationExecutionOrder(iteration);
    for (const [positionInPair, isolation] of order.entries()) {
      const run = await measureCapture({
        backend: 'playwright',
        browser,
        exclude: benchmarkExclude,
        expectedPngs: expectedPngCount,
        expectedStories: expectedStoryCount,
        isolation,
        iteration,
        label: `benchmark-isolation-${isolation}-warmup-${iteration}`,
        pairStartingIsolation: order[0],
        positionInPair,
        sequenceIndex: ++warmupSequenceIndex,
      });
      warmups[isolation].push(run);
      warmupExecutionOrder.push(run);
    }
  }

  const runs = Object.fromEntries(isolations.map(isolation => [isolation, []]));
  const measuredExecutionOrder = [];
  let measuredSequenceIndex = 0;
  for (let iteration = 1; iteration <= measuredRuns; iteration += 1) {
    const order = isolationExecutionOrder(iteration);
    for (const [positionInPair, isolation] of order.entries()) {
      const run = await measureCapture({
        backend: 'playwright',
        browser,
        exclude: benchmarkExclude,
        expectedPngs: expectedPngCount,
        expectedStories: expectedStoryCount,
        isolation,
        iteration,
        label: `benchmark-isolation-${isolation}-${iteration}`,
        pairStartingIsolation: order[0],
        positionInPair,
        sequenceIndex: ++measuredSequenceIndex,
      });
      runs[isolation].push(run);
      measuredExecutionOrder.push(run);
      console.log(
        `${isolation} isolation ${iteration}/${measuredRuns}: ${run.wallTimeMs} ms, ${Math.round(run.peakTreeRssBytes / 1024 / 1024)} MiB peak RSS.`,
      );
    }
  }

  const pixelComparisons = [];
  for (let index = 0; index < measuredRuns; index += 1) {
    for (const isolation of isolations.filter(value => value !== 'process')) {
      pixelComparisons.push(
        compareDirectories(
          `${isolation}-to-process-run-${index + 1}`,
          runs.process[index].outputDir,
          runs[isolation][index].outputDir,
        ),
      );
    }
  }
  for (const isolation of isolations) {
    for (let index = 1; index < measuredRuns; index += 1) {
      pixelComparisons.push(
        compareDirectories(
          `${isolation}-stability-${index + 1}`,
          runs[isolation][0].outputDir,
          runs[isolation][index].outputDir,
        ),
      );
    }
  }

  const summaries = Object.fromEntries(isolations.map(isolation => [isolation, summarizeRuns(runs[isolation])]));
  const gateErrors = [];
  for (const isolation of isolations) {
    for (const run of warmups[isolation]) run.errors.forEach(error => gateErrors.push(`${run.label}: ${error}`));
    for (const run of runs[isolation]) run.errors.forEach(error => gateErrors.push(`${run.label}: ${error}`));
  }
  for (const comparison of pixelComparisons) {
    if (comparison.mismatchCount !== 0)
      gateErrors.push(`${comparison.label}: ${comparison.mismatchCount} PNG mismatch(es).`);
  }
  for (const isolation of isolations) {
    for (const run of [...warmups[isolation], ...runs[isolation]]) {
      if (run.peakBrowserRootCount < run.topology.browserProcessCount) {
        gateErrors.push(
          `${run.label}: expected at least ${run.topology.browserProcessCount} simultaneous sampled browser roots, observed ${run.peakBrowserRootCount}.`,
        );
      }
      if (run.runtimeBrowserLaunchCount !== run.topology.browserProcessCount) {
        gateErrors.push(
          `${run.label}: expected ${run.topology.browserProcessCount} runtime browser launches, observed ${run.runtimeBrowserLaunchCount}.`,
        );
      }
    }
  }
  if (parallel > 1 && summaries.context.peakBrowserRootCount >= summaries.process.peakBrowserRootCount) {
    gateErrors.push(
      `Context isolation browser root peak (${summaries.context.peakBrowserRootCount}) was not lower than process isolation (${summaries.process.peakBrowserRootCount}).`,
    );
  }
  if (parallel > 1 && summaries.context.maxChromiumProcessCount >= summaries.process.maxChromiumProcessCount) {
    gateErrors.push(
      `Context isolation Chromium process peak (${summaries.context.maxChromiumProcessCount}) was not lower than process isolation (${summaries.process.maxChromiumProcessCount}).`,
    );
  }

  const storyfreezePackage = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, 'node_modules', 'storyfreeze', 'package.json'), 'utf8'),
  );
  const fixturePackage = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'package.json'), 'utf8'));
  const result = {
    schemaVersion: benchmarkComparison === 'topology' ? 2 : 1,
    kind: benchmarkComparison === 'topology' ? 'browser-topology-differential' : 'browser-isolation-differential',
    recordedAt: new Date().toISOString(),
    githubActions: {
      repository: process.env.GITHUB_REPOSITORY || 'unknown',
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || 'unknown',
      runId: process.env.GITHUB_RUN_ID || 'unknown',
      workflowRef: process.env.GITHUB_WORKFLOW_REF || 'unknown',
      workflowSha: process.env.GITHUB_WORKFLOW_SHA || 'unknown',
    },
    storyfreezeCommit: process.env.STORYFREEZE_BENCHMARK_COMMIT || 'unknown',
    storyfreezeTree: process.env.STORYFREEZE_BENCHMARK_TREE || 'unknown',
    storyfreezeVersion: storyfreezePackage.version,
    provisioning: process.env.STORYFREEZE_BROWSER_PROVISIONING || 'explicit-install',
    scenario: {
      fixture: fixturePackage.name,
      exclude: benchmarkExclude,
      launchOptions,
      backend: 'playwright',
      benchmarkProfile,
      includeTrace: false,
      measuredRuns,
      mode: 'managed-static',
      parallel,
      pngs: expectedPngCount,
      processExitTimeoutMs,
      sampleIntervalMs,
      startingIsolation,
      stories: expectedStoryCount,
      storybook: fixturePackage.devDependencies.storybook,
      trace: null,
      warmupRuns,
      warmupExecutionOrder: warmupExecutionOrder.map(run => run.label),
      measuredExecutionOrder: measuredExecutionOrder.map(run => run.label),
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
    ...(benchmarkComparison === 'topology'
      ? {
          topologies: Object.fromEntries(
            isolations.map(isolation => [
              isolation,
              {
                warmups: warmups[isolation].map(publicRun),
                runs: runs[isolation].map(publicRun),
                summary: summaries[isolation],
              },
            ]),
          ),
          topologyDifferential: {
            pixelComparisons,
            ratios: Object.fromEntries(
              isolations
                .filter(isolation => isolation !== 'process')
                .map(isolation => [
                  isolation,
                  {
                    captureTimeP95: ratio(summaries[isolation].captureTimeP95Ms, summaries.process.captureTimeP95Ms),
                    cpuTime: ratio(summaries[isolation].medianCpuTimeMs, summaries.process.medianCpuTimeMs),
                    peakTreeRss: ratio(
                      summaries[isolation].medianPeakTreeRssBytes,
                      summaries.process.medianPeakTreeRssBytes,
                    ),
                    wallTime: ratio(summaries[isolation].medianWallTimeMs, summaries.process.medianWallTimeMs),
                  },
                ]),
            ),
          },
        }
      : {
          isolations: Object.fromEntries(
            isolations.map(isolation => [
              isolation,
              {
                warmups: warmups[isolation].map(publicRun),
                runs: runs[isolation].map(publicRun),
                summary: summaries[isolation],
              },
            ]),
          ),
          isolationDifferential: {
            pixelComparisons,
            ratios: {
              captureTimeP95: ratio(summaries.context.captureTimeP95Ms, summaries.process.captureTimeP95Ms),
              cpuTime: ratio(summaries.context.medianCpuTimeMs, summaries.process.medianCpuTimeMs),
              peakTreeRss: ratio(summaries.context.medianPeakTreeRssBytes, summaries.process.medianPeakTreeRssBytes),
              wallTime: ratio(summaries.context.medianWallTimeMs, summaries.process.medianWallTimeMs),
            },
          },
        }),
    gate: { errors: gateErrors, passed: gateErrors.length === 0 },
  };

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputFile) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, json);
  }
  console.log(`STORYFREEZE_BROWSER_BENCHMARK_RESULT=${JSON.stringify(result)}`);
  if (gateErrors.length)
    throw new Error(`Browser ${benchmarkComparison} differential gate failed:\n- ${gateErrors.join('\n- ')}`);
}

async function main() {
  runPnpm(['run', 'clear']);
  runPnpm(['run', 'build-storybook:managed']);
  const browser = browserMetadata();
  const server = startVitePreview();
  try {
    await waitForServer(server);
    await runIsolationComparison(browser);
  } finally {
    await stopServer(server);
  }
}

if (require.main === module) {
  main().catch(error => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    if (outputFile && !fs.existsSync(outputFile)) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(
        outputFile,
        `${JSON.stringify(
          {
            schemaVersion: benchmarkComparison === 'topology' ? 2 : 1,
            kind:
              benchmarkComparison === 'topology' ? 'browser-topology-differential' : 'browser-isolation-differential',
            storyfreezeCommit: process.env.STORYFREEZE_BENCHMARK_COMMIT || 'unknown',
            storyfreezeTree: process.env.STORYFREEZE_BENCHMARK_TREE || 'unknown',
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
}

module.exports = {
  benchmarkProfilesForComparison,
  chromiumProcessType,
  findObservedProcesses,
  isolationExecutionOrder,
  parseParallel,
  processIdentity,
  summarizeRuns,
};
