const assert = require('node:assert/strict');
const test = require('node:test');

const { compareReleaseVersions, getReleaseMetadata } = require('./get-dist-tag.js');
const { createPublishArguments } = require('./publish-dry-run.js');

test('maps alpha releases to next and GitHub prereleases', () => {
  assert.deepEqual(getReleaseMetadata('1.0.0-alpha.0'), {
    channel: 'alpha',
    distTag: 'next',
    prerelease: true,
    version: '1.0.0-alpha.0',
  });
});

test('maps release candidates to next and GitHub prereleases', () => {
  assert.deepEqual(getReleaseMetadata('1.0.0-rc.3'), {
    channel: 'rc',
    distTag: 'next',
    prerelease: true,
    version: '1.0.0-rc.3',
  });
});

test('maps stable releases to latest and final GitHub releases', () => {
  assert.deepEqual(getReleaseMetadata('1.0.0'), {
    channel: 'stable',
    distTag: 'latest',
    prerelease: false,
    version: '1.0.0',
  });
});

test('rejects unsupported prerelease channels and invalid semver identifiers', () => {
  for (const version of ['1.0.0-beta.0', '1.0.0-alpha', '1.0.0-alpha.01', '01.0.0', 'v1.0.0']) {
    assert.throws(() => getReleaseMetadata(version), /Unsupported release version/);
  }
});

test('passes the derived npm dist-tag to the publish dry run', () => {
  assert.deepEqual(createPublishArguments('1.0.0-rc.0').slice(-6), [
    '--tag',
    'next',
    '--access',
    'public',
    '--registry',
    'https://registry.npmjs.org/',
  ]);
  assert.equal(createPublishArguments('1.0.0').at(-5), 'latest');
});

test('orders supported releases without moving a dist-tag backwards', () => {
  assert.equal(compareReleaseVersions('1.0.0-alpha.2', '1.0.0-alpha.1'), 1);
  assert.equal(compareReleaseVersions('1.0.0-rc.0', '1.0.0-alpha.9'), 1);
  assert.equal(compareReleaseVersions('1.0.0', '1.0.0-rc.9'), 1);
  assert.equal(compareReleaseVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareReleaseVersions('1.0.0-alpha.0', '1.0.0-rc.0'), -1);
  assert.equal(compareReleaseVersions('2.0.0-alpha.0', '1.9.9'), 1);
});
