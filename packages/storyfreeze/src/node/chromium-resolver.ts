/*
 * Chromium discovery is derived from reg-viz/storycrawler.
 * Copyright (c) 2019 reg-viz. Licensed under the MIT License.
 * https://github.com/reg-viz/storycap/tree/master/packages/storycrawler
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChromeChannel } from './browser-backend.js';

const newLineRegex = /\r?\n/;

export type FindChromeOptions = {
  executablePath?: string;
  channel?: ChromeChannel;
};

export type FindChromeResult =
  | { executablePath: string; type: 'user' | 'canary' | 'stable' }
  | { executablePath: null; type: null };

function canAccess(file: string | undefined): file is string {
  if (!file) return false;
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function findChromeExecutables(folder: string) {
  const argumentsRegex = /(^[^ ]+).*/;
  const chromeExecRegex = '^Exec=/.*/(google-chrome|chrome|chromium)-.*';
  const installations: string[] = [];

  if (canAccess(folder)) {
    let execPaths: Buffer;
    try {
      execPaths = execFileSync('grep', ['-ER', chromeExecRegex, folder]);
    } catch {
      try {
        execPaths = execFileSync('grep', ['-Er', chromeExecRegex, folder]);
      } catch {
        return installations;
      }
    }
    execPaths
      .toString()
      .split(newLineRegex)
      .map(line => line.slice(line.indexOf('Exec=') + 'Exec='.length))
      .map(execPath => execPath.replace(argumentsRegex, '$1'))
      .forEach(execPath => canAccess(execPath) && installations.push(execPath));
  }

  return installations;
}

function sortInstallations(installations: string[], priorities: Array<{ regex: RegExp; weight: number }>) {
  const defaultPriority = 10;
  return installations
    .map(installation => {
      const priority = priorities.find(pair => pair.regex.test(installation));
      return { path: installation, weight: priority?.weight ?? defaultPriority };
    })
    .sort((a, b) => b.weight - a.weight)
    .map(pair => pair.path);
}

function findDarwinChrome(canary = false) {
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework' +
    '/Versions/A/Frameworks/LaunchServices.framework' +
    '/Versions/A/Support/lsregister';
  const grepExpression = canary ? 'google chrome canary' : 'google chrome';
  const paths = execSync(`${lsregister} -dump  | grep -i \'${grepExpression}\\?.app$\' | awk \'{$1=""; print $0}\'`)
    .toString()
    .split(newLineRegex)
    .filter(Boolean)
    .map(value => value.trim());

  paths.unshift(canary ? '/Applications/Google Chrome Canary.app' : '/Applications/Google Chrome.app');
  for (const applicationPath of paths) {
    if (applicationPath.startsWith('/Volumes')) continue;
    const executablePath = path.join(
      applicationPath,
      canary ? '/Contents/MacOS/Google Chrome Canary' : '/Contents/MacOS/Google Chrome',
    );
    if (canAccess(executablePath)) return executablePath;
  }
  return undefined;
}

function findLinuxChrome() {
  if (canAccess(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  let installations: string[] = [];
  const desktopInstallationFolders = [
    path.join(os.homedir(), '.local/share/applications/'),
    '/usr/share/applications/',
  ];
  desktopInstallationFolders.forEach(folder => {
    installations = installations.concat(findChromeExecutables(folder));
  });

  ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium'].forEach(executable => {
    try {
      const executablePath = execFileSync('which', [executable], { stdio: 'pipe' }).toString().split(newLineRegex)[0];
      if (canAccess(executablePath)) installations.push(executablePath);
    } catch {
      // Not installed.
    }
  });

  if (installations.length === 0) return undefined;

  const priorities = [
    { regex: /chrome-wrapper$/, weight: 51 },
    { regex: /google-chrome-stable$/, weight: 50 },
    { regex: /google-chrome$/, weight: 49 },
    { regex: /chromium-browser$/, weight: 48 },
    { regex: /chromium$/, weight: 47 },
  ];
  return sortInstallations([...new Set(installations.filter(Boolean))], priorities)[0];
}

function findWindowsChrome(canary = false) {
  const suffix = canary
    ? `${path.sep}Google${path.sep}Chrome SxS${path.sep}Application${path.sep}chrome.exe`
    : `${path.sep}Google${path.sep}Chrome${path.sep}Application${path.sep}chrome.exe`;
  const prefixes = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(
    (value): value is string => Boolean(value),
  );
  let result: string | undefined;
  prefixes.forEach(prefix => {
    const executablePath = path.join(prefix, suffix);
    if (canAccess(executablePath)) result = executablePath;
  });
  return result;
}

function findInstalledChrome(canary: boolean) {
  try {
    // Chrome Canary is not distributed for Linux; let the '*' channel continue to stable.
    if (process.platform === 'linux') return canary ? undefined : findLinuxChrome();
    if (process.platform === 'win32') return findWindowsChrome(canary);
    if (process.platform === 'darwin') return findDarwinChrome(canary);
    return undefined;
  } catch {
    return undefined;
  }
}

export async function findChrome(options: FindChromeOptions): Promise<FindChromeResult> {
  if (options.executablePath) return { executablePath: options.executablePath, type: 'user' };

  const channels = new Set<ChromeChannel>(options.channel ? [options.channel] : ['*']);
  if (channels.has('canary') || channels.has('*')) {
    const executablePath = findInstalledChrome(true);
    if (executablePath) return { executablePath, type: 'canary' };
  }
  if (channels.has('stable') || channels.has('*')) {
    const executablePath = findInstalledChrome(false);
    if (executablePath) return { executablePath, type: 'stable' };
  }
  return { executablePath: null, type: null };
}
