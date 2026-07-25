#!/usr/bin/env node
// Local A/B harness for StoryFreeze performance work.
//
// Purpose: compare several *arms* (self-contained package snapshots under
// packages/storyfreeze/.perf-arms) against each other on a set of scenarios,
// with a parity gate so a speedup can never be bought with wrong output.
//
// This is a development tool. It is deliberately dependency-free apart from
// pngjs (already a root devDependency) and reuses the release harness helpers
// so the two agree on how PNGs are inspected.
//
// Usage:
//   node scripts/local-ab.js --save-arm <name>
//   node scripts/local-ab.js --arms 00-baseline,01-notify --scenarios S2,S3 --reps 5
//   node scripts/local-ab.js --arms baseline,optimize --scenarios S1 --parity rgba
//   node scripts/local-ab.js --list

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { percentile, inspectPngDirectory, compareManifests } = require('./release-performance.js');

const repoDir = path.resolve(__dirname, '..');
const packageDir = path.join(repoDir, 'packages/storyfreeze');
const armsDir = path.join(packageDir, '.perf-arms');
const fixtureDir = path.join(repoDir, 'examples/react-vite');
const staticRoot = path.join(fixtureDir, 'storybook-static');
const workDir = path.join(armsDir, '.work');

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Scenarios. `include`/`exclude` are StoryFreeze CLI glob rules, so one static
 * build can host several scenarios without rebuilding Storybook.
 */
const scenarios = {
  S0: {
    static: 'bench-s0',
    parallel: 4,
    // The Retry fixture deliberately stalls 3.5s on its first request, which
    // would dominate and destabilise a timing scenario.
    args: ['--include', 'Compatibility/Fixture/**', '--exclude', 'Compatibility/Fixture/Retry'],
    note: 'existing e2e fixture, regression watch',
  },
  S1: {
    static: 'bench',
    parallel: 4,
    // The raw-RGBA reservation budget serialises these captures, so the last one
    // in a batch inherits the whole queue's wait inside its own deadline. At the
    // 5 s default, and even at 30 s, the run measures retries instead of
    // throughput.
    args: ['--include', 'Bench/Heavy/**', '--capture-timeout', '60000'],
    note: '1440@2x tall fullPage',
  },
  S2: {
    static: 'bench',
    parallel: 4,
    args: ['--include', 'Bench/Variants/**'],
    note: 'viewport variants + delay + play',
  },
  S3: {
    static: 'bench',
    parallel: 4,
    args: ['--include', 'Bench/Scale/**'],
    note: '300 stories, skewed cost',
  },
  S4: {
    static: 'bench',
    parallel: 1,
    args: ['--include', 'Bench/Probe/**'],
    note: 'emulation probe, correctness gate',
  },
  // Sharding has no work stealing between machines, so the run costs whatever
  // the slowest shard costs. Shards are executed one at a time so each gets the
  // whole machine, which is what a multi-machine run actually looks like, and the
  // scenario's wall time is the maximum rather than the sum.
  S5: {
    static: 'bench',
    parallel: 4,
    shards: 4,
    // A generous deadline: at the 5 s default, an unlucky shard hits a
    // timeout-and-retry cascade that dwarfs any difference between strategies.
    args: ['--include', 'Bench/Scale/**', '--capture-timeout', '30000'],
    note: '4 shards, cost uncorrelated with index',
  },
  S6: {
    static: 'bench',
    parallel: 4,
    shards: 4,
    args: ['--include', 'Bench/Skew/**', '--capture-timeout', '30000'],
    note: '4 shards, every 4th story is expensive (adversarial for round-robin)',
  },
};

function parseArgs(argv) {
  const values = {
    reps: 5,
    warmup: 1,
    arms: [],
    scenarios: [],
    saveArm: null,
    list: false,
    memory: false,
    parity: 'bytes',
    tag: 'run',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === '--arms') values.arms = next().split(',').filter(Boolean);
    else if (argument === '--scenarios') values.scenarios = next().split(',').filter(Boolean);
    else if (argument === '--reps') values.reps = Number(next());
    else if (argument === '--warmup') values.warmup = Number(next());
    else if (argument === '--save-arm') values.saveArm = next();
    else if (argument === '--tag') values.tag = next();
    else if (argument === '--parity') values.parity = next();
    else if (argument === '--memory') values.memory = true;
    else if (argument === '--list') values.list = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (values.parity !== 'bytes' && values.parity !== 'rgba') {
    throw new Error(`--parity must be "bytes" or "rgba".`);
  }
  return values;
}

// --- arm management -------------------------------------------------------

function saveArm(name) {
  const target = path.join(armsDir, name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(packageDir, 'dist'), path.join(target, 'dist'), { recursive: true });
  fs.cpSync(path.join(packageDir, 'assets'), path.join(target, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(packageDir, 'package.json'), path.join(target, 'package.json'));
  process.stdout.write(`Saved arm ${name} -> ${path.relative(repoDir, target)}\n`);
  return target;
}

function listArms() {
  if (!fs.existsSync(armsDir)) return [];
  return fs
    .readdirSync(armsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
}

function armCli(name) {
  const cli = path.join(armsDir, name, 'dist/node/cli.js');
  if (!fs.existsSync(cli)) throw new Error(`Arm ${name} has no dist/node/cli.js. Save it first.`);
  return cli;
}

/**
 * An arm is `<name>[@<staticDir>][!<plus-separated extra CLI args>]`.
 *
 * `@static` pins one arm to a specific Storybook build, which is how a
 * build-time change (the indexer) is compared: the same Node binary runs against
 * two statics whose Preview code is identical and whose index.json differs.
 *
 * `!args` appends CLI flags, which is how a runtime option (the shard strategy)
 * is compared: one binary, one static, only the flag differs. Both forms keep the
 * comparison inside a single balanced schedule.
 *
 * `%KEY=VALUE` sets an environment variable, which is how an experiment gated
 * behind an env flag is compared without rebuilding.
 *
 * Args are separated by `+` because `,` already separates arms in --arms.
 */
function parseArmSpec(spec) {
  const [beforeEnv, ...envParts] = spec.split('%');
  const [head, rawArgs] = beforeEnv.split('!');
  const [name, staticDir] = head.split('@');
  const extraArgs = rawArgs ? rawArgs.split('+').filter(Boolean) : [];
  const extraEnv = {};
  for (const part of envParts) {
    const separator = part.indexOf('=');
    if (separator > 0) extraEnv[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return { spec, name, staticDir, extraArgs, extraEnv };
}

// --- static server -------------------------------------------------------

function startStaticServer(directory) {
  const root = fs.realpathSync(directory);
  const server = http.createServer((request, response) => {
    const requested = new URL(request.url, 'http://127.0.0.1');
    let relative = decodeURIComponent(requested.pathname);
    if (relative.endsWith('/')) relative += 'index.html';
    const resolved = path.join(root, relative);
    // Path containment: never serve outside the static root.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    fs.readFile(resolved, (error, content) => {
      if (error) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': mimeTypes[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
        'content-length': content.length,
        // Storybook assets are immutable per build; let Chromium cache them so
        // repeated navigations measure StoryFreeze rather than the server.
        'cache-control': 'public, max-age=3600',
      });
      response.end(content);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        async close() {
          await new Promise(done => server.close(done));
        },
      });
    });
  });
}

// --- PNG manifest (cheap path) -------------------------------------------

function readPngHeader(file) {
  const header = Buffer.alloc(33);
  const handle = fs.openSync(file, 'r');
  try {
    fs.readSync(handle, header, 0, 33, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (header.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/**
 * Byte-level manifest. Decoding every PNG with pngjs is far too expensive for
 * the tall retina scenario (a single S1 image is ~115 MB of RGBA), so parity is
 * checked on file bytes first and only escalated to a decode when the bytes
 * differ.
 */
function inspectPngBytes(directory) {
  const manifest = [];
  const pending = [directory];
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) continue;
      const content = fs.readFileSync(absolute);
      const dimensions = readPngHeader(absolute);
      totalBytes += content.length;
      manifest.push({
        path: path.relative(directory, absolute).replaceAll('\\', '/'),
        bytes: content.length,
        width: dimensions?.width ?? 0,
        height: dimensions?.height ?? 0,
        byteSha256: crypto.createHash('sha256').update(content).digest('hex'),
      });
    }
  }
  manifest.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { manifest, totalBytes };
}

function comparePngBytes(reference, actual) {
  const expected = new Map(reference.map(entry => [entry.path, entry]));
  const observed = new Map(actual.map(entry => [entry.path, entry]));
  const byteMismatches = [];
  let dimensionMismatchCount = 0;
  for (const [relativePath, expectedEntry] of expected) {
    const actualEntry = observed.get(relativePath);
    if (!actualEntry) continue;
    if (expectedEntry.width !== actualEntry.width || expectedEntry.height !== actualEntry.height) {
      dimensionMismatchCount += 1;
    }
    if (expectedEntry.byteSha256 !== actualEntry.byteSha256) byteMismatches.push(relativePath);
  }
  return {
    missingPngCount: [...expected.keys()].filter(relativePath => !observed.has(relativePath)).length,
    unexpectedPngCount: [...observed.keys()].filter(relativePath => !expected.has(relativePath)).length,
    dimensionMismatchCount,
    byteMismatchCount: byteMismatches.length,
    byteMismatches: byteMismatches.slice(0, 10),
  };
}

function findCrossShardDuplicatePaths(shardManifests) {
  const seen = new Set();
  const duplicates = new Set();
  for (const manifest of shardManifests) {
    for (const entry of manifest) {
      if (seen.has(entry.path)) duplicates.add(entry.path);
      else seen.add(entry.path);
    }
  }
  return [...duplicates].sort();
}

// --- run -----------------------------------------------------------------

function parseLog(text) {
  const stored = [];
  const storedPaths = new Set();
  let duplicatePngCount = 0;
  let totalMs;
  let retryCount = 0;
  let warnCount = 0;
  for (const match of text.matchAll(/Screenshot stored:\s+(.+?)\s+in\s+(\d+(?:\.\d+)?)\s+msec\./g)) {
    const outputPath = match[1].replaceAll('\\', '/');
    if (storedPaths.has(outputPath)) duplicatePngCount += 1;
    storedPaths.add(outputPath);
    stored.push(Number(match[2]));
  }
  for (const match of text.matchAll(/Screenshot was ended successfully in (\d+(?:\.\d+)?) msec/g)) {
    totalMs = Number(match[1]);
  }
  retryCount = [...text.matchAll(/Retry to screenshot this story after this sequence\./g)].length;
  warnCount = [...text.matchAll(/^\s*warn\s/gm)].length;
  return { captureMs: stored, duplicatePngCount, totalMs, retryCount, warnCount };
}

function normalizeExitCode(code) {
  return Number.isSafeInteger(code) && code >= 0 ? code : 1;
}

async function runOnce({ arm, name, scenario, scenarioId, label, url, extraArgs = [], extraEnv = {}, onSpawn }) {
  const slug = arm.replaceAll('@', '_at_');
  const outDir = path.join(workDir, `${scenarioId}-${slug}-${label}`);
  const tracePath = path.join(workDir, `${scenarioId}-${slug}-${label}.trace.json`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(tracePath, { force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const args = [
    armCli(name),
    '--parallel',
    String(scenario.parallel),
    '--out-dir',
    outDir,
    ...scenario.args,
    ...extraArgs,
    url,
  ];

  const startedAt = process.hrtime.bigint();
  const child = spawn(process.execPath, args, {
    cwd: repoDir,
    env: {
      ...process.env,
      CI: 'true',
      FORCE_COLOR: '0',
      STORYFREEZE_PERF_TRACE: tracePath,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid !== undefined) onSpawn?.(child.pid);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));
  const termination = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ exitCode: normalizeExitCode(code), signal });
    });
  });
  const { exitCode } = termination;
  const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  const log = parseLog(output);
  const png = inspectPngBytes(outDir);
  if (exitCode !== 0 || log.retryCount > 0) {
    // Keep the evidence: a non-zero exit or a retry is the only thing that can
    // invalidate a timing comparison, and it is not reproducible on demand.
    fs.writeFileSync(path.join(workDir, `${scenarioId}-${slug}-${label}.fail.log`), output, 'utf8');
  }
  let trace;
  if (fs.existsSync(tracePath)) {
    try {
      trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    } catch (error) {
      trace = { parseError: String(error?.message ?? error) };
    }
  }

  return {
    arm,
    scenarioId,
    label,
    exitCode,
    wallMs,
    pngCount: png.manifest.length,
    totalPngBytes: png.totalBytes,
    manifest: png.manifest,
    outDir,
    log,
    trace,
    terminationSignal: termination.signal,
    output,
  };
}

/**
 * Runs every shard of a scenario sequentially and reports the slowest one.
 *
 * PNGs land in a shared output directory so parity is checked on the union of
 * all shards; a single shard's set is meaningless because the split differs
 * between strategies.
 */
async function runSharded(context) {
  const { scenario, scenarioId, arm, label } = context;
  const shardRuns = [];
  const unionDir = path.join(workDir, `${arm.replaceAll('@', '_at_')}-${scenarioId}-${label}-union`);
  fs.rmSync(unionDir, { recursive: true, force: true });
  fs.mkdirSync(unionDir, { recursive: true });
  for (let shard = 1; shard <= scenario.shards; shard += 1) {
    const run = await runOnce({
      ...context,
      label: `${label}-shard${shard}`,
      extraArgs: [...(context.extraArgs ?? []), '--shard', `${shard}/${scenario.shards}`],
    });
    shardRuns.push(run);
    if (fs.existsSync(run.outDir)) fs.cpSync(run.outDir, unionDir, { recursive: true });
    fs.rmSync(run.outDir, { recursive: true, force: true });
  }
  const crossShardDuplicatePngPaths = findCrossShardDuplicatePaths(shardRuns.map(run => run.manifest));
  const png = inspectPngBytes(unionDir);
  const shardWalls = shardRuns.map(run => run.wallMs);
  const failedShard = shardRuns.find(run => run.exitCode !== 0);
  return {
    arm,
    scenarioId,
    label,
    exitCode: failedShard?.exitCode ?? 0,
    terminationSignal: failedShard?.terminationSignal,
    // The metric that matters for a multi-machine run.
    wallMs: Math.max(...shardWalls),
    shardWalls,
    shardSpreadMs: Math.max(...shardWalls) - Math.min(...shardWalls),
    shardPngCounts: shardRuns.map(run => run.pngCount),
    crossShardDuplicatePngCount: crossShardDuplicatePngPaths.length,
    crossShardDuplicatePngPaths: crossShardDuplicatePngPaths.slice(0, 10),
    pngCount: png.manifest.length,
    totalPngBytes: png.totalBytes,
    manifest: png.manifest,
    outDir: unionDir,
    log: {
      captureMs: shardRuns.flatMap(run => run.log.captureMs),
      duplicatePngCount: shardRuns.reduce((total, run) => total + run.log.duplicatePngCount, 0),
      retryCount: shardRuns.reduce((total, run) => total + run.log.retryCount, 0),
      warnCount: shardRuns.reduce((total, run) => total + run.log.warnCount, 0),
    },
    // Counters summed across shards, plus each shard's own totals so an outlier
    // shard can be told apart from a uniformly slower split.
    trace: {
      totals: shardRuns.reduce((accumulator, run) => {
        for (const [key, value] of Object.entries(run.trace?.totals ?? {})) {
          if (typeof value === 'number') accumulator[key] = (accumulator[key] ?? 0) + value;
        }
        return accumulator;
      }, {}),
      rawCdpSends: shardRuns.reduce((accumulator, run) => {
        for (const [key, value] of Object.entries(run.trace?.rawCdpSends ?? {})) {
          accumulator[key] = (accumulator[key] ?? 0) + value;
        }
        return accumulator;
      }, {}),
      perShard: shardRuns.map(run => ({
        wallMs: Math.round(run.wallMs),
        captures: run.trace?.totals?.captures,
        readinessWaitMsSum: run.trace?.totals?.readinessWaitMsSum,
        contextRestarts: run.trace?.totals?.contextRestarts ?? 0,
        captureRetries: run.trace?.totals?.captureRetries ?? 0,
        permitWaitMsSum: run.trace?.totals?.permitWaitMsSum,
        workerBusyMsSpread: run.trace?.totals?.workerBusyMsSpread,
      })),
    },
  };
}

function execute(context) {
  return context.scenario.shards ? runSharded(context) : runOnce(context);
}

/**
 * Samples the working set of the whole browser process tree once per second.
 *
 * Each sample shells out to PowerShell, which costs real CPU, so this only ever
 * runs in the dedicated --memory mode and never during a timing comparison.
 */
function windowsProcessTreeScript(rootPid) {
  return [
    `$rootPid = ${rootPid}`,
    '$processes = Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId, ParentProcessId',
    '$ids = [System.Collections.Generic.HashSet[int]]::new()',
    '[void]$ids.Add($rootPid)',
    'do {',
    '  $added = $false',
    '  foreach ($process in $processes) {',
    '    if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) {',
    '      $added = $true',
    '    }',
    '  }',
    '} while ($added)',
    '($ids | ForEach-Object {',
    '  (Get-Process -Id $_ -ErrorAction SilentlyContinue).WorkingSet64',
    '} | Measure-Object -Sum).Sum',
  ].join('; ');
}

function sampleWindowsProcessTree(rootPid) {
  return new Promise(resolve => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', windowsProcessTreeScript(rootPid)],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => (output += chunk));
    child.once('error', () => resolve(undefined));
    child.once('close', () => {
      const value = Number(output.trim());
      resolve(Number.isFinite(value) && value > 0 ? value : undefined);
    });
  });
}

function startMemorySampler({ intervalMs = 1000, sample = sampleWindowsProcessTree } = {}) {
  const samples = [];
  let stopped = false;
  let rootPid;
  let activeSample;
  const tick = () => {
    if (stopped || rootPid === undefined || activeSample) return;
    const sampledPid = rootPid;
    activeSample = Promise.resolve()
      .then(() => sample(sampledPid))
      .then(value => {
        if (Number.isFinite(value) && value > 0) samples.push(value);
      })
      .catch(() => {
        // A transient process-query failure must not perturb or fail the run
        // being measured. A later interval can sample the same process tree.
      })
      .finally(() => {
        activeSample = undefined;
      });
  };
  const handle = setInterval(tick, intervalMs);
  return {
    track(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Invalid process id for memory sampling: ${pid}`);
      rootPid = pid;
      tick();
    },
    async stop() {
      stopped = true;
      clearInterval(handle);
      await activeSample;
      if (samples.length === 0) {
        throw new Error('Windows process-tree memory sampling produced no valid samples.');
      }
      return {
        samples: samples.length,
        peakProcessTreeBytes: Math.max(...samples),
        medianProcessTreeBytes: percentile(samples, 0.5),
      };
    },
  };
}

function runHealthFailures(run) {
  const failures = [];
  if (run.exitCode !== 0) {
    failures.push(`exited ${run.exitCode}${run.terminationSignal ? ` after signal ${run.terminationSignal}` : ''}`);
  }
  if (run.log.retryCount > 0) failures.push(`retried ${run.log.retryCount} capture(s)`);
  if (run.log.duplicatePngCount > 0) failures.push('logged duplicate PNG lines');
  if ((run.crossShardDuplicatePngCount ?? 0) > 0) {
    failures.push(`produced ${run.crossShardDuplicatePngCount} duplicate PNG path(s) across shards`);
  }
  if (!Number.isSafeInteger(run.pngCount) || run.pngCount < 1) failures.push('produced no PNG files');
  return failures;
}

function memoryRunFailures(run) {
  return runHealthFailures(run);
}

function combinedFailure(context, failures) {
  const errors = failures.map(failure => (failure instanceof Error ? failure : new Error(String(failure))));
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, `${context}: ${errors[0].message}`);
}

async function runMemory(scenarioId, armSpec) {
  const scenario = scenarios[scenarioId];
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  const entry = parseArmSpec(armSpec);
  const server = await startStaticServer(path.join(staticRoot, entry.staticDir ?? scenario.static));
  const sampler = startMemorySampler();
  let run;
  let memory;
  let result;
  let primaryFailure;
  try {
    let executionFailure;
    try {
      run = await execute({
        arm: entry.spec,
        name: entry.name,
        extraArgs: entry.extraArgs,
        extraEnv: entry.extraEnv,
        scenario,
        scenarioId,
        label: 'memory',
        url: server.url,
        onSpawn: pid => sampler.track(pid),
      });
    } catch (error) {
      executionFailure = { error };
    }

    const shutdownFailures = [];
    try {
      memory = await sampler.stop();
    } catch (error) {
      shutdownFailures.push(error);
    }
    try {
      await server.close();
    } catch (error) {
      shutdownFailures.push(error);
    }

    const failures = [...(executionFailure ? [executionFailure.error] : []), ...shutdownFailures];
    if (failures.length > 0) throw combinedFailure('Memory run or cleanup failed', failures);
    if (!run || !memory) throw new Error('Memory run did not produce a result.');

    const unhealthy = memoryRunFailures(run);
    if (unhealthy.length > 0) throw new Error(`Memory run is not valid: ${unhealthy.join('; ')}.`);
    result = { scenarioId, arm: entry.spec, wallMs: round(run.wallMs), memory, trace: run.trace };
  } catch (error) {
    primaryFailure = { error };
  }

  const cleanupFailures = [];
  if (run?.outDir) {
    try {
      fs.rmSync(run.outDir, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  const failures = [...(primaryFailure ? [primaryFailure.error] : []), ...cleanupFailures];
  if (failures.length > 0) throw combinedFailure('Memory run or output cleanup failed', failures);
  if (!result) throw new Error('Memory run did not produce a report.');
  return result;
}

/**
 * Balanced schedule: rotate the starting arm every repetition and alternate the
 * direction, so no arm systematically benefits from cache warmth or thermal
 * state at a fixed position in the sequence.
 */
function buildSchedule(arms, reps) {
  const schedule = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const cycle = Math.floor(rep / arms.length);
    const position = rep % arms.length;
    // Walk each complete rotation forward, then walk the next one backwards
    // while reversing the run order. For two arms this is the expected
    // A/B, B/A, A/B, B/A sequence; for larger sets every arm still occupies
    // every position before the direction changes.
    const offset = cycle % 2 === 0 ? position : arms.length - 1 - position;
    const rotated = arms.map((_, index) => arms[(index + offset) % arms.length]);
    schedule.push(cycle % 2 === 0 ? rotated : [...rotated].reverse());
  }
  return schedule;
}

function median(values) {
  return percentile(values, 0.5);
}

function summarizeArm(runs) {
  const healthyRun = runs.find(run => runHealthFailures(run).length === 0);
  const wall = runs.map(run => run.wallMs);
  const capture = runs.flatMap(run => run.log.captureMs);
  const spreads = runs.map(run => run.shardSpreadMs).filter(value => typeof value === 'number');
  return {
    runs: runs.length,
    wallP50Ms: round(percentile(wall, 0.5)),
    wallP95Ms: round(percentile(wall, 0.95)),
    wallMinMs: round(percentile(wall, 0)),
    captureP50Ms: round(percentile(capture, 0.5)),
    captureP95Ms: round(percentile(capture, 0.95)),
    // Reported from a run that neither failed nor retried, so an incomplete
    // output set never masquerades as the arm's result.
    pngCount: healthyRun?.pngCount ?? 0,
    totalPngBytes: healthyRun?.totalPngBytes ?? 0,
    unhealthyRuns: runs.length - runs.filter(run => runHealthFailures(run).length === 0).length,
    ...(spreads.length > 0
      ? {
          shardSpreadP50Ms: round(percentile(spreads, 0.5)),
          shardPngCounts: runs[0]?.shardPngCounts,
        }
      : {}),
  };
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function aggregateTrace(runs) {
  const traces = runs.map(run => run.trace).filter(Boolean);
  if (traces.length === 0) return undefined;
  const numeric = new Map();
  const counters = new Map();
  for (const trace of traces) {
    for (const [key, value] of Object.entries(trace.totals ?? {})) {
      if (typeof value !== 'number') continue;
      if (!numeric.has(key)) numeric.set(key, []);
      numeric.get(key).push(value);
    }
    for (const [key, value] of Object.entries(trace.rawCdpSends ?? {})) {
      counters.set(key, (counters.get(key) ?? 0) + value / traces.length);
    }
  }
  const totals = {};
  for (const [key, values] of numeric) totals[key] = round(median(values));
  const rawCdpSends = {};
  for (const [key, value] of counters) rawCdpSends[key] = round(value);
  const perShard = traces.find(trace => trace.perShard)?.perShard;
  return { totals, rawCdpSends, ...(perShard ? { perShard } : {}) };
}

function pairedDeltas(runsByArm, arms) {
  const deltas = {};
  for (let index = 1; index < arms.length; index += 1) {
    const previous = arms[index - 1];
    const current = arms[index];
    const samples = [];
    const previousRuns = runsByArm.get(previous) ?? [];
    const currentRuns = runsByArm.get(current) ?? [];
    for (let rep = 0; rep < Math.min(previousRuns.length, currentRuns.length); rep += 1) {
      samples.push(currentRuns[rep].wallMs - previousRuns[rep].wallMs);
    }
    deltas[`${current} - ${previous}`] = {
      medianDeltaMs: round(median(samples)),
      samples: samples.map(round),
    };
  }
  const first = arms[0];
  const last = arms[arms.length - 1];
  if (arms.length > 2) {
    const firstRuns = runsByArm.get(first) ?? [];
    const lastRuns = runsByArm.get(last) ?? [];
    const samples = [];
    for (let rep = 0; rep < Math.min(firstRuns.length, lastRuns.length); rep += 1) {
      samples.push(lastRuns[rep].wallMs - firstRuns[rep].wallMs);
    }
    deltas[`${last} - ${first}`] = { medianDeltaMs: round(median(samples)), samples: samples.map(round) };
  }
  return deltas;
}

function parityHasMismatch(value, mode) {
  if (value.missingPngCount > 0 || value.unexpectedPngCount > 0 || value.dimensionMismatchCount > 0) {
    return true;
  }
  if (mode === 'bytes') return value.byteMismatchCount > 0;
  if (value.byteMismatchCount === 0) return false;
  const rgba = value.rgba;
  return (
    !rgba ||
    rgba.referenceUnreadableCount > 0 ||
    rgba.candidateUnreadableCount > 0 ||
    rgba.missingPngCount > 0 ||
    rgba.unexpectedPngCount > 0 ||
    rgba.dimensionMismatchCount > 0 ||
    rgba.rgbaMismatchCount > 0
  );
}

function aggregateParityComparisons(comparisons) {
  const total = {
    checkedRuns: comparisons.length,
    missingPngCount: 0,
    unexpectedPngCount: 0,
    dimensionMismatchCount: 0,
    byteMismatchCount: 0,
    byteMismatches: [],
  };
  const byteMismatches = new Set();
  let rgba;
  for (const comparison of comparisons) {
    total.missingPngCount += comparison.missingPngCount;
    total.unexpectedPngCount += comparison.unexpectedPngCount;
    total.dimensionMismatchCount += comparison.dimensionMismatchCount;
    total.byteMismatchCount += comparison.byteMismatchCount;
    for (const relativePath of comparison.byteMismatches ?? []) byteMismatches.add(relativePath);
    if (comparison.rgba) {
      rgba ??= {
        missingPngCount: 0,
        unexpectedPngCount: 0,
        dimensionMismatchCount: 0,
        rgbaMismatchCount: 0,
        referenceUnreadableCount: 0,
        candidateUnreadableCount: 0,
      };
      for (const key of Object.keys(rgba)) rgba[key] += comparison.rgba[key] ?? 0;
    }
  }
  total.byteMismatches = [...byteMismatches].sort().slice(0, 10);
  return { ...total, ...(rgba ? { rgba } : {}) };
}

async function runScenario(scenarioId, armSpecs, options) {
  const scenario = scenarios[scenarioId];
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  const parsed = armSpecs.map(parseArmSpec);
  const arms = parsed.map(entry => entry.spec);
  const staticFor = new Map(parsed.map(entry => [entry.spec, entry.staticDir ?? scenario.static]));

  // One server per distinct static so arms pinned to different builds can be
  // interleaved in a single balanced schedule.
  const servers = new Map();
  for (const name of new Set(staticFor.values())) {
    const staticDir = path.join(staticRoot, name);
    if (!fs.existsSync(staticDir)) {
      throw new Error(`Missing static build ${staticDir}. Run pnpm --dir examples/react-vite build-storybook:bench.`);
    }
    servers.set(name, await startStaticServer(staticDir));
  }
  const urlFor = spec => servers.get(staticFor.get(spec)).url;
  const runsByArm = new Map(arms.map(arm => [arm, []]));
  const failures = [];
  try {
    for (let index = 0; index < options.warmup; index += 1) {
      for (const entry of parsed) {
        process.stdout.write(`  [${scenarioId}] warmup ${entry.spec}\n`);
        const run = await execute({
          arm: entry.spec,
          name: entry.name,
          extraArgs: entry.extraArgs,
          extraEnv: entry.extraEnv,
          scenario,
          scenarioId,
          label: `warmup-${index}`,
          url: urlFor(entry.spec),
        });
        if (run.exitCode !== 0) failures.push(`${entry.spec} warmup exited ${run.exitCode}`);
        fs.rmSync(run.outDir, { recursive: true, force: true });
      }
    }
    const schedule = buildSchedule(arms, options.reps);
    for (let rep = 0; rep < schedule.length; rep += 1) {
      for (const arm of schedule[rep]) {
        const parsedArm = parseArmSpec(arm);
        const run = await execute({
          arm,
          name: parsedArm.name,
          extraArgs: parsedArm.extraArgs,
          extraEnv: parsedArm.extraEnv,
          scenario,
          scenarioId,
          label: `rep-${rep}`,
          url: urlFor(arm),
        });
        process.stdout.write(
          `  [${scenarioId}] rep${rep} ${arm.padEnd(34)} ${String(Math.round(run.wallMs)).padStart(7)} ms  ` +
            `${run.pngCount} png` +
            (run.shardWalls
              ? `  shards ${run.shardWalls.map(Math.round).join('/')} spread ${Math.round(run.shardSpreadMs)}`
              : '') +
            '\n',
        );
        for (const failure of runHealthFailures(run)) failures.push(`${arm} rep${rep} ${failure}`);
        runsByArm.get(arm).push(run);
      }
    }
  } finally {
    await Promise.all([...servers.values()].map(server => server.close()));
  }

  // Parity: every arm must produce the same PNG set as the first arm.
  //
  // A run that exited non-zero or retried has an incomplete or re-captured
  // output set, so it can never serve as the reference or the candidate; using
  // one silently turns a flaky run into a fake parity mismatch.
  const healthy = arm => runsByArm.get(arm).filter(run => runHealthFailures(run).length === 0);
  const reference = healthy(arms[0])[0];
  const parity = {};
  if (!reference) failures.push(`${arms[0]} produced no healthy run to compare against`);
  for (const arm of reference ? arms : []) {
    const candidates = healthy(arm);
    if (candidates.length === 0) {
      failures.push(`${arm} produced no healthy run for the parity gate`);
      continue;
    }
    const comparisons = [];
    for (const candidate of candidates) {
      const byteComparison = comparePngBytes(reference.manifest, candidate.manifest);
      let rgba;
      if (byteComparison.byteMismatchCount > 0) {
        // Escalate to a decoded comparison only when bytes differ.
        const referenceDecoded = inspectPngDirectory(reference.outDir);
        const candidateDecoded = inspectPngDirectory(candidate.outDir);
        rgba = {
          ...compareManifests(referenceDecoded.manifest, candidateDecoded.manifest),
          referenceUnreadableCount: referenceDecoded.unreadable.length,
          candidateUnreadableCount: candidateDecoded.unreadable.length,
        };
      }
      comparisons.push({ ...byteComparison, ...(rgba ? { rgba } : {}) });
    }
    parity[arm] = aggregateParityComparisons(comparisons);
  }
  for (const [arm, value] of Object.entries(parity)) {
    if (parityHasMismatch(value, options.parity)) {
      failures.push(`${arm} failed ${options.parity} PNG parity`);
    }
  }

  const summary = {};
  const traces = {};
  for (const arm of arms) {
    summary[arm] = summarizeArm(runsByArm.get(arm));
    const trace = aggregateTrace(runsByArm.get(arm));
    if (trace) traces[arm] = trace;
  }

  for (const arm of arms) {
    for (const run of runsByArm.get(arm)) fs.rmSync(run.outDir, { recursive: true, force: true });
  }

  return {
    scenarioId,
    note: scenario.note,
    parallel: scenario.parallel,
    summary,
    traces,
    parity,
    parityMode: options.parity,
    pairedDeltas: pairedDeltas(runsByArm, arms),
    failures,
    // Kept so output shape can be inspected after the run without re-capturing.
    referenceManifest: (reference?.manifest ?? []).map(entry => ({
      path: entry.path,
      size: `${entry.width}x${entry.height}`,
      bytes: entry.bytes,
    })),
  };
}

function formatReport(result) {
  const lines = [];
  lines.push(`\n=== ${result.scenarioId} (${result.note}, parallel=${result.parallel}) ===`);
  lines.push('arm                    wall p50   wall p95   wall min   cap p50   png    png bytes');
  for (const [arm, value] of Object.entries(result.summary)) {
    lines.push(
      `${arm.padEnd(34)} ${String(value.wallP50Ms).padStart(8)} ${String(value.wallP95Ms).padStart(10)} ` +
        `${String(value.wallMinMs).padStart(10)} ${String(value.captureP50Ms).padStart(9)} ` +
        `${String(value.pngCount).padStart(6)} ${String(value.totalPngBytes).padStart(11)}` +
        (value.shardSpreadP50Ms === undefined
          ? ''
          : `  shardSpread ${value.shardSpreadP50Ms} png/shard ${JSON.stringify(value.shardPngCounts)}`),
    );
  }
  lines.push('paired deltas (median of per-rep differences):');
  for (const [pair, value] of Object.entries(result.pairedDeltas)) {
    lines.push(`  ${pair.padEnd(40)} ${String(value.medianDeltaMs).padStart(8)} ms`);
  }
  const parityIssues = Object.entries(result.parity).filter(([, value]) => parityHasMismatch(value, result.parityMode));
  if (parityIssues.length === 0) {
    lines.push(
      result.parityMode === 'bytes'
        ? 'parity: OK (byte-identical PNG sets across arms)'
        : 'parity: OK (decoded RGBA-identical PNG sets across arms)',
    );
  } else {
    lines.push('parity: MISMATCH');
    for (const [arm, value] of parityIssues) lines.push(`  ${arm}: ${JSON.stringify(value)}`);
  }
  if (result.failures.length > 0) lines.push(`failures: ${result.failures.join('; ')}`);
  for (const [arm, trace] of Object.entries(result.traces)) {
    lines.push(`trace ${arm}: ${JSON.stringify(trace.totals)}`);
    if (Object.keys(trace.rawCdpSends).length > 0) {
      lines.push(`  rawCdpSends ${arm}: ${JSON.stringify(trace.rawCdpSends)}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(workDir, { recursive: true });

  if (options.saveArm) {
    saveArm(options.saveArm);
    return 0;
  }
  if (options.list) {
    process.stdout.write(`arms: ${listArms().join(', ') || '(none)'}\n`);
    process.stdout.write(`scenarios: ${Object.keys(scenarios).join(', ')}\n`);
    return 0;
  }

  const arms = options.arms.length > 0 ? options.arms : listArms();
  if (arms.length === 0) throw new Error('No arms available. Use --save-arm <name> first.');
  const selected = options.scenarios.length > 0 ? options.scenarios : Object.keys(scenarios);

  if (options.memory) {
    const results = [];
    for (const scenarioId of selected) {
      for (const arm of arms) {
        const result = await runMemory(scenarioId, arm);
        results.push(result);
        process.stdout.write(
          `[memory] ${scenarioId} ${arm}  wall ${result.wallMs} ms  ` +
            `sampled peak tree ${result.memory.peakProcessTreeBytes} bytes (${result.memory.samples} samples)  ` +
            `peak node rss ${result.trace?.totals?.peakNodeRssBytes ?? 'n/a'}\n`,
        );
      }
    }
    const memoryPath = path.join(workDir, `memory-${options.tag}.json`);
    fs.writeFileSync(memoryPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    process.stdout.write(`memory report: ${path.relative(repoDir, memoryPath)}\n`);
    return 0;
  }

  process.stdout.write(`arms: ${arms.join(' -> ')}\n`);
  process.stdout.write(`scenarios: ${selected.join(', ')}  reps=${options.reps} warmup=${options.warmup}\n`);
  process.stdout.write(`host: ${os.cpus().length} logical CPUs, node ${process.version}\n`);

  const results = [];
  for (const scenarioId of selected) {
    const result = await runScenario(scenarioId, arms, options);
    results.push(result);
    process.stdout.write(`${formatReport(result)}\n`);
  }

  const reportPath = path.join(workDir, `report-${options.tag}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify({ arms, results }, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nreport: ${path.relative(repoDir, reportPath)}\n`);

  const gateFailures = results.flatMap(result => result.failures);
  return gateFailures.length > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then(
    code => process.exit(code),
    error => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exit(1);
    },
  );
}

module.exports = {
  aggregateParityComparisons,
  buildSchedule,
  combinedFailure,
  findCrossShardDuplicatePaths,
  memoryRunFailures,
  normalizeExitCode,
  parityHasMismatch,
  parseArgs,
  startMemorySampler,
  windowsProcessTreeScript,
};
