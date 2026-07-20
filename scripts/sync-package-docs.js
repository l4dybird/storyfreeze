#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageDirectory = path.join(root, 'packages', 'storyfreeze');
const files = ['README.md', 'CONTRIBUTING.md', 'MIGRATION.md', 'LICENSE'];

for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(packageDirectory, file));
}
