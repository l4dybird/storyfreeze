#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { PNG } = require('pngjs');
const { evaluateStoryCaptureGate } = require('./storycapture-performance-gate.js');

const diagnosticPrefix = 'STORYFREEZE_CAPTURE_DIAGNOSTIC=';
const sampleIntervalMs = 50;
const processExitTimeoutMs = 2_000;

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashPath(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return hashBuffer(fs.readFileSync(target));
  const files = [];
  const pending = [target];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === 'node_modules') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(path.relative(target, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readExpectedPaths(config, configDir) {
  if (Array.isArray(config.expectedPngPaths)) return [...new Set(config.expectedPngPaths)].sort();
  if (typeof config.expectedPngPathsFile !== 'string') {
    throw new Error('expectedPngPaths or expectedPngPathsFile is required.');
  }
  const value = fs.readFileSync(path.resolve(configDir, config.expectedPngPathsFile), 'utf8');
  const parsed = value.trimStart().startsWith('[')
    ? JSON.parse(value)
    : value
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new Error('Expected PNG paths must be an array or newline-delimited strings.');
  }
  return [...new Set(parsed.map(item => item.replaceAll('\\', '/')))].sort();
}

function measuredOrder(index, labels, startingLabel = labels[0]) {
  const start = labels.indexOf(startingLabel);
  if (start < 0) throw new Error(`Unknown starting implementation: ${startingLabel}.`);
  const seeded = [...labels.slice(start), ...labels.slice(0, start)];
  return index % 2 === 0 ? seeded : [...seeded].reverse();
}

function replacePlaceholders(value, replacements) {
  return value.replace(/\{(chromiumPath|outDir|storybookUrl)\}/g, (_match, name) => replacements[name]);
}

function commandParallel(args = []) {
  const inline = args.find(argument => argument.startsWith('--parallel='));
  if (inline) return Number(inline.slice('--parallel='.length));
  const index = args.findIndex(argument => argument === '--parallel' || argument === '-p');
  return index < 0 ? undefined : Number(args[index + 1]);
}

function validateImplementation(name, spec, parallel) {
  if (typeof spec?.command !== 'string' || !spec.command) throw new Error(`${name}.command is required.`);
  if (!Array.isArray(spec.args) || !spec.args.every(argument => typeof argument === 'string')) {
    throw new Error(`${name}.args must be an array of strings.`);
  }
  if (typeof spec.packagePath !== 'string' || !spec.packagePath) throw new Error(`${name}.packagePath is required.`);
  if (commandParallel(spec.args) !== parallel) {
    throw new Error(`${name}.args must explicitly set --parallel ${parallel}.`);
  }
}

function listPngs(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.endsWith('.png')) {
        files.push(path.relative(directory, absolute).replaceAll('\\', '/'));
      }
    }
  }
  return files.sort();
}

function comparePngDirectories(leftDir, rightDir, expectedPaths) {
  let mismatchCount = 0;
  for (const relativePath of expectedPaths) {
    const leftPath = path.join(leftDir, relativePath);
    const rightPath = path.join(rightDir, relativePath);
    if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) {
      mismatchCount += 1;
      continue;
    }
    try {
      const left = PNG.sync.read(fs.readFileSync(leftPath));
      const right = PNG.sync.read(fs.readFileSync(rightPath));
      if (left.width !== right.width || left.height !== right.height || !left.data.equals(right.data)) {
        mismatchCount += 1;
      }
    } catch {
      mismatchCount += 1;
    }
  }
  return mismatchCount;
}

function pngVisualHash(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const dimensions = Buffer.allocUnsafe(8);
  dimensions.writeUInt32BE(png.width, 0);
  dimensions.writeUInt32BE(png.height, 4);
  return hashBuffer(Buffer.concat([dimensions, png.data]));
}

function readLinuxProcesses(clockTicksPerSecond) {
  const processes = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      processes.set(pid, {
        cpuMs: ((Number(fields[11]) + Number(fields[12])) * 1000) / clockTicksPerSecond,
        pid,
        ppid: Number(fields[1]),
        rssBytes: Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0) * 1024,
        startedAt: fields[19],
      });
    } catch {
      // A sampled process can exit while /proc is being read.
    }
  }
  return processes;
}

function descendantsOf(processes, rootPid) {
  const ids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes.values()) {
      if (!ids.has(process.pid) && ids.has(process.ppid)) {
        ids.add(process.pid);
        changed = true;
      }
    }
  }
  return [...ids].map(pid => processes.get(pid)).filter(Boolean);
}

function processIdentity(process) {
  return `${process.pid}:${process.startedAt}`;
}

async function waitForObservedProcesses(observed, clockTicksPerSecond) {
  const deadline = Date.now() + processExitTimeoutMs;
  let remaining = [];
  do {
    remaining = [...readLinuxProcesses(clockTicksPerSecond).values()].filter(process =>
      observed.has(processIdentity(process)),
    );
    if (!remaining.length || Date.now() >= deadline) return remaining;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
}

function parseCaptureTime(log, pattern) {
  if (pattern) {
    const match = log.match(new RegExp(pattern, 'g'))?.at(-1)?.match(new RegExp(pattern));
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  const total = [...log.matchAll(/Screenshot was ended successfully in (\d+(?:\.\d+)?) msec/g)].at(-1);
  if (total) return Number(total[1]);
  const captures = [...log.matchAll(/Screenshot stored: .*? in (\d+(?:\.\d+)?) msec\./g)];
  return captures.length ? captures.reduce((sum, match) => sum + Number(match[1]), 0) : null;
}

function parseDiagnostics(log) {
  return log
    .split(/\r?\n/)
    .filter(line => line.startsWith(diagnosticPrefix))
    .map(line => {
      try {
        return JSON.parse(line.slice(diagnosticPrefix.length));
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

function explicitFailureCount(log) {
  return [...log.matchAll(/(?:failed to capture|capture failed|\(error\):)/gi)].length;
}

async function measureCommand({
  implementation,
  label,
  outputDir,
  expectedPaths,
  invalidPngHashes,
  artifactDir,
  configDir,
}) {
  const replacements = {
    chromiumPath: implementation.chromiumPath,
    outDir: outputDir,
    storybookUrl: implementation.storybookUrl,
  };
  const command = replacePlaceholders(implementation.command, replacements);
  const args = (implementation.args ?? []).map(argument => replacePlaceholders(argument, replacements));
  const cwd = path.resolve(configDir, implementation.cwd ?? '.');
  fs.mkdirSync(outputDir, { recursive: true });
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(implementation.env ?? {}) },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const clockTicksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  const observed = new Set();
  const maximumCpu = new Map();
  let peakRssBytes = 0;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => (stdout += chunk));
  child.stderr.on('data', chunk => (stderr += chunk));
  const sample = () => {
    const processes = descendantsOf(readLinuxProcesses(clockTicksPerSecond), child.pid);
    peakRssBytes = Math.max(
      peakRssBytes,
      processes.reduce((sum, process) => sum + process.rssBytes, 0),
    );
    for (const process of processes) {
      const identity = processIdentity(process);
      observed.add(identity);
      maximumCpu.set(identity, Math.max(maximumCpu.get(identity) ?? 0, process.cpuMs));
    }
  };
  const startedAt = process.hrtime.bigint();
  sample();
  const sampler = setInterval(sample, sampleIntervalMs);
  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearInterval(sampler);
  }
  sample();
  const wallTimeMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const residual = await waitForObservedProcesses(observed, clockTicksPerSecond);
  const log = `${stdout}\n${stderr}`.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, `${label}.log`), log);
  const pngs = listPngs(outputDir);
  const pngSet = new Set(pngs);
  const expectedSet = new Set(expectedPaths);
  const storedPaths = [...log.matchAll(/Screenshot stored:\s+(.+?)\s+in\s+\d+(?:\.\d+)?\s+msec\./g)].map(match =>
    match[1].replaceAll('\\', '/'),
  );
  const diagnostics = parseDiagnostics(log);
  const result = {
    captureTimeMs: parseCaptureTime(log, implementation.captureTimePattern),
    cpuTimeMs: [...maximumCpu.values()].reduce((sum, value) => sum + value, 0),
    navigationCount: diagnostics.filter(
      event => event.type === 'capture-phase' && event.phase === 'navigation' && event.state === 'end',
    ).length,
    peakRssBytes,
    sessionGenerationCount: diagnostics.filter(
      event => event.type === 'browser-launch' && event.source === 'coordinator',
    ).length,
    wallTimeMs,
    exitCode: exit.code ?? -1,
    pngCount: pngs.length,
    crashCount: [...log.matchAll(/(?:Target closed|browser process.*crash|Failed to launch the browser)/gi)].length,
    duplicatePngCount: Math.max(0, storedPaths.length - new Set(storedPaths).size),
    failureCount: explicitFailureCount(log),
    invalidPreviewCount: pngs.filter(relativePath =>
      invalidPngHashes.has(pngVisualHash(path.join(outputDir, relativePath))),
    ).length,
    missingPngCount: expectedPaths.filter(relativePath => !pngSet.has(relativePath)).length,
    pixelMismatchCount: 0,
    residualProcessCount: residual.length,
    retryCount: [...log.matchAll(/Retry to screenshot this story after this sequence\./g)].length,
    timeoutCount: [...log.matchAll(/(?:did not become ready|timeout exceeded|TimeoutError)/gi)].length,
    unexpectedPngCount: pngs.filter(relativePath => !expectedSet.has(relativePath)).length,
  };
  return { outputDir, result };
}

function packageMetadata(spec, configDir) {
  const packagePath = path.resolve(configDir, spec.packagePath);
  const metadataPath = fs.statSync(packagePath).isDirectory() ? path.join(packagePath, 'package.json') : undefined;
  const metadata = metadataPath && fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : {};
  return { packageHash: hashPath(packagePath), version: spec.version ?? metadata.version ?? 'unknown' };
}

function validateConfig(config) {
  if (config.schemaVersion !== 1) throw new Error('Record config schemaVersion must be 1.');
  if (config.parallel !== 4) throw new Error('Record config parallel must be 4.');
  if (config.expectedCaptures !== 452) throw new Error('Record config expectedCaptures must be 452.');
  if (typeof config.storybookUrl !== 'string' || !config.storybookUrl) throw new Error('storybookUrl is required.');
  if (typeof config.staticBuildDir !== 'string' || !config.staticBuildDir)
    throw new Error('staticBuildDir is required.');
  if (typeof config.chromiumPath !== 'string' || !config.chromiumPath) throw new Error('chromiumPath is required.');
  if (config.azureImage !== undefined && (typeof config.azureImage !== 'string' || !config.azureImage)) {
    throw new Error('azureImage must be a non-empty string when provided.');
  }
  if (typeof config.rc0?.cpuP50Ms !== 'number' || config.rc0.cpuP50Ms <= 0) {
    throw new Error('rc0.cpuP50Ms must be a positive number.');
  }
  if (typeof config.rc0?.peakRssP50Bytes !== 'number' || config.rc0.peakRssP50Bytes <= 0) {
    throw new Error('rc0.peakRssP50Bytes must be a positive number.');
  }
  if (!Array.isArray(config.invalidPngHashes) || config.invalidPngHashes.length === 0) {
    throw new Error('invalidPngHashes must contain at least one decoded No Preview/error-page hash.');
  }
  if (!config.implementations?.storycapture || !config.implementations?.storyfreeze) {
    throw new Error('Both storycapture and storyfreeze command specifications are required.');
  }
  for (const [name, spec] of Object.entries(config.implementations)) {
    validateImplementation(name, spec, config.parallel);
  }
  if (config.noRecycleExperiment !== undefined) {
    for (const name of ['default128', 'unlimited']) {
      const variant = config.noRecycleExperiment[name];
      if (!variant || typeof variant !== 'object') {
        throw new Error(`noRecycleExperiment.${name} is required.`);
      }
      validateImplementation(
        `noRecycleExperiment.${name}`,
        { ...config.implementations.storyfreeze, ...variant },
        config.parallel,
      );
    }
  }
}

async function recordComparison(config, { configDir, outputFile }) {
  validateConfig(config);
  if (process.platform !== 'linux') throw new Error('The representative performance recorder requires Linux /proc.');
  const expectedPaths = readExpectedPaths(config, configDir);
  if (expectedPaths.length !== config.expectedCaptures) {
    throw new Error(
      `Expected path contract must contain ${config.expectedCaptures} unique PNGs, got ${expectedPaths.length}.`,
    );
  }
  const invalidPngHashes = new Set(config.invalidPngHashes ?? []);
  const staticBuildDir = path.resolve(configDir, config.staticBuildDir);
  const chromiumPath = path.resolve(configDir, config.chromiumPath);
  if (!fs.existsSync(staticBuildDir)) throw new Error(`Static build does not exist: ${staticBuildDir}`);
  if (!fs.existsSync(chromiumPath)) throw new Error(`Chromium does not exist: ${chromiumPath}`);
  for (const [name, spec] of Object.entries(config.implementations)) {
    const packagePath = path.resolve(configDir, spec.packagePath);
    if (!fs.existsSync(packagePath)) throw new Error(`${name} package does not exist: ${packagePath}`);
  }
  const storycaptureMetadata = packageMetadata(config.implementations.storycapture, configDir);
  const storyfreezeMetadata = packageMetadata(config.implementations.storyfreeze, configDir);
  const storyfreezeCommit = config.storyfreezeCommit ?? process.env.BUILD_SOURCEVERSION;
  const storyfreezeTree = config.storyfreezeTree ?? process.env.STORYFREEZE_BENCHMARK_TREE;
  const azureImage =
    config.azureImage ??
    [process.env.AGENT_OS ?? process.env.ImageOS, process.env.ImageVersion].filter(Boolean).join('@');
  if (!storyfreezeCommit || !storyfreezeTree) {
    throw new Error('storyfreezeCommit and storyfreezeTree are required for a representative record.');
  }
  if (!azureImage || azureImage.toLowerCase().includes('unknown')) {
    throw new Error('azureImage or the Azure hosted-image environment metadata is required.');
  }
  if ([storycaptureMetadata.version, storyfreezeMetadata.version].some(value => value === 'unknown')) {
    throw new Error('Both implementation versions must be available from package metadata or config.');
  }
  const chromium = execFileSync(chromiumPath, ['--version'], { encoding: 'utf8' }).trim();
  if (!chromium) throw new Error(`Unable to read the Chromium version from ${chromiumPath}.`);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-storycapture-record-'));
  const artifactDir = `${outputFile}.artifacts`;
  const implementations = Object.fromEntries(
    Object.entries(config.implementations).map(([name, spec]) => [
      name,
      {
        ...spec,
        chromiumPath,
        storybookUrl: spec.storybookUrl ?? config.storybookUrl,
        env: {
          CI: 'true',
          FORCE_COLOR: '0',
          ...(name === 'storyfreeze' ? { STORYFREEZE_CAPTURE_DIAGNOSTICS: '1' } : {}),
          ...(spec.env ?? {}),
        },
      },
    ]),
  );
  const runImplementation = (implementation, label) =>
    measureCommand({
      implementation,
      label,
      outputDir: path.join(temporaryRoot, label),
      expectedPaths,
      invalidPngHashes,
      artifactDir,
      configDir,
    });
  const run = (name, label) => runImplementation(implementations[name], label);
  try {
    const warmupOrder = measuredOrder(0, ['storycapture', 'storyfreeze'], config.startingImplementation);
    for (const name of warmupOrder) await run(name, `warmup-${name}`);
    const pairs = [];
    for (let index = 0; index < 5; index += 1) {
      const order = measuredOrder(index, ['storycapture', 'storyfreeze'], config.startingImplementation);
      const measured = {};
      for (const name of order) measured[name] = await run(name, `pair-${index + 1}-${name}`);
      const pixelMismatchCount = comparePngDirectories(
        measured.storycapture.outputDir,
        measured.storyfreeze.outputDir,
        expectedPaths,
      );
      measured.storycapture.result.pixelMismatchCount = pixelMismatchCount;
      measured.storyfreeze.result.pixelMismatchCount = pixelMismatchCount;
      pairs.push({
        order,
        storycapture: measured.storycapture.result,
        storyfreeze: measured.storyfreeze.result,
      });
    }
    const options = {
      parallel: config.parallel,
      storybookUrl: config.storybookUrl,
      storycapture: config.implementations.storycapture.args,
      storyfreeze: config.implementations.storyfreeze.args,
    };
    const record = {
      schemaVersion: 1,
      kind: 'storycapture-performance-comparison',
      recordedAt: new Date().toISOString(),
      scenario: {
        azureImage,
        chromium,
        expectedCaptures: config.expectedCaptures,
        options,
        optionsHash: hashBuffer(Buffer.from(JSON.stringify(options))),
        parallel: config.parallel,
        staticBuildHash: hashPath(staticBuildDir),
      },
      storycapture: storycaptureMetadata,
      storyfreeze: {
        ...storyfreezeMetadata,
        commit: storyfreezeCommit,
        tree: storyfreezeTree,
      },
      rc0: config.rc0,
      pairs,
    };
    const initialEvaluation = evaluateStoryCaptureGate(record);
    if (initialEvaluation.gate.passed && config.noRecycleExperiment) {
      const experiment = config.noRecycleExperiment;
      const variants = ['default128', 'unlimited'];
      record.noRecycleOptions = Object.fromEntries(variants.map(name => [name, experiment[name].args]));
      record.noRecyclePairs = [];
      for (let index = 0; index < 3; index += 1) {
        const order = measuredOrder(index, variants, experiment.startingImplementation);
        const measured = {};
        for (const name of order) {
          measured[name] = await runImplementation(
            {
              ...implementations.storyfreeze,
              ...experiment[name],
              chromiumPath,
              storybookUrl: config.storybookUrl,
              env: { ...implementations.storyfreeze.env, ...(experiment[name].env ?? {}) },
            },
            `no-recycle-${index + 1}-${name}`,
          );
        }
        const pixelMismatchCount = comparePngDirectories(
          measured.default128.outputDir,
          measured.unlimited.outputDir,
          expectedPaths,
        );
        measured.default128.result.pixelMismatchCount = pixelMismatchCount;
        measured.unlimited.result.pixelMismatchCount = pixelMismatchCount;
        record.noRecyclePairs.push({
          order,
          default128: measured.default128.result,
          unlimited: measured.unlimited.result,
        });
      }
    }
    return { evaluation: evaluateStoryCaptureGate(record), record };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const configPath = process.argv[2];
  const outputPath = process.argv[3];
  if (configPath === '--hash-png') {
    if (!outputPath) throw new Error('Usage: node scripts/storycapture-performance-record.js --hash-png <file.png>');
    process.stdout.write(`${pngVisualHash(path.resolve(outputPath))}\n`);
    return;
  }
  if (!configPath || !outputPath) {
    throw new Error('Usage: node scripts/storycapture-performance-record.js <config.json> <record.json>');
  }
  const absoluteConfig = path.resolve(configPath);
  const outputFile = path.resolve(outputPath);
  const config = JSON.parse(fs.readFileSync(absoluteConfig, 'utf8'));
  const result = await recordComparison(config, { configDir: path.dirname(absoluteConfig), outputFile });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(result.record, null, 2)}\n`);
  fs.writeFileSync(`${outputFile}.evaluation.json`, `${JSON.stringify(result.evaluation, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result.evaluation, null, 2)}\n`);
  if (!result.evaluation.gate.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  comparePngDirectories,
  hashPath,
  measuredOrder,
  parseCaptureTime,
  pngVisualHash,
  readExpectedPaths,
  validateConfig,
};
