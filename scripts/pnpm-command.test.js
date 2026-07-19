const assert = require('node:assert/strict');
const test = require('node:test');
const { resolvePnpmCommand } = require('./pnpm-command.js');

function fakeFiles(...files) {
  const normalized = new Set(files.map(file => file.toLowerCase()));
  return file => normalized.has(file.toLowerCase());
}

test('uses the inherited pnpm Node CLI without a shell', () => {
  const result = resolvePnpmCommand(['run', 'build'], {
    platform: 'win32',
    environment: { npm_execpath: 'C:\\tools\\pnpm.cjs' },
    nodeExecutable: 'C:\\node\\node.exe',
    isFile: fakeFiles('C:\\tools\\pnpm.cjs'),
  });

  assert.deepEqual(result, {
    command: 'C:\\node\\node.exe',
    args: ['C:\\tools\\pnpm.cjs', 'run', 'build'],
  });
});

test('uses pnpm.exe from PATH on Windows', () => {
  const result = resolvePnpmCommand(['test'], {
    platform: 'win32',
    environment: { Path: 'C:\\first;C:\\pnpm-home' },
    nodeExecutable: 'C:\\node\\node.exe',
    isFile: fakeFiles('C:\\pnpm-home\\pnpm.exe'),
  });

  assert.deepEqual(result, {
    command: 'C:\\pnpm-home\\pnpm.exe',
    args: ['test'],
  });
});

test('uses the Node CLI behind an npm-style Windows shim', () => {
  const result = resolvePnpmCommand(['install'], {
    platform: 'win32',
    environment: { PATH: 'C:\\pnpm\\node_modules\\.bin' },
    nodeExecutable: 'C:\\node\\node.exe',
    isFile: fakeFiles('C:\\pnpm\\node_modules\\pnpm\\bin\\pnpm.cjs'),
  });

  assert.deepEqual(result, {
    command: 'C:\\node\\node.exe',
    args: ['C:\\pnpm\\node_modules\\pnpm\\bin\\pnpm.cjs', 'install'],
  });
});

test('fails clearly instead of falling back to a Windows command shell', () => {
  assert.throws(
    () =>
      resolvePnpmCommand(['test'], {
        platform: 'win32',
        environment: { PATH: 'C:\\bin' },
        nodeExecutable: 'C:\\node\\node.exe',
        isFile: () => false,
      }),
    /Unable to locate a directly executable pnpm binary/,
  );
});

test('uses the PATH command directly on non-Windows platforms', () => {
  assert.deepEqual(
    resolvePnpmCommand(['test'], {
      platform: 'linux',
      environment: {},
      nodeExecutable: '/usr/bin/node',
      isFile: () => false,
    }),
    { command: 'pnpm', args: ['test'] },
  );
});
