#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createRequire } = require('module');
const { PNG } = require('pngjs');
const { resolvePnpmCommand } = require('./pnpm-command.js');
const { selectScenarios } = require('./performance-roadmap-scenarios.js');
const { summarizeScreenshotBudget } = require('./screenshot-budget-summary.js');

const diagnosticPrefix = 'STORYFREEZE_CAPTURE_DIAGNOSTIC=';
const fixtureDir = path.resolve(process.argv[2] || '.');
const outputFile = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const profileDefinitions = {
  smoke: { measuredRuns: 1, warmupRuns: 0 },
  pr: { measuredRuns: 3, warmupRuns: 1 },
  record: { measuredRuns: 9, warmupRuns: 2 },
};
const benchmarkProfile = process.env.STORYFREEZE_ROADMAP_BENCHMARK_PROFILE || 'pr';
if (!Object.hasOwn(profileDefinitions, benchmarkProfile)) {
  throw new Error(`Unknown roadmap benchmark profile: ${benchmarkProfile}`);
}
const { measuredRuns, warmupRuns } = profileDefinitions[benchmarkProfile];
const parallel = Number(process.env.STORYFREEZE_ROADMAP_BENCHMARK_PARALLEL || 4);
if (!Number.isInteger(parallel) || parallel < 1 || parallel > 16) {
  throw new Error(`Unsupported roadmap benchmark parallel value: ${parallel}`);
}
const selectedScenarios = selectScenarios(process.env.STORYFREEZE_ROADMAP_BENCHMARK_SCENARIOS || 'all');
const modes = Object.freeze({
  stable: Object.freeze({ browserIsolation: 'process', captureProtocol: 'strict' }),
  topology: Object.freeze({ browserIsolation: 'auto', captureProtocol: 'strict' }),
  optimized: Object.freeze({ browserIsolation: 'auto', captureProtocol: 'auto' }),
});
const modeNames = Object.keys(modes);

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

function listPngs(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolutePath);
      else if (entry.name.endsWith('.png')) files.push(path.relative(directory, absolutePath).replaceAll('\\', '/'));
    }
  }
  return files.sort();
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function parseDiagnostics(log) {
  const plainLog = log.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
  const events = plainLog
    .split(/\r?\n/)
    .filter(line => line.startsWith(diagnosticPrefix))
    .map(line => JSON.parse(line.slice(diagnosticPrefix.length)));
  const storyCounts = [...plainLog.matchAll(/Found (\d+) stories\./g)].map(match => Number(match[1]));
  const loggedCaptureTimes = [...plainLog.matchAll(/Screenshot stored: .*? in (\d+) msec\./g)].map(match =>
    Number(match[1]),
  );
  const outputTimes = events
    .filter(event => event.type === 'capture-output' && typeof event.durationMs === 'number')
    .map(event => event.durationMs);
  return {
    browserCrashCount: [...plainLog.matchAll(/(?:Target closed|browser process.*crash)/gi)].length,
    captureTimesMs: outputTimes.length ? outputTimes : loggedCaptureTimes,
    events,
    retryCount: events.filter(event => event.type === 'capture-complete' && event.outcome === 'retry').length,
    storyCount: storyCounts.at(-1) ?? 0,
    timeoutCount: [...plainLog.matchAll(/(?:preview did not become ready|launch timeout exceeded|TimeoutError)/gi)]
      .length,
  };
}

function browserMetadata() {
  const packagePath = path.join(fixtureDir, 'node_modules', 'storyfreeze', 'package.json');
  const requireFromStoryfreeze = createRequire(fs.realpathSync(packagePath));
  const playwrightPackagePath = requireFromStoryfreeze.resolve('playwright-core/package.json');
  const playwrightPackage = JSON.parse(fs.readFileSync(playwrightPackagePath, 'utf8'));
  const executablePath = requireFromStoryfreeze('playwright-core').chromium.executablePath();
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Playwright Chromium ${executablePath} is not installed for the roadmap benchmark.`);
  }
  return {
    executablePath,
    playwrightCore: playwrightPackage.version,
    version:
      process.platform === 'win32'
        ? 'unknown (Windows executable metadata is not launched)'
        : execFileSync(executablePath, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(),
  };
}

function capturePhaseTimes(events, phase) {
  return events
    .filter(
      event =>
        event.type === 'capture-phase' &&
        event.state === 'end' &&
        event.phase === phase &&
        typeof event.durationMs === 'number',
    )
    .map(event => event.durationMs);
}

function measureRun({ browser, iteration, modeName, runKind, scenario, scenarioName }) {
  const mode = modes[modeName];
  const label = `${scenarioName}-${modeName}-${runKind}-${iteration}`;
  const outputDir = path.join(fixtureDir, '__screenshots__', 'roadmap-benchmark', label);
  fs.rmSync(outputDir, { recursive: true, force: true });
  const cli = path.join(fixtureDir, 'node_modules', 'storyfreeze', 'dist', 'node', 'cli.js');
  const args = [
    cli,
    '--verbose',
    '--chromium-path',
    browser.executablePath,
    '--parallel',
    String(parallel),
    '--out-dir',
    outputDir,
    '--browser-isolation',
    mode.browserIsolation,
    '--capture-protocol',
    mode.captureProtocol,
    '--include',
    scenario.include,
    'http://127.0.0.1:9014',
  ];

  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(process.execPath, args, {
      cwd: fixtureDir,
      env: {
        ...process.env,
        CI: 'true',
        FORCE_COLOR: '0',
        STORYFREEZE_CAPTURE_DIAGNOSTICS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.once('error', reject);
    child.once('close', code => {
      const wallTimeMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
      const diagnostics = parseDiagnostics(`${stdout}\n${stderr}`);
      const pngPaths = listPngs(outputDir);
      const outputEvents = diagnostics.events.filter(event => event.type === 'capture-output');
      const errors = [];
      if (code !== 0) errors.push(`CLI exited with code ${code}.`);
      if (diagnostics.storyCount !== scenario.expectedStories) {
        errors.push(`Expected ${scenario.expectedStories} stories, observed ${diagnostics.storyCount}.`);
      }
      if (pngPaths.length !== scenario.expectedPngs) {
        errors.push(`Expected ${scenario.expectedPngs} PNGs, found ${pngPaths.length}.`);
      }
      if (new Set(pngPaths).size !== pngPaths.length) errors.push('Observed duplicate PNG output paths.');
      if (outputEvents.length !== scenario.expectedPngs) {
        errors.push(`Expected ${scenario.expectedPngs} capture-output events, observed ${outputEvents.length}.`);
      }
      if (diagnostics.retryCount) errors.push(`Observed ${diagnostics.retryCount} capture retries.`);
      if (diagnostics.timeoutCount) errors.push(`Observed ${diagnostics.timeoutCount} capture timeouts.`);
      if (diagnostics.browserCrashCount) errors.push(`Observed ${diagnostics.browserCrashCount} browser crashes.`);
      const topology = diagnostics.events.findLast(event => event.type === 'browser-topology');
      const phase1 = diagnostics.events.findLast(event => event.type === 'phase1-summary');
      const screenshotBudgetEvents = diagnostics.events.filter(event => event.type === 'screenshot-budget');
      resolve({
        browserIsolation: mode.browserIsolation,
        browserCrashCount: diagnostics.browserCrashCount,
        captureProtocol: mode.captureProtocol,
        captureTimesMs: diagnostics.captureTimesMs,
        errors,
        exitCode: code,
        iteration,
        label,
        metricsTimesMs: capturePhaseTimes(diagnostics.events, 'metrics'),
        navigationTimesMs: capturePhaseTimes(diagnostics.events, 'navigation'),
        outputDir,
        phase1,
        pngCount: pngPaths.length,
        pngPaths,
        retryCount: diagnostics.retryCount,
        screenshotBudgetEvents,
        screenshotTimesMs: capturePhaseTimes(diagnostics.events, 'screenshot'),
        sessionCaptureCount: diagnostics.events.filter(event => event.type === 'story-session-capture').length,
        storyCount: diagnostics.storyCount,
        success: errors.length === 0,
        timeoutCount: diagnostics.timeoutCount,
        topology,
        wallTimeMs,
      });
    });
  });
}

function comparePngDirectories(stableDirectory, optimizedDirectory) {
  const stablePaths = listPngs(stableDirectory);
  const optimizedPaths = listPngs(optimizedDirectory);
  const paths = [...new Set([...stablePaths, ...optimizedPaths])].sort();
  const mismatches = [];
  let byteLengthMismatchCount = 0;
  for (const relativePath of paths) {
    const stablePath = path.join(stableDirectory, relativePath);
    const optimizedPath = path.join(optimizedDirectory, relativePath);
    if (!fs.existsSync(stablePath) || !fs.existsSync(optimizedPath)) {
      mismatches.push({
        optimizedExists: fs.existsSync(optimizedPath),
        path: relativePath,
        reason: 'output-path',
        stableExists: fs.existsSync(stablePath),
      });
      continue;
    }
    const stableBytes = fs.readFileSync(stablePath);
    const optimizedBytes = fs.readFileSync(optimizedPath);
    if (stableBytes.length !== optimizedBytes.length) byteLengthMismatchCount += 1;
    const stable = PNG.sync.read(stableBytes);
    const optimized = PNG.sync.read(optimizedBytes);
    if (stable.width !== optimized.width || stable.height !== optimized.height) {
      mismatches.push({
        optimizedDimensions: [optimized.width, optimized.height],
        path: relativePath,
        reason: 'dimensions',
        stableDimensions: [stable.width, stable.height],
      });
      continue;
    }
    let differentPixels = 0;
    let maxChannelDelta = 0;
    for (let index = 0; index < stable.data.length; index += 4) {
      let pixelDiffers = false;
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs(stable.data[index + channel] - optimized.data[index + channel]);
        maxChannelDelta = Math.max(maxChannelDelta, delta);
        pixelDiffers ||= delta !== 0;
      }
      if (pixelDiffers) differentPixels += 1;
    }
    if (differentPixels) {
      mismatches.push({
        differentPixels,
        maxChannelDelta,
        path: relativePath,
        reason: 'rgba',
      });
    }
  }
  return {
    byteLengthMismatchCount,
    mismatchCount: mismatches.length,
    mismatches,
    optimizedPngCount: optimizedPaths.length,
    stablePngCount: stablePaths.length,
  };
}

function summarizeRuns(runs) {
  const captureTimes = runs.flatMap(run => run.captureTimesMs);
  const navigationTimes = runs.flatMap(run => run.navigationTimesMs);
  const metricsTimes = runs.flatMap(run => run.metricsTimesMs);
  const screenshotTimes = runs.flatMap(run => run.screenshotTimesMs);
  const screenshotBudget = summarizeScreenshotBudget(runs.flatMap(run => run.screenshotBudgetEvents ?? []));
  return {
    browserCrashCount: runs.reduce((total, run) => total + run.browserCrashCount, 0),
    captureP50Ms: percentile(captureTimes, 0.5),
    captureP95Ms: percentile(captureTimes, 0.95),
    captureSamples: captureTimes.length,
    metricsP50Ms: percentile(metricsTimes, 0.5),
    metricsP95Ms: percentile(metricsTimes, 0.95),
    navigationCount: navigationTimes.length,
    navigationP50Ms: percentile(navigationTimes, 0.5),
    navigationP95Ms: percentile(navigationTimes, 0.95),
    retryCount: runs.reduce((total, run) => total + run.retryCount, 0),
    screenshotBudget,
    screenshotP50Ms: percentile(screenshotTimes, 0.5),
    screenshotP95Ms: percentile(screenshotTimes, 0.95),
    sessionCaptureCount: runs.reduce((total, run) => total + run.sessionCaptureCount, 0),
    successfulRuns: runs.filter(run => run.success).length,
    timeoutCount: runs.reduce((total, run) => total + run.timeoutCount, 0),
    totalRuns: runs.length,
    wallP50Ms: percentile(
      runs.map(run => run.wallTimeMs),
      0.5,
    ),
    wallP95Ms: percentile(
      runs.map(run => run.wallTimeMs),
      0.95,
    ),
  };
}

function ratio(numerator, denominator) {
  return typeof numerator === 'number' && typeof denominator === 'number' && denominator !== 0
    ? numerator / denominator
    : null;
}

function publicRun(run) {
  const { outputDir: _, ...record } = run;
  return record;
}

function writeBenchmarkRecord(record) {
  const json = `${JSON.stringify(record, null, 2)}\n`;
  if (outputFile) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, json);
  }
  return json;
}

function fatalBenchmarkRecord(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  return {
    schemaVersion: 1,
    kind: 'performance-roadmap-matrix',
    recordedAt: new Date().toISOString(),
    benchmarkProfile,
    measuredRuns,
    modes,
    parallel,
    scenarios: {},
    warmupRuns,
    fatalError: message,
    gate: { errors: [message], passed: false },
  };
}

function executionOrder(iteration) {
  const offset = (iteration - 1) % modeNames.length;
  return [...modeNames.slice(offset), ...modeNames.slice(0, offset)];
}

function comparisonRatios(candidate, baseline) {
  return {
    captureP50: ratio(candidate.captureP50Ms, baseline.captureP50Ms),
    captureP95: ratio(candidate.captureP95Ms, baseline.captureP95Ms),
    navigationCount: ratio(candidate.navigationCount, baseline.navigationCount),
    wallP50: ratio(candidate.wallP50Ms, baseline.wallP50Ms),
    wallP95: ratio(candidate.wallP95Ms, baseline.wallP95Ms),
  };
}

async function runScenario(browser, scenarioName, scenario) {
  for (let iteration = 1; iteration <= warmupRuns; iteration += 1) {
    for (const modeName of executionOrder(iteration)) {
      await measureRun({ browser, iteration, modeName, runKind: 'warmup', scenario, scenarioName });
    }
  }

  const runs = Object.fromEntries(modeNames.map(modeName => [modeName, []]));
  for (let iteration = 1; iteration <= measuredRuns; iteration += 1) {
    for (const modeName of executionOrder(iteration)) {
      const run = await measureRun({ browser, iteration, modeName, runKind: 'measured', scenario, scenarioName });
      runs[modeName].push(run);
      console.log(
        `${scenarioName} ${modeName} ${iteration}/${measuredRuns}: ${run.wallTimeMs} ms, ${run.pngCount} PNGs.`,
      );
    }
  }

  const pixelComparisons = runs.stable.flatMap((run, index) =>
    modeNames
      .filter(modeName => modeName !== 'stable')
      .map(modeName => ({
        mode: modeName,
        ...comparePngDirectories(run.outputDir, runs[modeName][index].outputDir),
      })),
  );
  const summaries = Object.fromEntries(modeNames.map(modeName => [modeName, summarizeRuns(runs[modeName])]));
  const errors = [];
  for (const modeName of Object.keys(modes)) {
    for (const run of runs[modeName]) run.errors.forEach(error => errors.push(`${run.label}: ${error}`));
  }
  pixelComparisons.forEach((comparison, index) => {
    if (comparison.mismatchCount) {
      errors.push(`${scenarioName} pixel comparison ${index + 1}: ${comparison.mismatchCount} mismatch(es).`);
    }
  });
  return {
    expectedPngs: scenario.expectedPngs,
    expectedStories: scenario.expectedStories,
    include: scenario.include,
    label: scenario.label,
    modes: Object.fromEntries(
      modeNames.map(modeName => [modeName, { runs: runs[modeName].map(publicRun), summary: summaries[modeName] }]),
    ),
    topologyToStable: comparisonRatios(summaries.topology, summaries.stable),
    optimizedToTopology: comparisonRatios(summaries.optimized, summaries.topology),
    optimizedToStable: comparisonRatios(summaries.optimized, summaries.stable),
    pixelComparisons,
    gate: { errors, passed: errors.length === 0 },
  };
}

function startPreview() {
  const vitePackagePath = require.resolve('vite/package.json', { paths: [fixtureDir] });
  const vitePackage = JSON.parse(fs.readFileSync(vitePackagePath, 'utf8'));
  const viteBin = typeof vitePackage.bin === 'string' ? vitePackage.bin : vitePackage.bin.vite;
  return spawn(
    process.execPath,
    [
      path.resolve(path.dirname(vitePackagePath), viteBin),
      'preview',
      '--outDir',
      'storybook-static/performance',
      '--host',
      '127.0.0.1',
      '--port',
      '9014',
      '--strictPort',
    ],
    { cwd: fixtureDir, env: { ...process.env, CI: 'true', FORCE_COLOR: '0' }, stdio: 'inherit' },
  );
}

async function waitForPreview(server) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error('Performance Storybook preview exited before startup.');
    }
    try {
      const response = await fetch('http://127.0.0.1:9014/index.json', { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
    } catch {
      // Retry until the startup deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Performance Storybook preview did not start within 30000 msec.');
}

async function stopPreview(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}

async function main() {
  runPnpm(['run', 'clear']);
  runPnpm(['run', 'build-storybook:performance']);
  const browser = browserMetadata();
  const server = startPreview();
  const scenarioResults = {};
  try {
    await waitForPreview(server);
    for (const [scenarioName, scenario] of selectedScenarios) {
      scenarioResults[scenarioName] = await runScenario(browser, scenarioName, scenario);
    }
  } finally {
    await stopPreview(server);
  }
  const errors = Object.entries(scenarioResults).flatMap(([scenarioName, result]) =>
    result.gate.errors.map(error => `${scenarioName}: ${error}`),
  );
  const result = {
    schemaVersion: 1,
    kind: 'performance-roadmap-matrix',
    recordedAt: new Date().toISOString(),
    benchmarkProfile,
    browser,
    measuredRuns,
    modes,
    parallel,
    scenarios: scenarioResults,
    warmupRuns,
    gate: { errors, passed: errors.length === 0 },
  };
  writeBenchmarkRecord(result);
  console.log(`STORYFREEZE_ROADMAP_BENCHMARK_RESULT=${JSON.stringify(result)}`);
  if (errors.length) throw new Error(`Performance roadmap benchmark failed:\n- ${errors.join('\n- ')}`);
}

if (require.main === module) {
  main().catch(error => {
    if (outputFile && !fs.existsSync(outputFile)) writeBenchmarkRecord(fatalBenchmarkRecord(error));
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  comparePngDirectories,
  comparisonRatios,
  executionOrder,
  fatalBenchmarkRecord,
  parseDiagnostics,
  percentile,
  profileDefinitions,
  summarizeRuns,
};
