#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const isolations = ['process', 'context'];

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

function isRatioAtMost(value, limit) {
  return typeof value === 'number' && Number.isFinite(value) && value <= limit;
}

function coefficientOfVariation(values) {
  if (!values.length) return null;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function summarizeTimings(events) {
  return {
    maxMs: events.length ? Math.max(...events) : null,
    p50Ms: percentile(events, 0.5),
    p95Ms: percentile(events, 0.95),
    samples: events.length,
  };
}

function summarizePhaseTimings(events, type) {
  const phases = [...new Set(events.filter(event => event.type === type).map(event => event.phase))];
  return Object.fromEntries(
    phases
      .filter(phase => typeof phase === 'string')
      .sort()
      .map(phase => {
        const values = events
          .filter(
            event =>
              event.type === type &&
              event.state === 'end' &&
              event.phase === phase &&
              typeof event.durationMs === 'number' &&
              Number.isFinite(event.durationMs),
          )
          .map(event => event.durationMs);
        return [phase, summarizeTimings(values)];
      }),
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function treeForCommit(commit) {
  return execFileSync('git', ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim();
}

function validateRun(run, { expectedCaptures, isolation, recordLabel }) {
  if (run.backend !== 'playwright') fail(`${recordLabel} contains a non-Playwright ${isolation} run.`);
  if (run.isolation !== isolation) {
    fail(`${recordLabel} contains a ${run.isolation ?? 'missing'} run in the ${isolation} result.`);
  }
  for (const field of [
    'browserCrashCount',
    'cpuTimeMs',
    'peakBrowserRootCount',
    'peakChromiumProcessCount',
    'peakTreeRssBytes',
    'pngCount',
    'retryCount',
    'timeoutCount',
    'wallTimeMs',
  ]) {
    if (typeof run[field] !== 'number' || !Number.isFinite(run[field])) {
      fail(`${recordLabel} ${isolation} run ${run.label ?? '(unlabelled)'} has invalid ${field}.`);
    }
  }
  if (!Array.isArray(run.storyDurationsMs) || run.storyDurationsMs.length !== expectedCaptures) {
    fail(
      `${recordLabel} ${isolation} run ${run.label ?? '(unlabelled)'} must contain ${expectedCaptures} raw capture timings.`,
    );
  }
  if (run.storyDurationsMs.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    fail(`${recordLabel} ${isolation} run ${run.label ?? '(unlabelled)'} has an invalid capture timing.`);
  }
  const captureOutputs = (run.captureDiagnostics ?? []).filter(event => event.type === 'capture-output');
  if (captureOutputs.length !== expectedCaptures) {
    fail(
      `${recordLabel} ${isolation} run ${run.label ?? '(unlabelled)'} must contain ${expectedCaptures} capture-output diagnostics.`,
    );
  }
  if (
    captureOutputs.some(
      event =>
        typeof event.storyId !== 'string' ||
        !Array.isArray(event.variantKey) ||
        typeof event.durationMs !== 'number' ||
        !Number.isFinite(event.durationMs),
    )
  ) {
    fail(`${recordLabel} ${isolation} run ${run.label ?? '(unlabelled)'} has an invalid capture-output diagnostic.`);
  }
}

function validateExecutionOrder(record, { measuredRuns, recordLabel, warmupRuns }) {
  for (const [runKind, runCount] of [
    ['warmup', warmupRuns],
    ['measured', measuredRuns],
  ]) {
    const collectionKey = runKind === 'warmup' ? 'warmups' : 'runs';
    const orderKey = runKind === 'warmup' ? 'warmupExecutionOrder' : 'measuredExecutionOrder';
    const expectedLabels = [];
    for (let iteration = 1; iteration <= runCount; iteration += 1) {
      const processFirst = record.scenario.startingIsolation === 'process' ? iteration % 2 === 1 : iteration % 2 === 0;
      const order = processFirst ? isolations : [...isolations].reverse();
      for (const [positionInPair, isolation] of order.entries()) {
        const run = record.isolations[isolation][collectionKey][iteration - 1];
        const sequenceIndex = expectedLabels.length + 1;
        if (
          run.iteration !== iteration ||
          run.pairStartingIsolation !== order[0] ||
          run.positionInPair !== positionInPair ||
          run.sequenceIndex !== sequenceIndex
        ) {
          fail(`${recordLabel} has an invalid ${runKind} execution order at pair ${iteration}.`);
        }
        expectedLabels.push(run.label);
      }
    }
    if (JSON.stringify(record.scenario[orderKey]) !== JSON.stringify(expectedLabels)) {
      fail(`${recordLabel} ${orderKey} does not match its raw runs.`);
    }
  }
}

function validateRecord(record, { commit, measuredRuns, parallel, profile, recordLabel, tree, warmupRuns }) {
  if (record.schemaVersion !== 1) {
    fail(`${recordLabel} expected isolation benchmark schema 1, got ${record.schemaVersion}.`);
  }
  if (record.kind !== 'browser-isolation-differential') {
    fail(`${recordLabel} expected browser-isolation-differential, got ${record.kind}.`);
  }
  if (!record.gate?.passed) fail(`${recordLabel} benchmark gate did not pass.`);
  if (record.provisioning !== 'explicit-install') {
    fail(`${recordLabel} expected explicit-install provisioning, got ${record.provisioning}.`);
  }
  if (record.storyfreezeCommit !== commit) {
    fail(`${recordLabel} expected commit ${commit}, got ${record.storyfreezeCommit}.`);
  }
  if (record.storyfreezeTree !== tree) {
    fail(`${recordLabel} expected tree ${tree}, got ${record.storyfreezeTree}.`);
  }
  for (const field of ['repository', 'runAttempt', 'runId', 'workflowRef', 'workflowSha']) {
    if (typeof record.githubActions?.[field] !== 'string' || !record.githubActions[field]) {
      fail(`${recordLabel} has no GitHub Actions ${field} provenance.`);
    }
  }
  if (!/^\d+$/.test(record.githubActions.runAttempt) || !/^\d+$/.test(record.githubActions.runId)) {
    fail(`${recordLabel} has invalid GitHub Actions run provenance.`);
  }
  if (record.scenario?.benchmarkProfile !== profile) {
    fail(`${recordLabel} expected ${profile} profile, got ${record.scenario?.benchmarkProfile}.`);
  }
  if (record.scenario?.parallel !== parallel) {
    fail(`${recordLabel} expected parallel ${parallel}, got ${record.scenario?.parallel}.`);
  }
  if (record.scenario?.measuredRuns !== measuredRuns) {
    fail(`${recordLabel} expected ${measuredRuns} measured runs, got ${record.scenario?.measuredRuns}.`);
  }
  if (record.scenario?.warmupRuns !== warmupRuns) {
    fail(`${recordLabel} expected ${warmupRuns} warmup runs, got ${record.scenario?.warmupRuns}.`);
  }
  if (record.scenario?.backend !== 'playwright') {
    fail(`${recordLabel} expected the Playwright backend, got ${record.scenario?.backend}.`);
  }
  if (record.scenario?.includeTrace !== false) fail(`${recordLabel} must disable tracing.`);
  if (!isolations.includes(record.scenario?.startingIsolation)) {
    fail(`${recordLabel} has an invalid starting isolation.`);
  }
  if (typeof record.scenario?.pngs !== 'number' || record.scenario.pngs <= 0) {
    fail(`${recordLabel} has an invalid PNG count.`);
  }
  if (typeof record.scenario?.storybook !== 'string' || !record.scenario.storybook) {
    fail(`${recordLabel} has no Storybook fixture version.`);
  }
  for (const isolation of isolations) {
    const runs = record.isolations?.[isolation]?.runs;
    if (!Array.isArray(runs) || runs.length !== measuredRuns) {
      fail(`${recordLabel} expected ${measuredRuns} ${isolation} runs, got ${runs?.length}.`);
    }
    for (const run of runs) {
      validateRun(run, { expectedCaptures: record.scenario.pngs, isolation, recordLabel });
    }
    const warmups = record.isolations?.[isolation]?.warmups;
    if (!Array.isArray(warmups) || warmups.length !== warmupRuns) {
      fail(`${recordLabel} expected ${warmupRuns} ${isolation} warmups, got ${warmups?.length}.`);
    }
    for (const run of warmups) {
      validateRun(run, { expectedCaptures: record.scenario.pngs, isolation, recordLabel });
    }
  }
  validateExecutionOrder(record, { measuredRuns, recordLabel, warmupRuns });
  const pixelComparisons = record.isolationDifferential?.pixelComparisons;
  const expectedComparisonCount = measuredRuns + 2 * (measuredRuns - 1);
  if (!Array.isArray(pixelComparisons) || pixelComparisons.length !== expectedComparisonCount) {
    fail(`${recordLabel} expected ${expectedComparisonCount} raw PNG comparisons, got ${pixelComparisons?.length}.`);
  }
  for (const comparison of pixelComparisons) {
    for (const field of [
      'actualPngCount',
      'byteMismatchCount',
      'differentPixels',
      'expectedPngCount',
      'mismatchCount',
    ]) {
      if (!Number.isInteger(comparison[field]) || comparison[field] < 0) {
        fail(`${recordLabel} has an invalid PNG comparison ${field}.`);
      }
    }
    if (!Array.isArray(comparison.mismatches)) fail(`${recordLabel} has invalid raw PNG mismatch evidence.`);
  }
}

function benchmarkConditions(record) {
  return {
    arch: record.environment?.arch,
    browserExecutable: record.environment?.browser?.realpath,
    chromiumRevision: record.environment?.browser?.revision,
    chromiumVersion: record.environment?.browser?.version,
    exclude: record.scenario?.exclude,
    fixture: record.scenario?.fixture,
    githubRepository: record.githubActions?.repository,
    githubWorkflowRef: record.githubActions?.workflowRef,
    githubWorkflowSha: record.githubActions?.workflowSha,
    launchOptions: record.scenario?.launchOptions,
    mode: record.scenario?.mode,
    node: record.environment?.node,
    platform: record.environment?.platform,
    playwrightCore: record.environment?.browser?.playwrightCore,
    pngs: record.scenario?.pngs,
    runnerImage: record.environment?.runnerImage,
    runnerImageVersion: record.environment?.runnerImageVersion,
    runnerRelease: record.environment?.release,
    sampleIntervalMs: record.scenario?.sampleIntervalMs,
    stories: record.scenario?.stories,
    storybook: record.scenario?.storybook,
    storyfreezeVersion: record.storyfreezeVersion,
  };
}

function commonConditions(records) {
  const conditions = benchmarkConditions(records[0]);
  for (const [field, value] of Object.entries(conditions)) {
    if (value === undefined || value === null || value === '') {
      fail(`Isolation benchmark condition ${field} is missing.`);
    }
  }
  for (const record of records.slice(1)) {
    if (JSON.stringify(benchmarkConditions(record)) !== JSON.stringify(conditions)) {
      fail('Isolation benchmark Playwright, Chromium, fixture, runner, Node, or options do not match.');
    }
  }
  return {
    ...conditions,
    backend: 'playwright',
    benchmarkProfile: 'record',
    measuredRunsPerDispatch: 10,
    parallel: 4,
  };
}

function summarizeIsolation(runs, expectedCapturesPerRun) {
  const captureTimes = runs.flatMap(run => run.storyDurationsMs);
  const diagnosticEvents = runs.flatMap(run => run.captureDiagnostics ?? []);
  const captureOutputs = diagnosticEvents.filter(event => event.type === 'capture-output');
  const queueWaitTimes = diagnosticEvents
    .filter(
      event =>
        event.type === 'queue-task' &&
        event.state === 'start' &&
        typeof event.durationMs === 'number' &&
        Number.isFinite(event.durationMs),
    )
    .map(event => event.durationMs);
  const variantKeys = [
    ...new Set(captureOutputs.map(event => `${event.storyId}?keys=${(event.variantKey ?? []).join(',')}`)),
  ];
  const expectedCaptureCount = expectedCapturesPerRun * runs.length;
  const capturedPngCount = runs.reduce(
    (total, run) => total + Math.min(expectedCapturesPerRun, Math.max(0, run.pngCount)),
    0,
  );
  const idleTimeoutEventCount = runs
    .flatMap(run => run.captureDiagnostics ?? [])
    .filter(event => event.type === 'idle-wait' && event.didTimeout).length;
  const visualCommitTimeoutCount = runs
    .flatMap(run => run.captureDiagnostics ?? [])
    .filter(event => event.type === 'visual-commit' && event.didTimeout).length;
  const runTimeoutEventCount = runs.reduce((total, run) => total + run.timeoutCount, 0);

  return {
    browserCrashEventCount: runs.reduce((total, run) => total + run.browserCrashCount, 0),
    captureFailureCount: expectedCaptureCount - capturedPngCount,
    captureSampleCount: captureTimes.length,
    captureTimeP50Ms: percentile(captureTimes, 0.5),
    captureTimeP95Ms: percentile(captureTimes, 0.95),
    capturedPngCount,
    cpuTimeP50Ms: percentile(
      runs.map(run => run.cpuTimeMs),
      0.5,
    ),
    expectedCaptureCount,
    failedRunCount: runs.filter(run => !run.success).length,
    idleTimeoutEventCount,
    maxBrowserRootCount: Math.max(...runs.map(run => run.peakBrowserRootCount)),
    maxChromiumProcessCount: Math.max(...runs.map(run => run.peakChromiumProcessCount)),
    measuredRuns: runs.length,
    phaseTimings: summarizePhaseTimings(diagnosticEvents, 'capture-phase'),
    peakTreeRssP50Bytes: percentile(
      runs.map(run => run.peakTreeRssBytes),
      0.5,
    ),
    queueWait: summarizeTimings(queueWaitTimes),
    retryEventCount: runs.reduce((total, run) => total + run.retryCount, 0),
    runTimeoutEventCount,
    runtimePhaseTimings: summarizePhaseTimings(diagnosticEvents, 'runtime-phase'),
    storyVariants: Object.fromEntries(
      variantKeys.sort().map(key => {
        const values = captureOutputs
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
    threeSecondTailEventCount: captureTimes.filter(durationMs => durationMs >= 3000).length,
    timeoutEventCount: runTimeoutEventCount + idleTimeoutEventCount + visualCommitTimeoutCount,
    visualCommitTimeoutCount,
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

function summarizeRecords(records) {
  return Object.fromEntries(
    isolations.map(isolation => {
      const runs = records.flatMap(record => record.isolations[isolation].runs);
      return [isolation, summarizeIsolation(runs, records[0].scenario.pngs)];
    }),
  );
}

function contextToProcessRatios(summaries) {
  const { process, context } = summaries;
  return {
    captureTimeP50: ratio(context.captureTimeP50Ms, process.captureTimeP50Ms),
    captureTimeP95: ratio(context.captureTimeP95Ms, process.captureTimeP95Ms),
    cpuTimeP50: ratio(context.cpuTimeP50Ms, process.cpuTimeP50Ms),
    maxBrowserRootCount: ratio(context.maxBrowserRootCount, process.maxBrowserRootCount),
    maxChromiumProcessCount: ratio(context.maxChromiumProcessCount, process.maxChromiumProcessCount),
    peakTreeRssP50: ratio(context.peakTreeRssP50Bytes, process.peakTreeRssP50Bytes),
    wallTimeP50: ratio(context.wallTimeP50Ms, process.wallTimeP50Ms),
    wallTimeP95: ratio(context.wallTimeP95Ms, process.wallTimeP95Ms),
  };
}

function summarizePixelComparisons(records) {
  const comparisons = records.flatMap(record => record.isolationDifferential.pixelComparisons);
  return {
    byteMismatchCount: comparisons.reduce((total, comparison) => total + (comparison.byteMismatchCount ?? 0), 0),
    comparisonCount: comparisons.length,
    differentPixels: comparisons.reduce((total, comparison) => total + (comparison.differentPixels ?? 0), 0),
    mismatchCount: comparisons.reduce((total, comparison) => total + (comparison.mismatchCount ?? 0), 0),
  };
}

function parseWorkflowRun(url, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${label} is not a valid workflow run URL.`);
  }
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?\/?$/);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !match || parsed.search || parsed.hash) {
    fail(`${label} is not a valid GitHub Actions workflow run URL.`);
  }
  return {
    canonicalRun: `${match[1].toLowerCase()}/${match[2].toLowerCase()}/${match[3]}`,
    repository: `${match[1]}/${match[2]}`,
    runAttempt: match[4],
    runId: match[3],
  };
}

function validateWorkflowProvenance(record, workflowRun, label) {
  const parsed = parseWorkflowRun(workflowRun, label);
  if (parsed.repository.toLowerCase() !== record.githubActions.repository.toLowerCase()) {
    fail(`${label} repository does not match its benchmark artifact.`);
  }
  if (parsed.runId !== record.githubActions.runId) {
    fail(`${label} run ID does not match its benchmark artifact.`);
  }
  if (parsed.runAttempt && parsed.runAttempt !== record.githubActions.runAttempt) {
    fail(`${label} attempt does not match its benchmark artifact.`);
  }
  return parsed;
}

function summarizeDiagnostic(record, workflowRun) {
  const summaries = summarizeRecords([record]);
  return {
    isolations: summaries,
    contextToProcessRatios: contextToProcessRatios(summaries),
    parallel: record.scenario.parallel,
    pixelComparisons: summarizePixelComparisons([record]),
    recordedAt: record.recordedAt,
    startingIsolation: record.scenario.startingIsolation,
    workflowRun: workflowRun ?? null,
  };
}

function buildAggregate({
  commit,
  diagnosticP1,
  diagnosticP1Run,
  diagnosticP2,
  diagnosticP2Run,
  records,
  tree,
  workflowRuns,
}) {
  if (records.length !== 4) fail('Exactly four isolation record files are required.');
  if (workflowRuns.length !== 4) fail('Exactly four workflow run URLs are required.');
  const parsedWorkflowRuns = workflowRuns.map((url, index) => parseWorkflowRun(url, `workflow run ${index + 1}`));
  const diagnosticWorkflowRuns = [];
  for (const [parallel, record, workflowRun] of [
    [1, diagnosticP1, diagnosticP1Run],
    [2, diagnosticP2, diagnosticP2Run],
  ]) {
    if (Boolean(record) !== Boolean(workflowRun)) {
      fail(`The p${parallel} diagnostic record and workflow run URL must be provided together.`);
    }
    if (workflowRun) diagnosticWorkflowRuns.push(parseWorkflowRun(workflowRun, `p${parallel} workflow run`));
  }
  const allParsedWorkflowRuns = [...parsedWorkflowRuns, ...diagnosticWorkflowRuns];
  if (new Set(allParsedWorkflowRuns.map(run => run.canonicalRun)).size !== allParsedWorkflowRuns.length) {
    fail('Workflow run URLs must identify distinct dispatches.');
  }

  records.forEach((record, index) =>
    validateRecord(record, {
      commit,
      measuredRuns: 10,
      parallel: 4,
      profile: 'record',
      recordLabel: `record ${index + 1}`,
      tree,
      warmupRuns: 2,
    }),
  );
  const startingIsolations = records
    .map(record => record.scenario.startingIsolation)
    .sort()
    .join(',');
  if (startingIsolations !== 'context,context,process,process') {
    fail('Record files must contain two dispatches for each starting isolation.');
  }

  for (const [parallel, record] of [
    [1, diagnosticP1],
    [2, diagnosticP2],
  ]) {
    if (!record) continue;
    validateRecord(record, {
      commit,
      measuredRuns: 3,
      parallel,
      profile: 'pr',
      recordLabel: `p${parallel} diagnostic`,
      tree,
      warmupRuns: 1,
    });
  }
  workflowRuns.forEach((url, index) => validateWorkflowProvenance(records[index], url, `workflow run ${index + 1}`));
  for (const [parallel, record, workflowRun] of [
    [1, diagnosticP1, diagnosticP1Run],
    [2, diagnosticP2, diagnosticP2Run],
  ]) {
    if (record && workflowRun) validateWorkflowProvenance(record, workflowRun, `p${parallel} workflow run`);
  }

  const allRecords = [...records, ...[diagnosticP1, diagnosticP2].filter(Boolean)];
  const conditions = commonConditions(allRecords);
  const summaries = summarizeRecords(records);
  const ratios = contextToProcessRatios(summaries);
  const pixelComparisons = summarizePixelComparisons(records);
  const summaryList = Object.values(summaries);
  const acceptance = {
    browserCrashEventCountIsZero: summaryList.every(summary => summary.browserCrashEventCount === 0),
    captureFailureCountIsZero: summaryList.every(
      summary => summary.captureFailureCount === 0 && summary.failedRunCount === 0,
    ),
    captureTimeP95RatioAtMostOnePointZeroFive: isRatioAtMost(ratios.captureTimeP95, 1.05),
    contextEveryRunHasOneBrowserRoot: records.every(record =>
      [...record.isolations.context.warmups, ...record.isolations.context.runs].every(
        run => run.peakBrowserRootCount === 1,
      ),
    ),
    contextBrowserRootCountLessThanProcess:
      summaries.context.maxBrowserRootCount < summaries.process.maxBrowserRootCount,
    contextChromiumProcessCountLessThanProcess:
      summaries.context.maxChromiumProcessCount < summaries.process.maxChromiumProcessCount,
    contextMaxBrowserRootCountIsOne: summaries.context.maxBrowserRootCount === 1,
    measuredRunsPerIsolationIs40: summaryList.every(summary => summary.measuredRuns === 40),
    peakTreeRssP50RatioAtMostPointEight: isRatioAtMost(ratios.peakTreeRssP50, 0.8),
    pngMismatchCountIsZero: pixelComparisons.mismatchCount === 0,
    retryEventCountIsZero: summaryList.every(summary => summary.retryEventCount === 0),
    threeSecondTailEventCountIsZero: summaryList.every(summary => summary.threeSecondTailEventCount === 0),
    timeoutEventCountIsZero: summaryList.every(summary => summary.timeoutEventCount === 0),
    wallTimeP50RatioAtMostOne: isRatioAtMost(ratios.wallTimeP50, 1),
    wallTimeP95RatioAtMostOne: isRatioAtMost(ratios.wallTimeP95, 1),
  };
  acceptance.passed = Object.values(acceptance).every(Boolean);

  return {
    schemaVersion: 1,
    kind: 'browser-isolation-aggregate',
    recordedAt: records
      .map(record => record.recordedAt)
      .sort()
      .at(-1),
    sourceCommit: commit,
    sourceTree: tree,
    workflowRuns,
    conditions,
    isolations: summaries,
    contextToProcessRatios: ratios,
    pixelComparisons,
    diagnostics: {
      p1: diagnosticP1 ? summarizeDiagnostic(diagnosticP1, diagnosticP1Run) : null,
      p2: diagnosticP2 ? summarizeDiagnostic(diagnosticP2, diagnosticP2Run) : null,
    },
    acceptance,
  };
}

function runCli() {
  const { values } = parseArgs({
    options: {
      commit: { type: 'string' },
      output: { type: 'string' },
      p1: { type: 'string' },
      'p1-run': { type: 'string' },
      p2: { type: 'string' },
      'p2-run': { type: 'string' },
      record: { type: 'string', multiple: true },
      tree: { type: 'string' },
      'workflow-run': { type: 'string', multiple: true },
    },
    strict: true,
  });
  if (!values.output || !values.commit || !values.tree) fail('Missing required arguments.');
  if (treeForCommit(values.commit) !== values.tree) {
    fail(`Commit ${values.commit} does not resolve to tree ${values.tree}.`);
  }

  const output = buildAggregate({
    commit: values.commit,
    diagnosticP1: values.p1 ? readJson(values.p1) : undefined,
    diagnosticP1Run: values['p1-run'],
    diagnosticP2: values.p2 ? readJson(values.p2) : undefined,
    diagnosticP2Run: values['p2-run'],
    records: (values.record ?? []).map(readJson),
    tree: values.tree,
    workflowRuns: values['workflow-run'] ?? [],
  });
  fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
  fs.writeFileSync(path.resolve(values.output), `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output.acceptance, null, 2)}\n`);
}

if (require.main === module) runCli();

module.exports = { buildAggregate, percentile };
