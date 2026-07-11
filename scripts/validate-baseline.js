#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const baselinePath = path.resolve(__dirname, '../baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const requiredStringFields = [
  'upstream',
  'commit',
  'package',
  'packageManager',
  'node',
  'chromium',
  'osImage',
  'capturedAt',
];

const missing = requiredStringFields.filter(
  field => typeof baseline[field] !== 'string' || baseline[field].trim() === '' || baseline[field].includes('<'),
);

if (missing.length) {
  console.error(`baseline.json contains missing or placeholder fields: ${missing.join(', ')}`);
  process.exit(1);
}

if (!/^[a-f0-9]{40}$/.test(baseline.commit)) {
  console.error('baseline.json#commit must be a full 40-character Git commit SHA.');
  process.exit(1);
}

if (Number.isNaN(Date.parse(baseline.capturedAt))) {
  console.error('baseline.json#capturedAt must be an ISO-8601 timestamp.');
  process.exit(1);
}

console.log(
  `Baseline verified: ${baseline.package}, commit ${baseline.commit}, Chromium ${baseline.chromium}, ${baseline.osImage}`,
);
