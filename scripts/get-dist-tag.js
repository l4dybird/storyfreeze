const path = require('path');

const numericIdentifier = '(?:0|[1-9]\\d*)';
const stablePattern = new RegExp(`^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}$`);
const prereleasePattern = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}-(alpha|rc)\\.${numericIdentifier}$`,
);

function getReleaseMetadata(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new TypeError('A package version is required.');
  }

  if (stablePattern.test(version)) {
    return { channel: 'stable', distTag: 'latest', prerelease: false, version };
  }

  const prerelease = version.match(prereleasePattern);
  if (prerelease) {
    return { channel: prerelease[1], distTag: 'next', prerelease: true, version };
  }

  throw new Error(`Unsupported release version ${version}. Expected x.y.z, x.y.z-alpha.n, or x.y.z-rc.n.`);
}

function compareReleaseVersions(left, right) {
  const leftMetadata = getReleaseMetadata(left);
  const rightMetadata = getReleaseMetadata(right);
  const channelRank = { alpha: 0n, rc: 1n, stable: 2n };
  const toComparable = (version, metadata) => {
    const identifiers = version.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-(?:alpha|rc)\.([0-9]+))?$/);
    return [
      BigInt(identifiers[1]),
      BigInt(identifiers[2]),
      BigInt(identifiers[3]),
      channelRank[metadata.channel],
      BigInt(identifiers[4] || 0),
    ];
  };
  const leftIdentifiers = toComparable(left, leftMetadata);
  const rightIdentifiers = toComparable(right, rightMetadata);
  for (let index = 0; index < leftIdentifiers.length; index += 1) {
    if (leftIdentifiers[index] < rightIdentifiers[index]) return -1;
    if (leftIdentifiers[index] > rightIdentifiers[index]) return 1;
  }
  return 0;
}

function readPackageVersion() {
  return require(path.resolve(__dirname, '../packages/storyfreeze/package.json')).version;
}

if (require.main === module) {
  const arguments = process.argv.slice(2);
  const json = arguments.includes('--json');
  const version = arguments.find(argument => argument !== '--json') || readPackageVersion();
  const metadata = getReleaseMetadata(version);
  process.stdout.write(`${json ? JSON.stringify(metadata) : metadata.distTag}\n`);
}

module.exports = { compareReleaseVersions, getReleaseMetadata };
