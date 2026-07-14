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

  it('returns the validated absolute path when outDir is relative', async () => {
    await fs.rm(outDir, { recursive: true, force: true });
    outDir = await fs.mkdtemp(path.join(process.cwd(), '.storyfreeze-file-'));
    const relativeOutDir = path.relative(process.cwd(), outDir);
    const fileSystem = new FileSystem({ outDir: relativeOutDir, flat: false } as MainOptions);

    const savedPath = await fileSystem.saveScreenshot('Button', 'Primary', [], Buffer.from('png baseline'));

    expect(path.isAbsolute(relativeOutDir)).toBe(false);
    expect(savedPath).toBe(path.resolve(relativeOutDir, 'Button', 'Primary.png'));
  });

  it('atomically replaces an existing screenshot without leaving temporary files', async () => {
    const fileSystem = createFileSystem(false);
    const savedPath = await fileSystem.saveScreenshot('Button', 'Primary', [], Buffer.from('first'));

    await fileSystem.saveScreenshot('Button', 'Primary', [], Buffer.from('second'));

    await expect(fs.readFile(savedPath, 'utf8')).resolves.toBe('second');
    await expect(fs.readdir(path.dirname(savedPath))).resolves.toEqual(['Primary.png']);
  });

  it('streams trace chunks through a temporary file before committing the final path', async () => {
    const fileSystem = createFileSystem(false);
    const traceFile = await fileSystem.createTraceFile();

    await traceFile.write(Buffer.from('{"trace'));
    await traceFile.write(Buffer.from('Events":[]}'));
    const savedPath = await traceFile.commit('Button', 'Primary', [], 'button--primary');
    await traceFile.discard();

    expect(path.relative(outDir, savedPath)).toBe(path.join('Button', 'Primary_trace.json'));
    await expect(fs.readFile(savedPath, 'utf8')).resolves.toBe('{"traceEvents":[]}');
    await expect(fs.readdir(outDir)).resolves.toEqual(['Button']);
  });

  it('keeps a relative trace output path stable when cwd changes', async () => {
    await fs.rm(outDir, { recursive: true, force: true });
    const originalCwd = process.cwd();
    outDir = await fs.mkdtemp(path.join(originalCwd, '.storyfreeze-file-'));
    const alternateCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'storyfreeze-cwd-'));
    const fileSystem = new FileSystem({ outDir: path.relative(originalCwd, outDir), flat: false } as MainOptions);
    const traceFile = await fileSystem.createTraceFile();
    let savedPath = '';

    try {
      process.chdir(alternateCwd);
      await traceFile.write(Buffer.from('{"traceEvents":[]}'));
      savedPath = await traceFile.commit('Button', 'Primary', [], 'button--primary');
    } finally {
      process.chdir(originalCwd);
      await traceFile.discard();
      await fs.rm(alternateCwd, { recursive: true, force: true });
    }

    expect(savedPath).toBe(path.resolve(outDir, 'Button', 'Primary_trace.json'));
    await expect(fs.readFile(savedPath, 'utf8')).resolves.toBe('{"traceEvents":[]}');
  });

  it('sanitizes every variant suffix and keeps the resolved path inside outDir', async () => {
    const fileSystem = createFileSystem(false);

    const savedPath = await fileSystem.saveScreenshot(
      'Button',
      'Primary',
      ['../../../../../outside'],
      Buffer.from('safe'),
    );
    const relativePath = path.relative(outDir, path.resolve(savedPath));

    expect(relativePath.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.isAbsolute(relativePath)).toBe(false);
    await expect(fs.readFile(savedPath, 'utf8')).resolves.toBe('safe');
  });

  it('rejects nested story names that sanitize to the same output path', async () => {
    const fileSystem = createFileSystem(false);
    await fileSystem.saveScreenshot('Button', 'Focused: state', [], Buffer.from('first'));

    await expect(fileSystem.saveScreenshot('Button', 'Focused state', [], Buffer.from('second'))).rejects.toThrow(
      'Output path collision',
    );
  });

  it('rejects flat story paths that normalize to the same output path', async () => {
    const fileSystem = createFileSystem(true);
    await fileSystem.saveScreenshot('Forms/Input', 'Default', [], Buffer.from('first'));

    await expect(fileSystem.saveScreenshot('Forms_Input', 'Default', [], Buffer.from('second'))).rejects.toThrow(
      'Output path collision',
    );
  });

  it('rejects variant keys that join to the same suffix', async () => {
    const fileSystem = createFileSystem(false);
    await fileSystem.saveScreenshot('Button', 'Primary', ['a_b'], Buffer.from('first'));

    await expect(fileSystem.saveScreenshot('Button', 'Primary', ['a', 'b'], Buffer.from('second'))).rejects.toThrow(
      'Output path collision',
    );
  });
});
