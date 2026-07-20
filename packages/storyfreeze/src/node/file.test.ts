import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { MainOptions } from './types.js';
import { estimateScreenshotBufferReservation, FileSystem, MAXIMUM_RETAINED_SCREENSHOT_BYTES } from './file.js';

describe(FileSystem, () => {
  const roots: string[] = [];

  async function output(flat = false, parallel = 4) {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storyfreeze-output-'));
    roots.push(outDir);
    return { outDir, fileSystem: new FileSystem({ outDir, flat, parallel } as MainOptions) };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  it('estimates a conservative raw RGBA reservation', () => {
    expect(estimateScreenshotBufferReservation({ width: 100, height: 50, deviceScaleFactor: 2 })).toBeGreaterThan(
      100 * 50 * 4 * 4,
    );
    expect(estimateScreenshotBufferReservation(undefined)).toBeUndefined();
  });

  it('preserves nested, flat, suffix, and atomic replacement paths', async () => {
    const nested = await output();
    const first = await nested.fileSystem.saveScreenshot(
      'Forms/Input',
      'Focused',
      ['mobile'],
      Buffer.from('first'),
      'one',
    );
    expect(path.relative(nested.outDir, first)).toBe(path.join('Forms', 'Input', 'Focused_mobile.png'));
    await nested.fileSystem.saveScreenshot('Forms/Input', 'Focused', ['mobile'], Buffer.from('second'), 'one');
    await expect(fs.readFile(first, 'utf8')).resolves.toBe('second');
    expect((await fs.readdir(path.dirname(first))).some(file => file.endsWith('.tmp'))).toBe(false);

    const flat = await output(true);
    const flatPath = await flat.fileSystem.saveScreenshot('Forms/Input', 'Focused', [], Buffer.from('png'));
    expect(path.relative(flat.outDir, flatPath)).toBe('Forms_Input_Focused.png');
  });

  it('keeps one weighted permit from capture through atomic write', async () => {
    const { fileSystem } = await output(false, 2);
    const reservation = 40 * 1024 * 1024;
    let secondStarted = false;
    const first = await fileSystem.captureScreenshot(reservation, async () => Buffer.alloc(33 * 1024 * 1024));
    const secondCapture = fileSystem.captureScreenshot(reservation, async () => {
      secondStarted = true;
      return Buffer.from('second');
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(secondStarted).toBe(false);

    await fileSystem.saveScreenshot('Budget', 'First', [], first!);
    const second = await secondCapture;
    expect(secondStarted).toBe(true);
    fileSystem.releaseScreenshotBuffer(second);
    expect(MAXIMUM_RETAINED_SCREENSHOT_BYTES).toBe(64 * 1024 * 1024);
  });

  it('removes an aborted waiter without consuming a permit', async () => {
    const { fileSystem } = await output(false, 1);
    const first = await fileSystem.captureScreenshot(1024, async () => Buffer.from('first'));
    const controller = new AbortController();
    const waiting = fileSystem.captureScreenshot(1024, async () => Buffer.from('never'), controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
    fileSystem.releaseScreenshotBuffer(first);
    await expect(fileSystem.captureScreenshot(1024, async () => Buffer.from('next'))).resolves.toEqual(
      Buffer.from('next'),
    );
  });

  it('sanitizes suffixes, contains paths, and rejects logical collisions', async () => {
    const { outDir, fileSystem } = await output();
    const safe = await fileSystem.saveScreenshot(
      'Forms',
      'Input',
      ['../../../../../outside'],
      Buffer.from('png'),
      'safe',
    );
    expect(path.relative(outDir, safe).startsWith('..')).toBe(false);

    await fileSystem.saveScreenshot('Forms', 'Focused: state', [], Buffer.from('one'), 'one');
    await expect(fileSystem.saveScreenshot('Forms', 'Focused state', [], Buffer.from('two'), 'two')).rejects.toThrow(
      'Output path collision',
    );

    await fileSystem.saveScreenshot('Variants', 'Input', ['a_b'], Buffer.from('one'), 'variant-one');
    await expect(
      fileSystem.saveScreenshot('Variants', 'Input', ['a', 'b'], Buffer.from('two'), 'variant-two'),
    ).rejects.toThrow('Output path collision');
  });

  it('rejects a directory symlink to the output root parent', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'storyfreeze-output-parent-'));
    roots.push(parent);
    const outDir = path.join(parent, 'output');
    await fs.mkdir(outDir);
    const fileSystem = new FileSystem({ outDir, flat: false, parallel: 4 } as MainOptions);
    await fs.symlink(parent, path.join(outDir, 'Linked'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(fileSystem.saveScreenshot('Linked', 'Escaped', [], Buffer.from('png'))).rejects.toThrow(
      'outside the output directory',
    );
    await expect(fs.stat(path.join(parent, 'Escaped.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revalidates a directory symlink before every write', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'storyfreeze-output-retarget-'));
    roots.push(parent);
    const outDir = path.join(parent, 'output');
    const inside = path.join(outDir, 'inside');
    const linked = path.join(outDir, 'Linked');
    await fs.mkdir(inside, { recursive: true });
    await fs.symlink(inside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const fileSystem = new FileSystem({ outDir, flat: false, parallel: 4 } as MainOptions);

    await fileSystem.saveScreenshot('Linked', 'First', [], Buffer.from('first'));
    await fs.rm(linked, { force: true });
    await fs.symlink(parent, linked, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(fileSystem.saveScreenshot('Linked', 'Second', [], Buffer.from('second'))).rejects.toThrow(
      'outside the output directory',
    );
    await expect(fs.stat(path.join(parent, 'Second.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('closes the output owner after an atomic write failure', async () => {
    const { fileSystem } = await output();
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));
    await expect(fileSystem.saveScreenshot('Button', 'Primary', [], Buffer.from('png'))).rejects.toThrow(
      'rename failed',
    );
    await expect(fileSystem.flush()).rejects.toThrow('rename failed');
  });
});
