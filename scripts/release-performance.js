#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { PNG } = require('pngjs');

const sampleIntervalMs = 50;
const processExitGraceMs = 2_000;
const requiredZeroFields = [
  'cleanupErrorCount',
  'crashCount',
  'dimensionMismatchCount',
  'duplicatePngCount',
  'failureCount',
  'invalidPreviewCount',
  'missingPngCount',
  'residualProcessCount',
  'retryExhaustionCount',
  'rgbaMismatchCount',
  'timeoutCount',
  'unexpectedPngCount',
  'unreadablePngCount',
];

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashPath(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return hashBuffer(fs.readFileSync(target));
  const files = [];
  const pending = [target];
  while (pending.length > 0) {
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

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function ratio(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : null;
}

function summarize(runs) {
  return {
    runs: runs.length,
    wallP50Ms: percentile(
      runs.map(run => run.wallTimeMs),
      0.5,
    ),
    wallP95Ms: percentile(
      runs.map(run => run.wallTimeMs),
      0.95,
    ),
    captureP50Ms: percentile(
      runs.map(run => run.captureTimeMs),
      0.5,
    ),
    captureP95Ms: percentile(
      runs.map(run => run.captureTimeMs),
      0.95,
    ),
    cpuP50Ms: percentile(
      runs.map(run => run.cpuTimeMs),
      0.5,
    ),
    peakRssP50Bytes: percentile(
      runs.map(run => run.peakRssBytes),
      0.5,
    ),
  };
}

function measuredOrder(index, labels, startingLabel = labels[0]) {
  const start = labels.indexOf(startingLabel);
  if (start < 0) throw new Error(`Unknown starting implementation: ${startingLabel}.`);
  const seeded = [...labels.slice(start), ...labels.slice(0, start)];
  return index % 2 === 0 ? seeded : [...seeded].reverse();
}

function buildSchedule(starting = {}) {
  const schedule = [
    { comparison: 'candidateRc', implementation: 'rc', kind: 'warmup', label: 'candidate-rc-warmup-rc' },
    {
      comparison: 'candidateRc',
      implementation: 'candidate',
      kind: 'warmup',
      label: 'candidate-rc-warmup-candidate',
    },
  ];
  for (let index = 0; index < 5; index += 1) {
    for (const implementation of measuredOrder(index, ['candidate', 'rc'], starting.candidateRc ?? 'candidate')) {
      schedule.push({
        comparison: 'candidateRc',
        implementation,
        kind: 'measured',
        label: `candidate-rc-pair-${index + 1}-${implementation}`,
        pair: index + 1,
      });
    }
  }
  schedule.push(
    {
      comparison: 'candidateStoryCapture',
      implementation: 'storycapture',
      kind: 'warmup',
      label: 'candidate-storycapture-warmup-storycapture',
    },
    {
      comparison: 'candidateStoryCapture',
      implementation: 'candidate',
      kind: 'warmup',
      label: 'candidate-storycapture-warmup-candidate',
    },
  );
  for (let index = 0; index < 5; index += 1) {
    for (const implementation of measuredOrder(
      index,
      ['candidate', 'storycapture'],
      starting.candidateStoryCapture ?? 'storycapture',
    )) {
      schedule.push({
        comparison: 'candidateStoryCapture',
        implementation,
        kind: 'measured',
        label: `candidate-storycapture-pair-${index + 1}-${implementation}`,
        pair: index + 1,
      });
    }
  }
  return schedule;
}

function replacePlaceholders(value, replacements) {
  return value.replace(/\{(chromiumPath|outDir|storybookUrl)\}/g, (_match, key) => replacements[key]);
}

function commandParallel(args) {
  const inline = args.find(argument => argument.startsWith('--parallel='));
  if (inline) return Number(inline.slice('--parallel='.length));
  const index = args.findIndex(argument => argument === '--parallel' || argument === '-p');
  return index < 0 ? undefined : Number(args[index + 1]);
}

function validateImplementation(name, implementation, parallel) {
  if (implementation?.command !== undefined) {
    throw new Error(
      `implementations.${name}.command is not supported; the release runner executes the CLI declared by the measured package.`,
    );
  }
  if (!Array.isArray(implementation?.args) || !implementation.args.every(value => typeof value === 'string')) {
    throw new Error(`implementations.${name}.args must be an array of strings.`);
  }
  if (commandParallel(implementation.args) !== parallel) {
    throw new Error(`implementations.${name}.args must explicitly set --parallel ${parallel}.`);
  }
  const template = implementation.args.join('\0');
  for (const placeholder of ['{chromiumPath}', '{outDir}', '{storybookUrl}']) {
    if (!template.includes(placeholder)) {
      throw new Error(`implementations.${name} must include ${placeholder}.`);
    }
  }
  if (name === 'candidate') {
    if (implementation.packagePath !== undefined || implementation.version !== undefined) {
      throw new Error('implementations.candidate packagePath and version are derived from repositoryDir HEAD.');
    }
  } else {
    for (const field of ['packagePath', 'version']) {
      if (typeof implementation[field] !== 'string' || implementation[field].length === 0) {
        throw new Error(`implementations.${name}.${field} is required.`);
      }
    }
  }
  if (
    implementation.binName !== undefined &&
    (typeof implementation.binName !== 'string' || implementation.binName.length === 0)
  ) {
    throw new Error(`implementations.${name}.binName must be a string when provided.`);
  }
  if (implementation.captureTimePattern !== undefined && typeof implementation.captureTimePattern !== 'string') {
    throw new Error(`implementations.${name}.captureTimePattern must be a string.`);
  }
  if (implementation.captureTimePattern) {
    try {
      new RegExp(implementation.captureTimePattern);
    } catch (error) {
      throw new Error(`implementations.${name}.captureTimePattern is invalid: ${error.message}`);
    }
  }
}

function candidateWorkspaceStatus(repositoryDir) {
  const tracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: repositoryDir,
    encoding: 'utf8',
  });
  const packageUntracked = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--', 'packages/storyfreeze'],
    { cwd: repositoryDir, encoding: 'utf8' },
  );
  return `${tracked}${packageUntracked}`.trim();
}

function packCandidatePackage(
  repositoryDir,
  packageWorkspace,
  buildCandidate = directory =>
    execFileSync('pnpm', ['--filter', 'storyfreeze', 'build'], {
      cwd: directory,
      maxBuffer: 20 * 1024 * 1024,
      stdio: 'pipe',
    }),
) {
  const before = candidateWorkspaceStatus(repositoryDir);
  if (before) throw new Error(`repositoryDir must be clean before packing the candidate:\n${before}`);
  buildCandidate(repositoryDir);
  const afterBuild = candidateWorkspaceStatus(repositoryDir);
  if (afterBuild) throw new Error(`Candidate build changed tracked package inputs:\n${afterBuild}`);
  fs.mkdirSync(packageWorkspace, { recursive: true });
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packageWorkspace], {
      cwd: path.join(repositoryDir, 'packages', 'storyfreeze'),
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    }),
  );
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== 'string') {
    throw new Error('npm pack did not produce exactly one candidate archive.');
  }
  const packageArchivePath = path.resolve(packageWorkspace, packed[0].filename);
  if (!fs.statSync(packageArchivePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`npm pack did not create the reported candidate archive: ${packageArchivePath}`);
  }
  return packageArchivePath;
}

function resolvePackageExecutable(packageRoot, metadata, requestedBinName) {
  const declared = metadata?.bin;
  let entries;
  if (typeof declared === 'string') {
    if (typeof metadata.name !== 'string' || metadata.name.length === 0) {
      throw new Error('The package must declare a name when bin is a string.');
    }
    entries = [[metadata.name, declared]];
  } else if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
    entries = Object.entries(declared).filter(
      ([name, target]) =>
        typeof name === 'string' && name.length > 0 && typeof target === 'string' && target.length > 0,
    );
  } else {
    entries = [];
  }
  if (entries.length === 0) throw new Error('The package does not declare an executable bin.');

  const selectedName =
    requestedBinName ??
    (typeof metadata.name === 'string' && entries.some(([name]) => name === metadata.name)
      ? metadata.name
      : entries.length === 1
        ? entries[0][0]
        : undefined);
  const selected = entries.find(([name]) => name === selectedName);
  if (!selected) {
    throw new Error(
      `Unable to select package bin${requestedBinName ? ` ${JSON.stringify(requestedBinName)}` : ''}; declared bins: ${entries
        .map(([name]) => name)
        .join(', ')}.`,
    );
  }

  const executablePath = path.resolve(packageRoot, selected[1]);
  const relative = path.relative(packageRoot, executablePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Package bin ${JSON.stringify(selected[1])} resolves outside the extracted package.`);
  }
  if (!fs.statSync(executablePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Package bin does not exist: ${executablePath}`);
  }
  return {
    binName: selected[0],
    binPath: relative.replaceAll('\\', '/'),
    executablePath,
  };
}

function prepareImplementationPackage(
  name,
  implementation,
  configDir,
  packageWorkspace,
  { dependencyLockArtifactPath, npmBefore, packageArchivePath: explicitPackageArchivePath } = {},
) {
  if (typeof npmBefore !== 'string' || !Number.isFinite(Date.parse(npmBefore))) {
    throw new Error('prepareImplementationPackage requires a shared npmBefore timestamp.');
  }
  const packageArchivePath = explicitPackageArchivePath ?? path.resolve(configDir, implementation.packagePath);
  if (
    !packageArchivePath.toLowerCase().endsWith('.tgz') ||
    !fs.statSync(packageArchivePath, { throwIfNoEntry: false })?.isFile()
  ) {
    throw new Error(`implementations.${name}.packagePath must be an existing npm .tgz archive: ${packageArchivePath}`);
  }
  const archiveRoot = path.join(packageWorkspace, 'archive');
  const consumerRoot = path.join(packageWorkspace, 'consumer');
  fs.mkdirSync(archiveRoot, { recursive: true });
  execFileSync(
    'tar',
    ['-xzf', packageArchivePath, '--strip-components=1', '--no-same-owner', '--no-same-permissions', '-C', archiveRoot],
    { stdio: 'pipe' },
  );
  const metadataPath = path.join(archiveRoot, 'package.json');
  if (!fs.statSync(metadataPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`implementations.${name}.packagePath is not an npm package archive.`);
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (typeof metadata.name !== 'string' || metadata.name.length === 0) {
    throw new Error(`implementations.${name}.packagePath does not declare a package name.`);
  }
  if (implementation.version !== undefined && metadata.version !== implementation.version) {
    throw new Error(
      `implementations.${name}.version ${JSON.stringify(implementation.version)} does not match package metadata ${JSON.stringify(metadata.version)}.`,
    );
  }
  fs.mkdirSync(consumerRoot, { recursive: true });
  fs.writeFileSync(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify({
      name: `storyfreeze-release-${name}`,
      private: true,
      dependencies: { [metadata.name]: `file:${packageArchivePath}` },
    })}\n`,
  );
  execFileSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
      `--before=${npmBefore}`,
    ],
    { cwd: consumerRoot, maxBuffer: 20 * 1024 * 1024, stdio: 'pipe' },
  );
  const dependencyLockPath = path.join(consumerRoot, 'package-lock.json');
  if (!fs.statSync(dependencyLockPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Unable to create the dependency lock for implementations.${name}.`);
  }
  execFileSync('npm', ['ci', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], {
    cwd: consumerRoot,
    maxBuffer: 20 * 1024 * 1024,
    stdio: 'pipe',
  });
  if (dependencyLockArtifactPath) {
    fs.mkdirSync(path.dirname(dependencyLockArtifactPath), { recursive: true });
    fs.copyFileSync(dependencyLockPath, dependencyLockArtifactPath);
  }
  const nodeModulesRoot = path.resolve(consumerRoot, 'node_modules');
  const installedPackageRoot = path.resolve(nodeModulesRoot, ...metadata.name.split('/'));
  const installedRelative = path.relative(nodeModulesRoot, installedPackageRoot);
  if (!installedRelative || installedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(installedRelative)) {
    throw new Error(`implementations.${name}.packagePath declares an invalid package name.`);
  }
  const installedMetadata = JSON.parse(fs.readFileSync(path.join(installedPackageRoot, 'package.json'), 'utf8'));
  if (installedMetadata.name !== metadata.name || installedMetadata.version !== metadata.version) {
    throw new Error(`implementations.${name}.packagePath installed metadata does not match the inspected archive.`);
  }
  const executable = resolvePackageExecutable(installedPackageRoot, installedMetadata, implementation.binName);
  return {
    ...implementation,
    command: process.execPath,
    commandPrefixArgs: [executable.executablePath],
    packageArchivePath,
    packageHash: hashPath(packageArchivePath),
    packageName: metadata.name,
    packageBinName: executable.binName,
    packageBinPath: executable.binPath,
    dependencyLockHash: hashPath(dependencyLockPath),
    version: metadata.version,
  };
}

function validateConfig(config) {
  if (config.schemaVersion !== 1) throw new Error('Release performance config schemaVersion must be 1.');
  if (config.parallel !== 4) throw new Error('Release performance parallel must be 4.');
  if (config.expectedCaptures !== 452) throw new Error('Release performance expectedCaptures must be 452.');
  for (const field of ['azureImage', 'chromiumPath', 'staticBuildDir', 'storybookUrl']) {
    if (typeof config[field] !== 'string' || config[field].length === 0) throw new Error(`${field} is required.`);
  }
  if (!Number.isFinite(config.commandTimeoutMs) || config.commandTimeoutMs <= 0) {
    throw new Error('commandTimeoutMs must be a positive finite number.');
  }
  if (!Array.isArray(config.invalidPngHashes) || config.invalidPngHashes.length === 0) {
    throw new Error('invalidPngHashes must include a decoded No Preview or render-error image hash.');
  }
  if (config.invalidPngHashes.some(value => !/^[0-9a-f]{64}$/i.test(value))) {
    throw new Error('invalidPngHashes values must be SHA-256 hashes.');
  }
  for (const name of ['candidate', 'rc', 'storycapture']) {
    validateImplementation(name, config.implementations?.[name], config.parallel);
  }
  if (config.implementations.rc.version !== '0.2.0-rc.2') {
    throw new Error('implementations.rc.version must be 0.2.0-rc.2.');
  }
  for (const name of ['candidate', 'rc']) {
    for (const field of ['commit', 'tree']) {
      const value = config.implementations[name][field];
      if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
        throw new Error(`implementations.${name}.${field} must be a full Git SHA.`);
      }
    }
  }
  for (const [comparison, allowed] of Object.entries({
    candidateRc: ['candidate', 'rc'],
    candidateStoryCapture: ['candidate', 'storycapture'],
  })) {
    const value = config.starting?.[comparison];
    if (value !== undefined && !allowed.includes(value)) {
      throw new Error(`starting.${comparison} must be ${allowed.join(' or ')}.`);
    }
  }
}

function listPngs(directory) {
  if (!fs.existsSync(directory)) return [];
  const paths = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) paths.push(absolute);
    }
  }
  return paths.sort();
}

function inspectPngDirectory(directory) {
  const manifest = [];
  const unreadable = [];
  for (const file of listPngs(directory)) {
    const relativePath = path.relative(directory, file).replaceAll('\\', '/');
    try {
      const png = PNG.sync.read(fs.readFileSync(file));
      manifest.push({
        path: relativePath,
        width: png.width,
        height: png.height,
        rgbaSha256: hashBuffer(png.data),
        visualSha256: hashBuffer(Buffer.concat([Buffer.from(`${png.width}x${png.height}\0`), png.data])),
      });
    } catch (error) {
      unreadable.push({ path: relativePath, message: String(error?.message ?? error) });
    }
  }
  return { manifest, unreadable };
}

function compareManifests(reference, actual) {
  const expected = new Map(reference.map(entry => [entry.path, entry]));
  const observed = new Map(actual.map(entry => [entry.path, entry]));
  let dimensionMismatchCount = 0;
  let rgbaMismatchCount = 0;
  for (const [relativePath, expectedEntry] of expected) {
    const actualEntry = observed.get(relativePath);
    if (!actualEntry) continue;
    if (expectedEntry.width !== actualEntry.width || expectedEntry.height !== actualEntry.height) {
      dimensionMismatchCount += 1;
    }
    if (expectedEntry.rgbaSha256 !== actualEntry.rgbaSha256) rgbaMismatchCount += 1;
  }
  return {
    missingPngCount: [...expected.keys()].filter(relativePath => !observed.has(relativePath)).length,
    unexpectedPngCount: [...observed.keys()].filter(relativePath => !expected.has(relativePath)).length,
    dimensionMismatchCount,
    rgbaMismatchCount,
  };
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
        pid,
        ppid: Number(fields[1]),
        cpuMs: ((Number(fields[11]) + Number(fields[12])) * 1000) / clockTicksPerSecond,
        rssBytes: Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0) * 1024,
        startedAt: fields[19],
      });
    } catch {
      // A process can exit between the directory, stat, and status reads.
    }
  }
  return processes;
}

function descendantsOf(processes, rootPid) {
  const identifiers = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes.values()) {
      if (!identifiers.has(process.pid) && identifiers.has(process.ppid)) {
        identifiers.add(process.pid);
        changed = true;
      }
    }
  }
  return [...identifiers].map(pid => processes.get(pid)).filter(Boolean);
}

function processIdentity(process) {
  return `${process.pid}:${process.startedAt}`;
}

async function waitForObservedProcesses(observed, clockTicksPerSecond, timeoutMs = processExitGraceMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = [...readLinuxProcesses(clockTicksPerSecond).values()].filter(process =>
      observed.has(processIdentity(process)),
    );
    if (remaining.length === 0 || Date.now() >= deadline) return remaining;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function signalProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function createLogInspector(captureTimePattern) {
  const pending = new Map();
  const storedPaths = new Set();
  let captureDurationSum = 0;
  let captureDurationCount = 0;
  let customCaptureTime;
  let totalCaptureTime;
  let retryCount = 0;
  let crashCount = 0;
  let duplicatePngCount = 0;
  let failureCount = 0;
  let retryExhaustionLogCount = 0;
  let timeoutLogCount = 0;

  const inspectLine = line => {
    if (captureTimePattern) {
      for (const match of line.matchAll(new RegExp(captureTimePattern, 'g'))) {
        if (match[1] !== undefined && Number.isFinite(Number(match[1]))) customCaptureTime = Number(match[1]);
      }
    }
    for (const match of line.matchAll(/Screenshot was ended successfully in (\d+(?:\.\d+)?) msec/g)) {
      totalCaptureTime = Number(match[1]);
    }
    for (const match of line.matchAll(/Screenshot stored:\s+(.+?)\s+in\s+(\d+(?:\.\d+)?)\s+msec\./g)) {
      const outputPath = match[1].replaceAll('\\', '/');
      if (storedPaths.has(outputPath)) duplicatePngCount += 1;
      storedPaths.add(outputPath);
      captureDurationSum += Number(match[2]);
      captureDurationCount += 1;
    }
    retryCount += countMatches(line, /Retry to screenshot this story after this sequence\./g);
    crashCount += countMatches(line, /(?:Target closed|browser process.*crash|Failed to launch)/gi);
    failureCount += countMatches(line, /(?:failed to capture|capture failed|\(error\):)/gi);
    retryExhaustionLogCount += countMatches(line, /(?:retry budget exhausted|failed after \d+ retries)/gi);
    timeoutLogCount += countMatches(line, /(?:did not become ready|deadline exceeded|TimeoutError)/gi);
  };

  return {
    push(source, value) {
      const lines = `${pending.get(source) ?? ''}${value}`.split(/\r\n|\n|\r/);
      pending.set(source, lines.pop() ?? '');
      for (const line of lines) inspectLine(line);
    },
    finish() {
      for (const value of pending.values()) {
        if (value) inspectLine(value);
      }
      pending.clear();
      return {
        captureTimeMs: customCaptureTime ?? totalCaptureTime ?? (captureDurationCount > 0 ? captureDurationSum : null),
        crashCount,
        duplicatePngCount,
        failureCount,
        retryCount,
        retryExhaustionLogCount,
        timeoutLogCount,
      };
    },
  };
}

async function measureCommand({
  implementation,
  replacements,
  outputDir,
  artifactDir,
  label,
  commandTimeoutMs,
  clockTicksPerSecond,
  invalidPngHashes,
}) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  const command = implementation.command;
  const args = [
    ...implementation.commandPrefixArgs,
    ...implementation.args.map(value => replacePlaceholders(value, replacements)),
  ];
  const logPath = path.join(artifactDir, `${label}.log`);
  const logStream = fs.createWriteStream(logPath, { encoding: 'utf8' });
  const child = spawn(command, args, {
    cwd: implementation.cwd,
    detached: true,
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0', ...(implementation.env ?? {}) },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logInspector = createLogInspector(implementation.captureTimePattern);
  const captureChunk = source => value => {
    logInspector.push(source, value);
    logStream.write(value);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', captureChunk('stdout'));
  child.stderr.on('data', captureChunk('stderr'));

  const observed = new Set();
  const maximumCpu = new Map();
  let peakRssBytes = 0;
  const sample = () => {
    if (!child.pid) return;
    const descendants = descendantsOf(readLinuxProcesses(clockTicksPerSecond), child.pid);
    peakRssBytes = Math.max(
      peakRssBytes,
      descendants.reduce((total, process) => total + process.rssBytes, 0),
    );
    for (const process of descendants) {
      const identity = processIdentity(process);
      observed.add(identity);
      maximumCpu.set(identity, Math.max(maximumCpu.get(identity) ?? 0, process.cpuMs));
    }
  };

  const startedAt = process.hrtime.bigint();
  sample();
  const sampler = setInterval(sample, sampleIntervalMs);
  let timedOut = false;
  let killTimer;
  const signalErrors = [];
  const signalGroup = signal => {
    try {
      signalProcessGroup(child.pid, signal);
    } catch (groupError) {
      signalErrors.push(String(groupError?.message ?? groupError));
      try {
        child.kill(signal);
      } catch (childError) {
        if (childError?.code !== 'ESRCH') signalErrors.push(String(childError?.message ?? childError));
      }
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), processExitGraceMs);
  }, commandTimeoutMs);
  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(killTimer);
    clearInterval(sampler);
    sample();
    await new Promise(resolve => logStream.end(resolve));
  }

  const wallTimeMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const residual = await waitForObservedProcesses(observed, clockTicksPerSecond);
  if (residual.length > 0) {
    signalGroup('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 250));
    signalGroup('SIGKILL');
    for (const residualProcess of residual) {
      try {
        process.kill(residualProcess.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') signalErrors.push(String(error?.message ?? error));
      }
    }
  }
  const inspection = inspectPngDirectory(outputDir);
  const inspectedLog = logInspector.finish();
  return {
    captureTimeMs: inspectedLog.captureTimeMs,
    cpuTimeMs: [...maximumCpu.values()].reduce((total, value) => total + value, 0),
    peakRssBytes,
    wallTimeMs,
    exitCode: exit.code ?? -1,
    exitSignal: exit.signal,
    cleanupErrorCount: signalErrors.length,
    crashCount: inspectedLog.crashCount,
    duplicatePngCount: inspectedLog.duplicatePngCount,
    failureCount: inspectedLog.failureCount,
    invalidPreviewCount: inspection.manifest.filter(entry => invalidPngHashes.has(entry.visualSha256)).length,
    residualProcessCount: residual.length,
    retryCount: inspectedLog.retryCount,
    retryExhaustionCount: Number(inspectedLog.retryCount > 0 && exit.code !== 0) + inspectedLog.retryExhaustionLogCount,
    timeoutCount: Number(timedOut) + inspectedLog.timeoutLogCount,
    unreadablePngCount: inspection.unreadable.length,
    pngCount: inspection.manifest.length,
    manifestSha256: hashBuffer(Buffer.from(JSON.stringify(inspection.manifest))),
    manifest: inspection.manifest,
    logPath,
  };
}

function validateRun(run, label, expectedCaptures, referenceManifestHash, errors) {
  for (const field of ['captureTimeMs', 'cpuTimeMs', 'peakRssBytes', 'wallTimeMs']) {
    if (!Number.isFinite(run?.[field]) || run[field] <= 0) errors.push(`${label}.${field} must be positive.`);
  }
  if (run?.exitCode !== 0) errors.push(`${label}.exitCode must be zero, got ${run?.exitCode}.`);
  if (run?.pngCount !== expectedCaptures) {
    errors.push(`${label}.pngCount expected ${expectedCaptures}, got ${run?.pngCount}.`);
  }
  if (!Number.isSafeInteger(run?.retryCount) || run.retryCount < 0) {
    errors.push(`${label}.retryCount must be a non-negative integer.`);
  }
  if (!/^[0-9a-f]{64}$/i.test(run?.manifestSha256 ?? '')) {
    errors.push(`${label}.manifestSha256 must be a SHA-256 hash.`);
  } else if (run.manifestSha256 !== referenceManifestHash) {
    errors.push(`${label}.manifestSha256 does not match the RC.2 reference.`);
  }
  if (typeof run?.logPath !== 'string' || run.logPath.length === 0) {
    errors.push(`${label}.logPath is required.`);
  }
  for (const field of requiredZeroFields) {
    if (run?.[field] !== 0) errors.push(`${label}.${field} must be zero, got ${run?.[field]}.`);
  }
}

function evaluateRecord(record) {
  const errors = [];
  if (record?.schemaVersion !== 1 || record?.kind !== 'storyfreeze-release-performance') {
    errors.push('Expected storyfreeze-release-performance schema version 1.');
  }
  const expectedCaptures = record?.scenario?.expectedCaptures;
  if (expectedCaptures !== 452) errors.push(`Expected 452 captures, got ${expectedCaptures}.`);
  if (record?.scenario?.parallel !== 4) errors.push(`Expected parallel 4, got ${record?.scenario?.parallel}.`);
  for (const field of ['azureImage', 'chromium', 'node']) {
    if (typeof record?.scenario?.[field] !== 'string' || record.scenario[field].length === 0) {
      errors.push(`scenario.${field} is required.`);
    }
  }
  const npmBefore = Date.parse(record?.scenario?.npmBefore ?? '');
  const recordedAt = Date.parse(record?.recordedAt ?? '');
  if (!Number.isFinite(npmBefore)) {
    errors.push('scenario.npmBefore must be an ISO timestamp.');
  } else if (!Number.isFinite(recordedAt) || npmBefore > recordedAt - 24 * 60 * 60 * 1_000) {
    errors.push('scenario.npmBefore must be at least 24 hours before recordedAt.');
  }
  for (const field of ['optionsHash', 'staticBuildHash']) {
    if (!/^[0-9a-f]{64}$/i.test(record?.scenario?.[field] ?? '')) {
      errors.push(`scenario.${field} must be a SHA-256 hash.`);
    }
  }
  if (!record?.scenario?.options || typeof record.scenario.options !== 'object') {
    errors.push('scenario.options is required.');
  }
  if (!Array.isArray(record?.scenario?.invalidPngHashes) || record.scenario.invalidPngHashes.length === 0) {
    errors.push('scenario.invalidPngHashes is required.');
  } else if (record.scenario.invalidPngHashes.some(value => !/^[0-9a-f]{64}$/i.test(value))) {
    errors.push('scenario.invalidPngHashes values must be SHA-256 hashes.');
  }
  for (const name of ['candidate', 'rc', 'storycapture']) {
    const implementation = record?.implementations?.[name];
    for (const field of ['binName', 'binPath', 'packageName', 'version']) {
      if (typeof implementation?.[field] !== 'string' || implementation[field].length === 0) {
        errors.push(`implementations.${name}.${field} is required.`);
      }
    }
    if (!/^[0-9a-f]{64}$/i.test(implementation?.packageHash ?? '')) {
      errors.push(`implementations.${name}.packageHash must be a SHA-256 hash.`);
    }
    if (!/^[0-9a-f]{64}$/i.test(implementation?.dependencyLockHash ?? '')) {
      errors.push(`implementations.${name}.dependencyLockHash must be a SHA-256 hash.`);
    }
    if (
      typeof implementation?.dependencyLockArtifact !== 'string' ||
      !/^dependencies\/[a-z0-9-]+-package-lock\.json$/i.test(implementation.dependencyLockArtifact)
    ) {
      errors.push(`implementations.${name}.dependencyLockArtifact must identify its recorded lockfile.`);
    }
    if (name !== 'storycapture') {
      for (const field of ['commit', 'tree']) {
        if (!/^[0-9a-f]{40}$/i.test(implementation?.[field] ?? '')) {
          errors.push(`implementations.${name}.${field} must be a full Git SHA.`);
        }
      }
    }
  }
  if (record?.implementations?.rc?.version !== '0.2.0-rc.2') {
    errors.push('implementations.rc.version must be 0.2.0-rc.2.');
  }
  if (!Array.isArray(record?.schedule) || record.schedule.length !== 24) {
    errors.push('schedule must contain 24 warmup and measured runs.');
  } else if (new Set(record.schedule.map(step => step.label)).size !== record.schedule.length) {
    errors.push('schedule labels must be unique.');
  }
  const reference = record?.reference?.manifest;
  if (record?.reference?.source !== 'candidate-rc-warmup-rc') {
    errors.push('reference.source must be the RC.2 warmup.');
  }
  if (!Array.isArray(reference) || reference.length !== expectedCaptures) {
    errors.push(`reference.manifest must contain ${expectedCaptures} PNG entries.`);
  } else {
    const paths = new Set();
    for (const [index, entry] of reference.entries()) {
      if (typeof entry?.path !== 'string' || entry.path.length === 0 || paths.has(entry.path)) {
        errors.push(`reference.manifest[${index}].path must be unique.`);
      }
      paths.add(entry?.path);
      if (
        !Number.isSafeInteger(entry?.width) ||
        entry.width <= 0 ||
        !Number.isSafeInteger(entry?.height) ||
        entry.height <= 0
      ) {
        errors.push(`reference.manifest[${index}] dimensions must be positive integers.`);
      }
      for (const field of ['rgbaSha256', 'visualSha256']) {
        if (!/^[0-9a-f]{64}$/i.test(entry?.[field] ?? '')) {
          errors.push(`reference.manifest[${index}].${field} must be a SHA-256 hash.`);
        }
      }
    }
    const expectedManifestHash = hashBuffer(Buffer.from(JSON.stringify(reference)));
    if (record?.reference?.manifestSha256 !== expectedManifestHash) {
      errors.push('reference.manifestSha256 does not match the manifest.');
    }
  }
  const summaries = {};
  for (const [comparison, labels] of Object.entries({
    candidateRc: ['candidate', 'rc'],
    candidateStoryCapture: ['candidate', 'storycapture'],
  })) {
    const entry = record?.comparisons?.[comparison];
    if (!entry || entry.pairs?.length !== 5) errors.push(`${comparison} must contain five measured pairs.`);
    const scheduled = Array.isArray(record?.schedule)
      ? record.schedule.filter(step => step.comparison === comparison)
      : [];
    const scheduledWarmups = scheduled.filter(step => step.kind === 'warmup').map(step => step.implementation);
    if (
      scheduled.length !== 12 ||
      scheduledWarmups.length !== 2 ||
      labels.some(label => !scheduledWarmups.includes(label))
    ) {
      errors.push(`${comparison} schedule must contain one warmup and five measured runs per implementation.`);
    }
    const runs = Object.fromEntries(labels.map(label => [label, []]));
    const allPairs = entry?.pairs ?? [];
    let previousStart;
    for (const [index, pair] of allPairs.entries()) {
      const scheduledOrder = scheduled
        .filter(step => step.kind === 'measured' && step.pair === index + 1)
        .map(step => step.implementation);
      if (JSON.stringify(scheduledOrder) !== JSON.stringify(pair?.order)) {
        errors.push(`${comparison}.pairs[${index}].order does not match the recorded schedule.`);
      }
      if (
        !Array.isArray(pair.order) ||
        pair.order.length !== 2 ||
        new Set(pair.order).size !== 2 ||
        pair.order.some(label => !labels.includes(label))
      ) {
        errors.push(`${comparison}.pairs[${index}].order is invalid.`);
      } else if (pair.order[0] === previousStart) {
        errors.push(`${comparison}.pairs[${index}] does not alternate its starting implementation.`);
      }
      previousStart = pair.order?.[0];
      for (const label of labels) {
        validateRun(
          pair[label],
          `${comparison}.pairs[${index}].${label}`,
          expectedCaptures,
          record?.reference?.manifestSha256,
          errors,
        );
        if (pair[label]) runs[label].push(pair[label]);
      }
    }
    for (const label of labels) {
      validateRun(
        entry?.warmups?.[label],
        `${comparison}.warmups.${label}`,
        expectedCaptures,
        record?.reference?.manifestSha256,
        errors,
      );
    }
    summaries[comparison] = Object.fromEntries(labels.map(label => [label, summarize(runs[label])]));
  }
  const ratios = {
    candidateToRcWallP50: ratio(summaries.candidateRc?.candidate.wallP50Ms, summaries.candidateRc?.rc.wallP50Ms),
    candidateToRcWallP95: ratio(summaries.candidateRc?.candidate.wallP95Ms, summaries.candidateRc?.rc.wallP95Ms),
    candidateToRcCpuP50: ratio(summaries.candidateRc?.candidate.cpuP50Ms, summaries.candidateRc?.rc.cpuP50Ms),
    candidateToRcPeakRssP50: ratio(
      summaries.candidateRc?.candidate.peakRssP50Bytes,
      summaries.candidateRc?.rc.peakRssP50Bytes,
    ),
    candidateToStoryCaptureWallP50: ratio(
      summaries.candidateStoryCapture?.candidate.wallP50Ms,
      summaries.candidateStoryCapture?.storycapture.wallP50Ms,
    ),
    candidateToStoryCaptureWallP95: ratio(
      summaries.candidateStoryCapture?.candidate.wallP95Ms,
      summaries.candidateStoryCapture?.storycapture.wallP95Ms,
    ),
    candidateToStoryCaptureCpuP50: ratio(
      summaries.candidateStoryCapture?.candidate.cpuP50Ms,
      summaries.candidateStoryCapture?.storycapture.cpuP50Ms,
    ),
    candidateToStoryCapturePeakRssP50: ratio(
      summaries.candidateStoryCapture?.candidate.peakRssP50Bytes,
      summaries.candidateStoryCapture?.storycapture.peakRssP50Bytes,
    ),
  };
  for (const [field, maximum] of Object.entries({
    candidateToRcWallP50: 1.05,
    candidateToRcWallP95: 1.05,
    candidateToStoryCaptureWallP50: 0.9,
    candidateToStoryCaptureWallP95: 1,
  })) {
    if (ratios[field] === null || ratios[field] > maximum) {
      errors.push(`${field} must be <= ${maximum}, got ${ratios[field]}.`);
    }
  }
  return { summaries, ratios, gate: { passed: errors.length === 0, errors } };
}

function runWithoutManifest(run) {
  const { manifest: _manifest, ...serializable } = run;
  return serializable;
}

function groupRecordRuns(schedule, measuredRuns) {
  const comparisons = {
    candidateRc: { warmups: {}, pairs: [] },
    candidateStoryCapture: { warmups: {}, pairs: [] },
  };
  for (const step of schedule) {
    const run = runWithoutManifest(measuredRuns.get(step.label));
    const comparison = comparisons[step.comparison];
    if (step.kind === 'warmup') comparison.warmups[step.implementation] = run;
    else {
      comparison.pairs[step.pair - 1] ??= { order: [] };
      comparison.pairs[step.pair - 1].order.push(step.implementation);
      comparison.pairs[step.pair - 1][step.implementation] = run;
    }
  }
  return comparisons;
}

function writeJsonAtomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

async function recordReleasePerformance(config, { configDir, outputFile }) {
  validateConfig(config);
  if (process.platform !== 'linux') throw new Error('Release performance recording requires Linux /proc.');
  const chromiumPath = path.resolve(configDir, config.chromiumPath);
  const staticBuildDir = path.resolve(configDir, config.staticBuildDir);
  const repositoryDir = path.resolve(configDir, config.repositoryDir ?? '.');
  if (!fs.statSync(chromiumPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Chromium does not exist: ${chromiumPath}`);
  }
  if (!fs.statSync(staticBuildDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Static Storybook build does not exist: ${staticBuildDir}`);
  }
  const chromium = execFileSync(chromiumPath, ['--version'], { encoding: 'utf8' }).trim();
  const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryDir,
    encoding: 'utf8',
  }).trim();
  const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: repositoryDir,
    encoding: 'utf8',
  }).trim();
  if (
    config.implementations.candidate.commit !== candidateCommit ||
    config.implementations.candidate.tree !== candidateTree
  ) {
    throw new Error('Candidate commit/tree do not match repositoryDir HEAD.');
  }
  const clockTicksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storyfreeze-release-performance-'));
  const artifactDir = `${outputFile}.artifacts`;
  const npmBefore = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  const schedule = buildSchedule(config.starting);
  const invalidPngHashes = new Set(config.invalidPngHashes);
  const measuredRuns = new Map();
  let referenceManifest;
  try {
    const candidatePackagePath = packCandidatePackage(repositoryDir, path.join(temporaryRoot, 'candidate-package'));
    const implementations = Object.fromEntries(
      Object.entries(config.implementations).map(([name, implementation]) => [
        name,
        {
          ...prepareImplementationPackage(name, implementation, configDir, path.join(temporaryRoot, 'packages', name), {
            dependencyLockArtifactPath: path.join(artifactDir, 'dependencies', `${name}-package-lock.json`),
            npmBefore,
            ...(name === 'candidate' ? { packageArchivePath: candidatePackagePath } : {}),
          }),
          cwd: path.resolve(configDir, implementation.cwd ?? '.'),
        },
      ]),
    );
    for (const step of schedule) {
      const outputDir = path.join(temporaryRoot, step.label);
      const run = await measureCommand({
        implementation: implementations[step.implementation],
        replacements: { chromiumPath, outDir: outputDir, storybookUrl: config.storybookUrl },
        outputDir,
        artifactDir,
        label: step.label,
        commandTimeoutMs: config.commandTimeoutMs,
        clockTicksPerSecond,
        invalidPngHashes,
      });
      if (!referenceManifest) referenceManifest = run.manifest;
      Object.assign(run, compareManifests(referenceManifest, run.manifest));
      measuredRuns.set(step.label, run);
    }
    const scenarioOptions = {
      commandTimeoutMs: config.commandTimeoutMs,
      npmBefore,
      parallel: config.parallel,
      storybookUrl: config.storybookUrl,
      commands: Object.fromEntries(
        Object.entries(implementations).map(([name, implementation]) => [
          name,
          { args: implementation.args, binName: implementation.packageBinName, binPath: implementation.packageBinPath },
        ]),
      ),
    };
    const record = {
      schemaVersion: 1,
      kind: 'storyfreeze-release-performance',
      recordedAt: new Date().toISOString(),
      scenario: {
        azureImage: config.azureImage,
        chromium,
        expectedCaptures: config.expectedCaptures,
        invalidPngHashes: [...invalidPngHashes].sort(),
        node: process.version,
        npmBefore,
        options: scenarioOptions,
        optionsHash: hashBuffer(Buffer.from(JSON.stringify(scenarioOptions))),
        parallel: config.parallel,
        staticBuildHash: hashPath(staticBuildDir),
      },
      implementations: Object.fromEntries(
        Object.entries(implementations).map(([name, implementation]) => [
          name,
          {
            binName: implementation.packageBinName,
            binPath: implementation.packageBinPath,
            commit: implementation.commit,
            dependencyLockArtifact: `dependencies/${name}-package-lock.json`,
            dependencyLockHash: implementation.dependencyLockHash,
            packageName: implementation.packageName,
            packageHash: implementation.packageHash,
            tree: implementation.tree,
            version: implementation.version,
          },
        ]),
      ),
      schedule: schedule.map(({ label, comparison, implementation, kind, pair }) => ({
        label,
        comparison,
        implementation,
        kind,
        ...(pair ? { pair } : {}),
      })),
      reference: {
        source: 'candidate-rc-warmup-rc',
        manifest: referenceManifest,
        manifestSha256: hashBuffer(Buffer.from(JSON.stringify(referenceManifest))),
      },
      comparisons: groupRecordRuns(schedule, measuredRuns),
    };
    Object.assign(record, evaluateRecord(record));
    writeJsonAtomic(outputFile, record);
    return record;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const [configPath, outputPath] = process.argv.slice(2);
  if (configPath === '--hash-png') {
    if (!outputPath) throw new Error('Usage: release-performance.js --hash-png <png>');
    const inspection = inspectPngDirectory(path.dirname(path.resolve(outputPath)));
    const target = inspection.manifest.find(entry => entry.path === path.basename(outputPath));
    if (!target) throw new Error(`Unable to decode PNG: ${outputPath}`);
    process.stdout.write(`${target.visualSha256}\n`);
    return;
  }
  if (!configPath || !outputPath) {
    throw new Error('Usage: release-performance.js <config.json> <artifact.json>');
  }
  const absoluteConfig = path.resolve(configPath);
  const config = JSON.parse(fs.readFileSync(absoluteConfig, 'utf8'));
  const record = await recordReleasePerformance(config, {
    configDir: path.dirname(absoluteConfig),
    outputFile: path.resolve(outputPath),
  });
  process.stdout.write(`${JSON.stringify({ ratios: record.ratios, gate: record.gate }, null, 2)}\n`);
  if (!record.gate.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    const outputPath = process.argv[3];
    if (process.argv[2] !== '--hash-png' && outputPath) {
      try {
        writeJsonAtomic(path.resolve(outputPath), {
          schemaVersion: 1,
          kind: 'storyfreeze-release-performance',
          recordedAt: new Date().toISOString(),
          fatalError: String(error?.stack ?? error),
          gate: { passed: false, errors: [String(error?.message ?? error)] },
        });
      } catch (writeError) {
        console.error(`Unable to write fatal artifact: ${writeError?.stack ?? writeError}`);
      }
    }
    process.exitCode = 1;
  });
}

module.exports = {
  buildSchedule,
  compareManifests,
  createLogInspector,
  evaluateRecord,
  inspectPngDirectory,
  measuredOrder,
  packCandidatePackage,
  percentile,
  prepareImplementationPackage,
  replacePlaceholders,
  resolvePackageExecutable,
  summarize,
  validateConfig,
};
