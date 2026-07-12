#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const backends = ['puppeteer', 'playwright'];

function fail(message) {
  throw new Error(message);
}

function percentile(values, rank) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(rank * sorted.length) - 1)];
}

function ratio(numerator, denominator) {
  return typeof numerator === 'number' && typeof denominator === 'number' && denominator !== 0
    ? numerator / denominator
    : null;
}

function coefficientOfVariation(values) {
  if (!values.length) return null;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function treeForCommit(commit) {
  return execFileSync('git', ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim();
}

function validateRecord(record, { commit, parallel, profile }) {
  if (record.schemaVersion !== 3) fail(`Expected benchmark schema 3, got ${record.schemaVersion}.`);
  if (!record.gate?.passed) fail(`Benchmark gate failed for ${record.storyfreezeCommit}.`);
  if (record.provisioning !== 'explicit-install') {
    fail(`Expected explicit-install provisioning, got ${record.provisioning}.`);
  }
  if (record.storyfreezeCommit !== commit) {
    fail(`Expected benchmark commit ${commit}, got ${record.storyfreezeCommit}.`);
  }
  if (record.scenario?.benchmarkProfile !== profile) {
    fail(`Expected ${profile} profile, got ${record.scenario?.benchmarkProfile}.`);
  }
  if (record.scenario?.parallel !== parallel) {
    fail(`Expected parallel ${parallel}, got ${record.scenario?.parallel}.`);
  }
  const expectedRuns = profile === 'record' ? 10 : 3;
  for (const backend of backends) {
    if (record.backends?.[backend]?.runs?.length !== expectedRuns) {
      fail(`Expected ${expectedRuns} ${backend} runs, got ${record.backends?.[backend]?.runs?.length}.`);
    }
  }
}

function commonConditions(records) {
  const first = records[0];
  const conditions = {
    arch: first.environment.arch,
    browserRevision: first.environment.browser.revision,
    browserVersion: first.environment.browser.version,
    fixture: first.scenario.fixture,
    launchOptions: first.scenario.launchOptions,
    node: first.environment.node,
    os: first.environment.runnerImage,
    osRelease: first.environment.release,
    parallel: first.scenario.parallel,
    playwrightCore: first.environment.browser.playwrightCore,
    pngs: first.scenario.pngs,
    runnerImageVersion: first.environment.runnerImageVersion,
    sampleIntervalMs: first.scenario.sampleIntervalMs,
    storybook: first.scenario.storybook,
    stories: first.scenario.stories,
  };
  for (const record of records.slice(1)) {
    const candidate = {
      arch: record.environment.arch,
      browserRevision: record.environment.browser.revision,
      browserVersion: record.environment.browser.version,
      fixture: record.scenario.fixture,
      launchOptions: record.scenario.launchOptions,
      node: record.environment.node,
      os: record.environment.runnerImage,
      osRelease: record.environment.release,
      parallel: record.scenario.parallel,
      playwrightCore: record.environment.browser.playwrightCore,
      pngs: record.scenario.pngs,
      runnerImageVersion: record.environment.runnerImageVersion,
      sampleIntervalMs: record.scenario.sampleIntervalMs,
      storybook: record.scenario.storybook,
      stories: record.scenario.stories,
    };
    if (JSON.stringify(candidate) !== JSON.stringify(conditions)) fail('Benchmark conditions do not match.');
  }
  return conditions;
}

function summarizeBackend(runs) {
  const diagnostics = runs.flatMap(run => run.captureDiagnostics ?? []);
  const captures = diagnostics.filter(event => event.type === 'capture-output');
  const phases = diagnostics.filter(
    event => event.type === 'capture-phase' && event.state === 'end' && typeof event.durationMs === 'number',
  );
  const visualCommits = diagnostics.filter(event => event.type === 'visual-commit');
  const idleWaits = diagnostics.filter(event => event.type === 'idle-wait');
  const phaseNames = [...new Set(phases.map(event => event.phase))].sort();
  const variantKeys = [
    ...new Set(captures.map(event => `${event.storyId}?keys=${(event.variantKey ?? []).join(',')}`)),
  ];

  return {
    browserCrashRate: runs.filter(run => run.browserCrashCount > 0).length / runs.length,
    captureFailureRate: runs.filter(run => !run.success).length / runs.length,
    captureTimeP50Ms: percentile(
      captures.map(event => event.durationMs),
      0.5,
    ),
    captureTimeP95Ms: percentile(
      captures.map(event => event.durationMs),
      0.95,
    ),
    cpuTimeP50Ms: percentile(
      runs.map(run => run.cpuTimeMs),
      0.5,
    ),
    idleTimeoutEventCount: idleWaits.filter(event => event.didTimeout).length,
    maxBrowserRootCount: Math.max(...runs.map(run => run.peakBrowserRootCount)),
    maxChromiumProcessCount: Math.max(...runs.map(run => run.peakChromiumProcessCount)),
    measuredRuns: runs.length,
    peakTreeRssP50Bytes: percentile(
      runs.map(run => run.peakTreeRssBytes),
      0.5,
    ),
    phaseTimings: Object.fromEntries(
      phaseNames.map(phase => {
        const values = phases.filter(event => event.phase === phase).map(event => event.durationMs);
        return [phase, { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), samples: values.length }];
      }),
    ),
    retryRate: runs.reduce((total, run) => total + run.retryCount, 0) / runs.length,
    storyVariants: Object.fromEntries(
      variantKeys.sort().map(key => {
        const values = captures
          .filter(event => `${event.storyId}?keys=${(event.variantKey ?? []).join(',')}` === key)
          .map(event => event.durationMs);
        return [
          key,
          {
            coefficientOfVariation: coefficientOfVariation(values),
            p50Ms: percentile(values, 0.5),
            p95Ms: percentile(values, 0.95),
            samples: values.length,
          },
        ];
      }),
    ),
    threeSecondTailEventCount: captures.filter(event => event.durationMs >= 3000).length,
    timeoutRate: runs.reduce((total, run) => total + run.timeoutCount, 0) / runs.length,
    visualCommitEventCount: visualCommits.length,
    visualCommitFallbackCount: visualCommits.filter(event => event.usedAnimationFrameFallback).length,
    visualCommitTimeoutCount: visualCommits.filter(event => event.didTimeout).length,
    wallTimeP50Ms: percentile(
      runs.map(run => run.wallTimeMs),
      0.5,
    ),
    wallTimeP95Ms: percentile(
      runs.map(run => run.wallTimeMs),
      0.95,
    ),
  };
}

function summarizeSnapshot(records) {
  const summaries = Object.fromEntries(
    backends.map(backend => [backend, summarizeBackend(records.flatMap(record => record.backends[backend].runs))]),
  );
  return {
    backends: summaries,
    playwrightToPuppeteerRatios: {
      cpuTimeP50: ratio(summaries.playwright.cpuTimeP50Ms, summaries.puppeteer.cpuTimeP50Ms),
      peakTreeRssP50: ratio(summaries.playwright.peakTreeRssP50Bytes, summaries.puppeteer.peakTreeRssP50Bytes),
      wallTimeP50: ratio(summaries.playwright.wallTimeP50Ms, summaries.puppeteer.wallTimeP50Ms),
      wallTimeP95: ratio(summaries.playwright.wallTimeP95Ms, summaries.puppeteer.wallTimeP95Ms),
    },
  };
}

function summarizeDiagnostics(records) {
  return records.map(record => ({
    backends: Object.fromEntries(backends.map(backend => [backend, summarizeBackend(record.backends[backend].runs)])),
    parallel: record.scenario.parallel,
    startingBackend: record.scenario.startingBackend,
  }));
}

const { values } = parseArgs({
  options: {
    baseline: { type: 'string', multiple: true },
    'baseline-commit': { type: 'string' },
    'baseline-run': { type: 'string', multiple: true },
    candidate: { type: 'string', multiple: true },
    'candidate-commit': { type: 'string' },
    'candidate-run': { type: 'string', multiple: true },
    diagnostic: { type: 'string', multiple: true },
    'diagnostic-run': { type: 'string', multiple: true },
    output: { type: 'string' },
    trace: { type: 'string' },
    'trace-run': { type: 'string' },
  },
  strict: true,
});

if (!values.output || !values['baseline-commit'] || !values['candidate-commit']) fail('Missing required arguments.');
if (values.baseline?.length !== 4 || values.candidate?.length !== 4) {
  fail('Exactly four baseline and four candidate record files are required.');
}

const baselineRecords = values.baseline.map(readJson);
const candidateRecords = values.candidate.map(readJson);
const diagnosticRecords = (values.diagnostic ?? []).map(readJson);
for (const record of baselineRecords) {
  validateRecord(record, { commit: values['baseline-commit'], parallel: 4, profile: 'record' });
}
for (const record of candidateRecords) {
  validateRecord(record, { commit: values['candidate-commit'], parallel: 4, profile: 'record' });
}
for (const record of diagnosticRecords) {
  validateRecord(record, { commit: values['candidate-commit'], parallel: record.scenario.parallel, profile: 'pr' });
}
const startingBackends = records =>
  records
    .map(record => record.scenario.startingBackend)
    .sort()
    .join(',');
if (startingBackends(baselineRecords) !== 'playwright,playwright,puppeteer,puppeteer') {
  fail('Baseline records must contain two dispatches for each starting backend.');
}
if (startingBackends(candidateRecords) !== 'playwright,playwright,puppeteer,puppeteer') {
  fail('Candidate records must contain two dispatches for each starting backend.');
}

const conditions = commonConditions([...baselineRecords, ...candidateRecords]);
const baseline = summarizeSnapshot(baselineRecords);
const candidate = summarizeSnapshot(candidateRecords);
const ratios = candidate.playwrightToPuppeteerRatios;
const candidateSummaries = backends.map(backend => candidate.backends[backend]);
const pngMismatchCount = candidateRecords.reduce(
  (total, record) =>
    total + record.differential.pixelComparisons.reduce((sum, comparison) => sum + comparison.mismatchCount, 0),
  0,
);
const acceptance = {
  browserCrashRateIsZero: candidateSummaries.every(summary => summary.browserCrashRate === 0),
  captureFailureRateIsZero: candidateSummaries.every(summary => summary.captureFailureRate === 0),
  cpuTimeRatioAtMostOne: ratios.cpuTimeP50 <= 1,
  idleTimeoutEventCountIsZero: candidateSummaries.every(summary => summary.idleTimeoutEventCount === 0),
  pairedRunsAtLeast40: backends.every(backend => candidate.backends[backend].measuredRuns >= 40),
  peakTreeRssRatioAtMostPointEight: ratios.peakTreeRssP50 <= 0.8,
  pngMismatchCountIsZero: pngMismatchCount === 0,
  retryRateIsZero: candidateSummaries.every(summary => summary.retryRate === 0),
  timeoutRateIsZero: candidateSummaries.every(summary => summary.timeoutRate === 0),
  visualCommitTimeoutCountIsZero: candidateSummaries.every(summary => summary.visualCommitTimeoutCount === 0),
  wallTimeP50RatioAtMostOnePointZeroFive: ratios.wallTimeP50 <= 1.05,
  wallTimeP95RatioAtMostOnePointOne: ratios.wallTimeP95 <= 1.1,
};
acceptance.passed = Object.values(acceptance).every(Boolean);

let historicalContainerComparison;
if (fs.existsSync(values.output)) {
  const existing = readJson(values.output);
  historicalContainerComparison = existing.historicalContainerComparison ?? existing.ciEnvironmentComparison;
}
const traceRecord = values.trace ? readJson(values.trace) : undefined;
if (traceRecord) validateRecord(traceRecord, { commit: values['candidate-commit'], parallel: 4, profile: 'pr' });

const output = {
  schemaVersion: 2,
  kind: 'browser-differential-aggregate',
  recordedAt: candidateRecords
    .map(record => record.recordedAt)
    .sort()
    .at(-1),
  conditions,
  baseline: {
    sourceCommit: values['baseline-commit'],
    sourceTree: treeForCommit(values['baseline-commit']),
    workflowRuns: values['baseline-run'] ?? [],
    ...baseline,
  },
  candidate: {
    sourceCommit: values['candidate-commit'],
    sourceTree: treeForCommit(values['candidate-commit']),
    workflowRuns: values['candidate-run'] ?? [],
    ...candidate,
  },
  diagnostics: {
    workflowRuns: values['diagnostic-run'] ?? [],
    results: summarizeDiagnostics(diagnosticRecords),
  },
  traceValidation: traceRecord
    ? {
        gate: traceRecord.gate,
        summaries: Object.fromEntries(backends.map(backend => [backend, traceRecord.backends[backend].traceSummary])),
        workflowRun: values['trace-run'],
      }
    : null,
  candidatePlaywrightChange: {
    captureTimeP50: ratio(
      candidate.backends.playwright.captureTimeP50Ms,
      baseline.backends.playwright.captureTimeP50Ms,
    ),
    captureTimeP95: ratio(
      candidate.backends.playwright.captureTimeP95Ms,
      baseline.backends.playwright.captureTimeP95Ms,
    ),
    cpuTimeP50: ratio(candidate.backends.playwright.cpuTimeP50Ms, baseline.backends.playwright.cpuTimeP50Ms),
    peakTreeRssP50: ratio(
      candidate.backends.playwright.peakTreeRssP50Bytes,
      baseline.backends.playwright.peakTreeRssP50Bytes,
    ),
    wallTimeP50: ratio(candidate.backends.playwright.wallTimeP50Ms, baseline.backends.playwright.wallTimeP50Ms),
    wallTimeP95: ratio(candidate.backends.playwright.wallTimeP95Ms, baseline.backends.playwright.wallTimeP95Ms),
  },
  acceptance,
  historicalContainerComparison,
};

fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
fs.writeFileSync(path.resolve(values.output), `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(output.acceptance, null, 2)}\n`);
