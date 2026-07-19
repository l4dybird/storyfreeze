#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const zeroFields = [
  'crashCount',
  'duplicatePngCount',
  'failureCount',
  'invalidPreviewCount',
  'missingPngCount',
  'pixelMismatchCount',
  'residualProcessCount',
  'retryCount',
  'timeoutCount',
  'unexpectedPngCount',
];

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function ratio(numerator, denominator) {
  return typeof numerator === 'number' && typeof denominator === 'number' && denominator > 0
    ? numerator / denominator
    : null;
}

function missingIdentifier(value) {
  return typeof value !== 'string' || value.length === 0 || value.toLowerCase().includes('unknown');
}

function summarize(runs) {
  return {
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
    navigationCount: runs.reduce((total, run) => total + run.navigationCount, 0),
    peakRssP50Bytes: percentile(
      runs.map(run => run.peakRssBytes),
      0.5,
    ),
    runs: runs.length,
    sessionGenerationCount: runs.reduce((total, run) => total + run.sessionGenerationCount, 0),
    storySwitchCount: runs.reduce((total, run) => total + (run.storySwitchCount ?? 0), 0),
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

function validateRun(run, label, expectedCaptures, errors) {
  if (!run || typeof run !== 'object') {
    errors.push(`${label} is missing.`);
    return;
  }
  for (const field of ['captureTimeMs', 'cpuTimeMs', 'peakRssBytes', 'wallTimeMs']) {
    if (typeof run[field] !== 'number' || !Number.isFinite(run[field]) || run[field] <= 0) {
      errors.push(`${label}.${field} must be a positive finite number.`);
    }
  }
  for (const field of ['navigationCount', 'sessionGenerationCount']) {
    if (!Number.isSafeInteger(run[field]) || run[field] < 0) {
      errors.push(`${label}.${field} must be a non-negative safe integer.`);
    }
  }
  if (run.exitCode !== 0) errors.push(`${label}.exitCode must be zero.`);
  if (run.pngCount !== expectedCaptures) {
    errors.push(`${label}.pngCount expected ${expectedCaptures}, got ${run.pngCount}.`);
  }
  for (const field of zeroFields) {
    if (run[field] !== 0) errors.push(`${label}.${field} must be zero, got ${run[field]}.`);
  }
}

function validateStoryfreezeRun(run, label, expectedCaptures, parallel, errors) {
  validateRun(run, label, expectedCaptures, errors);
  if (run && (!Number.isSafeInteger(run.sessionGenerationCount) || run.sessionGenerationCount < parallel)) {
    errors.push(`${label}.sessionGenerationCount must be at least the ${parallel} capture workers.`);
  }
  if (run && (!Number.isSafeInteger(run.storySwitchCount) || run.storySwitchCount <= 0)) {
    errors.push(`${label}.storySwitchCount must prove that persistent cross-story Preview switching was exercised.`);
  }
}

function validateAlternatingPairs(pairs, labels, errors, collectionName = 'pairs') {
  let previous;
  pairs.forEach((pair, index) => {
    if (!pair || typeof pair !== 'object') {
      errors.push(`${collectionName}[${index}] must be an object.`);
      return;
    }
    if (
      !Array.isArray(pair.order) ||
      pair.order.length !== labels.length ||
      new Set(pair.order).size !== labels.length
    ) {
      errors.push(`${collectionName}[${index}].order must contain ${labels.join(' and ')} exactly once.`);
      return;
    }
    if (pair.order.some(label => !labels.includes(label))) {
      errors.push(`${collectionName}[${index}].order contains an unknown implementation.`);
    }
    if (previous === pair.order[0]) {
      errors.push(`${collectionName}[${index}] does not alternate the starting implementation.`);
    }
    previous = pair.order[0];
  });
}

function validateRc0Baseline(rc0, scenario, errors) {
  if (rc0?.schemaVersion !== 1 || rc0?.kind !== 'storyfreeze-rc0-resource-baseline') {
    errors.push('Expected rc0 storyfreeze-rc0-resource-baseline schema version 1.');
  }
  for (const field of ['commit', 'packageHash', 'tree', 'version']) {
    if (missingIdentifier(rc0?.storyfreeze?.[field])) errors.push(`rc0.storyfreeze.${field} is required.`);
  }
  if (rc0?.storyfreeze?.version !== '0.2.0-rc.0') {
    errors.push(`rc0.storyfreeze.version must be 0.2.0-rc.0, got ${rc0?.storyfreeze?.version}.`);
  }
  for (const field of ['azureImage', 'chromium', 'optionsHash', 'staticBuildHash']) {
    if (missingIdentifier(rc0?.scenario?.[field])) errors.push(`rc0.scenario.${field} is required.`);
    else if (rc0.scenario[field] !== scenario[field]) {
      errors.push(`rc0.scenario.${field} must match scenario.${field}.`);
    }
  }
  for (const field of ['expectedCaptures', 'parallel']) {
    if (rc0?.scenario?.[field] !== scenario[field]) {
      errors.push(`rc0.scenario.${field} must match scenario.${field}.`);
    }
  }
  const runs = Array.isArray(rc0?.runs) ? rc0.runs : [];
  if (runs.length < 3) errors.push(`rc0.runs requires at least three raw runs, got ${runs.length}.`);
  runs.forEach((run, index) => {
    for (const field of ['cpuTimeMs', 'peakRssBytes']) {
      if (typeof run?.[field] !== 'number' || !Number.isFinite(run[field]) || run[field] <= 0) {
        errors.push(`rc0.runs[${index}].${field} must be a positive finite number.`);
      }
    }
  });
  return {
    cpuP50Ms: percentile(runs.map(run => run?.cpuTimeMs).filter(Number.isFinite), 0.5),
    peakRssP50Bytes: percentile(runs.map(run => run?.peakRssBytes).filter(Number.isFinite), 0.5),
    runs: runs.length,
  };
}

function evaluateRecycleExperiment(record, expectedCaptures, parallel, rc0Summary) {
  if (!Array.isArray(record?.noRecyclePairs) || record.noRecyclePairs.length === 0) return { measured: false };
  const errors = [];
  if (record.noRecyclePairs.length < 3) errors.push('noRecyclePairs requires at least three measured pairs.');
  validateAlternatingPairs(record.noRecyclePairs, ['default128', 'unlimited'], errors);
  const defaultRuns = [];
  const unlimitedRuns = [];
  record.noRecyclePairs.forEach((pair, index) => {
    const entry = pair && typeof pair === 'object' ? pair : {};
    validateStoryfreezeRun(entry.default128, `noRecyclePairs[${index}].default128`, expectedCaptures, parallel, errors);
    validateStoryfreezeRun(entry.unlimited, `noRecyclePairs[${index}].unlimited`, expectedCaptures, parallel, errors);
    if (entry.default128) defaultRuns.push(entry.default128);
    if (entry.unlimited) unlimitedRuns.push(entry.unlimited);
  });
  const defaultSummary = summarize(defaultRuns);
  const unlimitedSummary = summarize(unlimitedRuns);
  const wallP50Ratio = ratio(unlimitedSummary.wallP50Ms, defaultSummary.wallP50Ms);
  const rssToRc0 = ratio(unlimitedSummary.peakRssP50Bytes, rc0Summary.peakRssP50Bytes);
  const adopt = errors.length === 0 && wallP50Ratio <= 0.95 && rssToRc0 <= 1.1;
  return {
    adopt,
    default128: defaultSummary,
    errors,
    measured: true,
    ratios: { peakRssToRc0: rssToRc0, wallP50ToDefault128: wallP50Ratio },
    unlimited: unlimitedSummary,
  };
}

function evaluateStoryCaptureGate(record) {
  const errors = [];
  if (record?.schemaVersion !== 1 || record?.kind !== 'storycapture-performance-comparison') {
    errors.push('Expected storycapture-performance-comparison schema version 1.');
  }
  const scenario = record?.scenario ?? {};
  const expectedCaptures = scenario.expectedCaptures;
  if (expectedCaptures !== 452) errors.push(`scenario.expectedCaptures must be 452, got ${expectedCaptures}.`);
  if (scenario.parallel !== 4) errors.push(`scenario.parallel must be 4, got ${scenario.parallel}.`);
  for (const field of ['azureImage', 'chromium', 'optionsHash', 'staticBuildHash']) {
    if (missingIdentifier(scenario[field])) errors.push(`scenario.${field} is required.`);
  }
  for (const field of ['commit', 'packageHash', 'tree', 'version']) {
    if (missingIdentifier(record?.storyfreeze?.[field])) {
      errors.push(`storyfreeze.${field} is required.`);
    }
  }
  for (const field of ['packageHash', 'version']) {
    if (missingIdentifier(record?.storycapture?.[field])) {
      errors.push(`storycapture.${field} is required.`);
    }
  }
  const rc0Summary = validateRc0Baseline(record?.rc0, scenario, errors);

  const warmups = Array.isArray(record?.warmups) ? record.warmups : [];
  if (warmups.length !== 1) errors.push(`Exactly one warmup pair is required, got ${warmups.length}.`);
  validateAlternatingPairs(warmups, ['storycapture', 'storyfreeze'], errors, 'warmups');
  warmups.forEach((pair, index) => {
    const entry = pair && typeof pair === 'object' ? pair : {};
    validateRun(entry.storycapture, `warmups[${index}].storycapture`, expectedCaptures, errors);
    validateStoryfreezeRun(
      entry.storyfreeze,
      `warmups[${index}].storyfreeze`,
      expectedCaptures,
      scenario.parallel,
      errors,
    );
  });

  const pairs = Array.isArray(record?.pairs) ? record.pairs : [];
  if (pairs.length < 5) errors.push(`At least five measured pairs are required, got ${pairs.length}.`);
  validateAlternatingPairs(pairs, ['storycapture', 'storyfreeze'], errors);
  const storycaptureRuns = [];
  const storyfreezeRuns = [];
  pairs.forEach((pair, index) => {
    const entry = pair && typeof pair === 'object' ? pair : {};
    validateRun(entry.storycapture, `pairs[${index}].storycapture`, expectedCaptures, errors);
    validateStoryfreezeRun(
      entry.storyfreeze,
      `pairs[${index}].storyfreeze`,
      expectedCaptures,
      scenario.parallel,
      errors,
    );
    if (entry.storycapture) storycaptureRuns.push(entry.storycapture);
    if (entry.storyfreeze) storyfreezeRuns.push(entry.storyfreeze);
  });

  const storycapture = summarize(storycaptureRuns);
  const storyfreeze = summarize(storyfreezeRuns);
  const ratios = {
    cpuToRc0: ratio(storyfreeze.cpuP50Ms, rc0Summary.cpuP50Ms),
    peakRssToRc0: ratio(storyfreeze.peakRssP50Bytes, rc0Summary.peakRssP50Bytes),
    wallP50ToStoryCapture: ratio(storyfreeze.wallP50Ms, storycapture.wallP50Ms),
    wallP95ToStoryCapture: ratio(storyfreeze.wallP95Ms, storycapture.wallP95Ms),
  };
  if (ratios.wallP50ToStoryCapture === null || ratios.wallP50ToStoryCapture > 0.9) {
    errors.push(`StoryFreeze/StoryCapture wall p50 ratio must be <= 0.90, got ${ratios.wallP50ToStoryCapture}.`);
  }
  if (ratios.wallP95ToStoryCapture === null || ratios.wallP95ToStoryCapture > 1) {
    errors.push(`StoryFreeze/StoryCapture wall p95 ratio must be <= 1.00, got ${ratios.wallP95ToStoryCapture}.`);
  }
  if (ratios.cpuToRc0 === null || ratios.cpuToRc0 > 0.9) {
    errors.push(`StoryFreeze/RC.0 CPU ratio must be <= 0.90, got ${ratios.cpuToRc0}.`);
  }
  if (ratios.peakRssToRc0 === null || ratios.peakRssToRc0 > 1.05) {
    errors.push(`StoryFreeze/RC.0 peak RSS ratio must be <= 1.05, got ${ratios.peakRssToRc0}.`);
  }

  const recycleExperiment = evaluateRecycleExperiment(record, expectedCaptures, scenario.parallel, rc0Summary);
  if (errors.length > 0 && recycleExperiment.measured) recycleExperiment.adopt = false;
  return {
    schemaVersion: 1,
    kind: 'storycapture-performance-gate-evaluation',
    source: {
      recordedAt: record?.recordedAt,
      scenario,
      storycapture: record?.storycapture,
      storyfreeze: record?.storyfreeze,
      rc0: record?.rc0,
    },
    summaries: { rc0: rc0Summary, storycapture, storyfreeze },
    ratios,
    recycleExperiment,
    stretchGoalPassed: ratios.wallP50ToStoryCapture !== null && ratios.wallP50ToStoryCapture <= 0.5,
    gate: { errors, passed: errors.length === 0 },
  };
}

function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input) throw new Error('Usage: node scripts/storycapture-performance-gate.js <record.json> [evaluation.json]');
  const evaluation = evaluateStoryCaptureGate(JSON.parse(fs.readFileSync(path.resolve(input), 'utf8')));
  const json = `${JSON.stringify(evaluation, null, 2)}\n`;
  if (output) {
    const target = path.resolve(output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, json);
  }
  process.stdout.write(json);
  if (!evaluation.gate.passed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { evaluateStoryCaptureGate, percentile, summarize };
