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
  for (const field of [
    'captureTimeMs',
    'cpuTimeMs',
    'navigationCount',
    'peakRssBytes',
    'sessionGenerationCount',
    'wallTimeMs',
  ]) {
    if (typeof run[field] !== 'number' || !Number.isFinite(run[field]) || run[field] < 0) {
      errors.push(`${label}.${field} must be a non-negative finite number.`);
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

function validateAlternatingPairs(pairs, labels, errors) {
  let previous;
  pairs.forEach((pair, index) => {
    if (!pair || typeof pair !== 'object') {
      errors.push(`pairs[${index}] must be an object.`);
      return;
    }
    if (
      !Array.isArray(pair.order) ||
      pair.order.length !== labels.length ||
      new Set(pair.order).size !== labels.length
    ) {
      errors.push(`pairs[${index}].order must contain ${labels.join(' and ')} exactly once.`);
      return;
    }
    if (pair.order.some(label => !labels.includes(label))) {
      errors.push(`pairs[${index}].order contains an unknown implementation.`);
    }
    if (previous === pair.order[0]) errors.push(`pairs[${index}] does not alternate the starting implementation.`);
    previous = pair.order[0];
  });
}

function evaluateRecycleExperiment(record, expectedCaptures) {
  if (!Array.isArray(record?.noRecyclePairs) || record.noRecyclePairs.length === 0) return { measured: false };
  const errors = [];
  if (record.noRecyclePairs.length < 3) errors.push('noRecyclePairs requires at least three measured pairs.');
  validateAlternatingPairs(record.noRecyclePairs, ['default128', 'unlimited'], errors);
  const defaultRuns = [];
  const unlimitedRuns = [];
  record.noRecyclePairs.forEach((pair, index) => {
    const entry = pair && typeof pair === 'object' ? pair : {};
    validateRun(entry.default128, `noRecyclePairs[${index}].default128`, expectedCaptures, errors);
    validateRun(entry.unlimited, `noRecyclePairs[${index}].unlimited`, expectedCaptures, errors);
    if (entry.default128) defaultRuns.push(entry.default128);
    if (entry.unlimited) unlimitedRuns.push(entry.unlimited);
  });
  const defaultSummary = summarize(defaultRuns);
  const unlimitedSummary = summarize(unlimitedRuns);
  const wallP50Ratio = ratio(unlimitedSummary.wallP50Ms, defaultSummary.wallP50Ms);
  const rssToRc0 = ratio(unlimitedSummary.peakRssP50Bytes, record.rc0?.peakRssP50Bytes);
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
    if (typeof scenario[field] !== 'string' || scenario[field].length === 0)
      errors.push(`scenario.${field} is required.`);
  }
  for (const field of ['commit', 'packageHash', 'tree', 'version']) {
    if (typeof record?.storyfreeze?.[field] !== 'string' || record.storyfreeze[field].length === 0) {
      errors.push(`storyfreeze.${field} is required.`);
    }
  }
  for (const field of ['packageHash', 'version']) {
    if (typeof record?.storycapture?.[field] !== 'string' || record.storycapture[field].length === 0) {
      errors.push(`storycapture.${field} is required.`);
    }
  }
  if (typeof record?.rc0?.cpuP50Ms !== 'number' || record.rc0.cpuP50Ms <= 0) errors.push('rc0.cpuP50Ms is required.');
  if (typeof record?.rc0?.peakRssP50Bytes !== 'number' || record.rc0.peakRssP50Bytes <= 0) {
    errors.push('rc0.peakRssP50Bytes is required.');
  }

  const pairs = Array.isArray(record?.pairs) ? record.pairs : [];
  if (pairs.length < 5) errors.push(`At least five measured pairs are required, got ${pairs.length}.`);
  validateAlternatingPairs(pairs, ['storycapture', 'storyfreeze'], errors);
  const storycaptureRuns = [];
  const storyfreezeRuns = [];
  pairs.forEach((pair, index) => {
    const entry = pair && typeof pair === 'object' ? pair : {};
    validateRun(entry.storycapture, `pairs[${index}].storycapture`, expectedCaptures, errors);
    validateRun(entry.storyfreeze, `pairs[${index}].storyfreeze`, expectedCaptures, errors);
    if (entry.storycapture) storycaptureRuns.push(entry.storycapture);
    if (entry.storyfreeze) storyfreezeRuns.push(entry.storyfreeze);
  });

  const storycapture = summarize(storycaptureRuns);
  const storyfreeze = summarize(storyfreezeRuns);
  const ratios = {
    cpuToRc0: ratio(storyfreeze.cpuP50Ms, record?.rc0?.cpuP50Ms),
    peakRssToRc0: ratio(storyfreeze.peakRssP50Bytes, record?.rc0?.peakRssP50Bytes),
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

  const recycleExperiment = evaluateRecycleExperiment(record, expectedCaptures);
  if (errors.length > 0 && recycleExperiment.measured) recycleExperiment.adopt = false;
  return {
    schemaVersion: 1,
    kind: 'storycapture-performance-gate-evaluation',
    source: {
      recordedAt: record?.recordedAt,
      scenario,
      storycapture: record?.storycapture,
      storyfreeze: record?.storyfreeze,
    },
    summaries: { storycapture, storyfreeze },
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
