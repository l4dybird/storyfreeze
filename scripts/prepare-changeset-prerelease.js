#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const packagePath = path.join(rootDir, 'packages', 'storyfreeze', 'package.json');
const preStatePath = path.join(rootDir, '.changeset', 'pre.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const preState = JSON.parse(fs.readFileSync(preStatePath, 'utf8'));
const initialVersion = preState.initialVersions?.[packageJson.name];

// The existing alpha predates Changesets. Normalize it once so the first
// Changesets minor release starts a new 0.2.0-alpha series.
if (
  preState.mode === 'pre' &&
  preState.changesets.length === 0 &&
  initialVersion &&
  packageJson.version.startsWith(`${initialVersion}-`)
) {
  packageJson.version = initialVersion;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log(`Normalized ${packageJson.name} to ${initialVersion} before entering Changesets prerelease mode.`);
}
