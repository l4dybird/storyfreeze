import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { FileSystem } from './file.js';
import type { MainOptions } from './types.js';

describe(FileSystem, () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storyfreeze-file-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it('bounds concurrent writes and creates a shared output directory once', async () => {
    const fileSystem = new FileSystem({ outDir, flat: false, parallel: 2 } as MainOptions);
    const originalWriteFile = fs.writeFile.bind(fs);
    let active = 0;
    let peak = 0;
    vi.spyOn(fs, 'writeFile').mockImplementation((async (...args: Parameters<typeof fs.writeFile>) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => setImmediate(resolve));
      try {
        return await originalWriteFile(...args);
      } finally {
        active -= 1;
      }
    }) as typeof fs.writeFile);
    const mkdir = vi.spyOn(fs, 'mkdir');

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        fileSystem.saveScreenshot('Button', `Story ${index}`, [], Buffer.from(`png-${index}`)),
      ),
    );
    await fileSystem.flush();

    expect(peak).toBe(2);
    expect(mkdir).toHaveBeenCalledTimes(1);
  });

  it('applies byte backpressure before pending screenshot buffers are created', async () => {
    const fileSystem = new FileSystem({ outDir, flat: false, parallel: 8 } as MainOptions);
    const bufferBytes = 16 * 1024 * 1024;
    let produced = 0;
    let retainedBytes = 0;
    let peakRetainedBytes = 0;
    let releaseWrites = () => {};
    const writesBlocked = new Promise<void>(resolve => (releaseWrites = resolve));
    vi.spyOn(fs, 'writeFile').mockImplementation(async () => writesBlocked);
    vi.spyOn(fs, 'rename').mockImplementation(async () => {});

    const operations = Array.from({ length: 8 }, async (_, index) => {
      const buffer = await fileSystem.captureScreenshot(bufferBytes, async () => {
        produced += 1;
        retainedBytes += bufferBytes;
        peakRetainedBytes = Math.max(peakRetainedBytes, retainedBytes);
        return Buffer.alloc(bufferBytes);
      });
      try {
        await fileSystem.saveScreenshot('Button', `Story ${index}`, [], buffer!);
      } finally {
        retainedBytes -= bufferBytes;
      }
    });

    await vi.waitFor(() => expect(produced).toBe(4));
    expect(peakRetainedBytes).toBe(64 * 1024 * 1024);
    releaseWrites();
    await Promise.all(operations);
    expect(produced).toBe(8);
    expect(retainedBytes).toBe(0);
  });

  it('removes an aborted producer from the screenshot reservation queue', async () => {
    const fileSystem = new FileSystem({ outDir, flat: false, parallel: 2 } as MainOptions);
    const held = await fileSystem.captureScreenshot(64 * 1024 * 1024, async () => Buffer.alloc(64 * 1024 * 1024));
    const capture = vi.fn(async () => Buffer.from('cancelled'));
    const controller = new AbortController();
    const waiting = fileSystem.captureScreenshot(1, capture, controller.signal);

    controller.abort(new Error('capture cancelled'));

    await expect(waiting).rejects.toThrow('capture cancelled');
    expect(capture).not.toHaveBeenCalled();
    fileSystem.releaseScreenshotBuffer(held);
  });

  it('removes an aborted output from the write queue before it retains a writer slot', async () => {
    const fileSystem = new FileSystem({ outDir, flat: false, parallel: 1 } as MainOptions);
    const originalWriteFile = fs.writeFile.bind(fs);
    let releaseWrite = () => {};
    const writeBlocked = new Promise<void>(resolve => (releaseWrite = resolve));
    vi.spyOn(fs, 'writeFile').mockImplementationOnce((async (...args: Parameters<typeof fs.writeFile>) => {
      await writeBlocked;
      return originalWriteFile(...args);
    }) as typeof fs.writeFile);
    const first = fileSystem.saveScreenshot('Button', 'First', [], Buffer.from('first'));
    await vi.waitFor(() => expect(fs.writeFile).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const second = fileSystem.saveScreenshot(
      'Button',
      'Second',
      [],
      Buffer.from('second'),
      undefined,
      controller.signal,
    );

    controller.abort(new Error('output cancelled'));

    await expect(second).rejects.toThrow('output cancelled');
    expect(fs.writeFile).toHaveBeenCalledOnce();
    releaseWrite();
    await first;
  });

  it('closes the writer and flush fails after an output error', async () => {
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.writeFile(outDir, 'not a directory');
    const fileSystem = createFileSystem(false);

    await expect(fileSystem.saveScreenshot('Button', 'First', [], Buffer.from('png'))).rejects.toThrow();
    await expect(fileSystem.saveScreenshot('Button', 'Second', [], Buffer.from('png'))).rejects.toThrow();
    await expect(fileSystem.flush()).rejects.toThrow();
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
