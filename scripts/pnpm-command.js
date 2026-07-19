const fs = require('fs');
const path = require('path');

function readEnvironmentValue(environment, name) {
  const entry = Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function defaultIsFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolvePnpmCommand(args, options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const nodeExecutable = options.nodeExecutable || process.execPath;
  const isFile = options.isFile || defaultIsFile;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const inheritedCli = readEnvironmentValue(environment, 'npm_execpath');

  if (inheritedCli && /^pnpm\.(?:cjs|mjs|js)$/i.test(pathApi.basename(inheritedCli)) && isFile(inheritedCli)) {
    return { command: nodeExecutable, args: [inheritedCli, ...args] };
  }

  if (platform !== 'win32') return { command: 'pnpm', args };

  const pnpmHome = readEnvironmentValue(environment, 'PNPM_HOME');
  const pathValue = readEnvironmentValue(environment, 'PATH') || '';
  const pathDirectories = pathValue.split(';').filter(Boolean);
  const executableCandidates = [
    ...(pnpmHome ? [pathApi.join(pnpmHome, 'pnpm.exe'), pathApi.join(pnpmHome, 'bin', 'pnpm.exe')] : []),
    ...pathDirectories.map(directory => pathApi.join(directory, 'pnpm.exe')),
  ];
  const executable = executableCandidates.find(isFile);
  if (executable) return { command: executable, args };

  const cliRoots = [pathApi.dirname(nodeExecutable), ...(pnpmHome ? [pnpmHome] : []), ...pathDirectories];
  const cliCandidates = cliRoots.flatMap(directory => [
    pathApi.join(directory, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
    pathApi.join(directory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    pathApi.join(directory, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    pathApi.join(directory, '..', 'pnpm', 'bin', 'pnpm.cjs'),
    pathApi.join(directory, '..', 'pnpm', 'bin', 'pnpm.mjs'),
  ]);
  const cli = cliCandidates.find(isFile);
  if (cli) return { command: nodeExecutable, args: [cli, ...args] };

  throw new Error(
    'Unable to locate a directly executable pnpm binary on Windows. Install pnpm with pnpm/action-setup, the standalone installer, or Volta.',
  );
}

module.exports = { resolvePnpmCommand };
