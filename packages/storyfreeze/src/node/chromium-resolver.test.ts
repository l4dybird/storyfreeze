import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { findChromeExecutables } from './chromium-resolver.js';

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

describe(findChromeExecutables, () => {
  const temporaryPaths: string[] = [];

  afterEach(async () => {
    vi.mocked(execFileSync).mockReset();
    await Promise.all(temporaryPaths.splice(0).map(file => fs.rm(file, { recursive: true, force: true })));
  });

  it('passes a folder with spaces and shell metacharacters as one grep argument', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'storyfreeze search $& '));
    const executableDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storyfreeze-bin-'));
    const executable = path.join(executableDir, 'google-chrome-stable');
    temporaryPaths.push(folder, executableDir);
    await fs.writeFile(executable, '');
    vi.mocked(execFileSync).mockReturnValue(
      Buffer.from(`${path.join(folder, 'chrome.desktop')}:Exec=${executable} --flag\n`),
    );

    expect(findChromeExecutables(folder)).toEqual([executable]);
    expect(execFileSync).toHaveBeenCalledWith('grep', ['-ER', '^Exec=/.*/(google-chrome|chrome|chromium)-.*', folder]);
  });
});
