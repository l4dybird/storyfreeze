import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { FileSystem } from './file.js';
import type { MainOptions } from './types.js';

describe(FileSystem, () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storyfreeze-file-'));
  });

  afterEach(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  function createFileSystem(flat: boolean) {
    return new FileSystem({ outDir, flat } as MainOptions);
  }

  it('preserves the nested output path and variant suffix contract', async () => {
    const fileSystem = createFileSystem(false);
    const buffer = Buffer.from('png baseline');

    const savedPath = await fileSystem.saveScreenshot('Forms/Input', 'Focused: state', ['SMALL', 'focused'], buffer);

    expect(path.relative(outDir, savedPath)).toBe(path.join('Forms', 'Input', 'Focused state_SMALL_focused.png'));
    await expect(fs.readFile(savedPath)).resolves.toEqual(buffer);
  });

  it('preserves the flat output path contract', async () => {
    const fileSystem = createFileSystem(true);

    const savedPath = await fileSystem.saveScreenshot('Forms/Input', 'Default', [], Buffer.from('png baseline'));

    expect(path.relative(outDir, savedPath)).toBe('Forms_Input_Default.png');
  });

  it('atomically replaces an existing screenshot without leaving temporary files', async () => {
    const fileSystem = createFileSystem(false);
    const savedPath = await fileSystem.saveScreenshot('Button', 'Primary', [], Buffer.from('first'));

    await fileSystem.saveScreenshot('Button', 'Primary', [], Buffer.from('second'));

    await expect(fs.readFile(savedPath, 'utf8')).resolves.toBe('second');
    await expect(fs.readdir(path.dirname(savedPath))).resolves.toEqual(['Primary.png']);
  });
});
