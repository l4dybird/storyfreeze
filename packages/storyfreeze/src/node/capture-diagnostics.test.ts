import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import fs from 'node:fs';
import {
  CAPTURE_DIAGNOSTIC_PREFIX,
  emitCaptureDiagnostic,
  measureCaptureDiagnostic,
  subscribeCaptureDiagnostics,
} from './capture-diagnostics.js';

function completeStdoutWrite(...args: unknown[]) {
  const callback = args.find(value => typeof value === 'function') as (() => void) | undefined;
  callback?.();
  return true;
}

describe('capture diagnostics', () => {
  const originalValue = process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalValue === undefined) delete process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS;
    else process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS = originalValue;
  });

  it('does not write or add an asynchronous boundary when diagnostics are disabled', async () => {
    delete process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS;
    const write = vi.spyOn(fs, 'write').mockImplementation(completeStdoutWrite as never);
    let called = false;

    const result = await measureCaptureDiagnostic({ type: 'capture-phase', phase: 'test' }, async () => {
      called = true;
      return 42;
    });
    emitCaptureDiagnostic({ type: 'capture-complete' });

    expect(called).toBe(true);
    expect(result).toBe(42);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes prefix-delimited JSON and records failed phase durations', async () => {
    process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS = '1';
    const write = vi.spyOn(fs, 'write').mockImplementation(completeStdoutWrite as never);

    await expect(
      measureCaptureDiagnostic({ type: 'capture-phase', phase: 'test' }, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');

    expect(write).toHaveBeenCalledTimes(2);
    const line = String(write.mock.calls[1][1]);
    expect(line.startsWith(CAPTURE_DIAGNOSTIC_PREFIX)).toBe(true);
    expect(JSON.parse(line.slice(CAPTURE_DIAGNOSTIC_PREFIX.length))).toMatchObject({
      type: 'capture-phase',
      phase: 'test',
      durationMs: expect.any(Number),
      state: 'end',
    });
  });

  it('notifies temporary diagnostic subscribers without allowing them to affect capture', () => {
    process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS = '1';
    vi.spyOn(fs, 'write').mockImplementation(completeStdoutWrite as never);
    const events: string[] = [];
    const unsubscribe = subscribeCaptureDiagnostics(event => events.push(event.type));
    const unsubscribeThrowing = subscribeCaptureDiagnostics(() => {
      throw new Error('diagnostic observer failed');
    });

    emitCaptureDiagnostic({ type: 'first' });
    unsubscribeThrowing();
    unsubscribe();
    emitCaptureDiagnostic({ type: 'second' });

    expect(events).toEqual(['first']);
  });

  it('does not let circular JSON or a failing stdout write affect capture', () => {
    process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS = '1';
    const write = vi.spyOn(fs, 'write').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const circular: Record<string, unknown> = { type: 'circular' };
    circular.self = circular;

    expect(() => emitCaptureDiagnostic(circular as { type: string })).not.toThrow();
    expect(() => emitCaptureDiagnostic({ type: 'write-failure' })).not.toThrow();
    expect(write).toHaveBeenCalledOnce();
  });

  it('does not install a process-wide stdout error listener', async () => {
    process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS = '1';
    const listenersBefore = process.stdout.listenerCount('error');
    vi.spyOn(fs, 'write').mockImplementation(((...args: unknown[]) => {
      const callback = args.find(value => typeof value === 'function') as ((error?: Error | null) => void) | undefined;
      const error = new Error('EPIPE');
      callback?.(error);
    }) as never);

    expect(() => emitCaptureDiagnostic({ type: 'write-failure' })).not.toThrow();
    expect(process.stdout.listenerCount('error')).toBe(listenersBefore);
  });

  it('retries short writes until the complete UTF-8 diagnostic line is emitted', async () => {
    process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS = '1';
    const chunks: Buffer[] = [];
    const write = vi.spyOn(fs, 'write').mockImplementation(((_fd, data, offset, length, _position, callback) => {
      const buffer = data as Buffer;
      const bytesWritten = Math.min(5, length as number);
      chunks.push(buffer.subarray(offset as number, (offset as number) + bytesWritten));
      callback?.(null, bytesWritten, buffer);
    }) as never);
    const event = { type: 'partial-write', detail: 'あ'.repeat(20) };
    const expected = `${CAPTURE_DIAGNOSTIC_PREFIX}${JSON.stringify(event)}\n`;

    emitCaptureDiagnostic(event);

    await vi.waitFor(() => expect(Buffer.concat(chunks).byteLength).toBe(Buffer.byteLength(expected)));
    expect(Buffer.concat(chunks).toString('utf8')).toBe(expected);
    expect(write.mock.calls.length).toBeGreaterThan(1);
  });

  it('bounds queued diagnostics while stdout is stalled', async () => {
    process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS = '1';
    const completions: Array<() => void> = [];
    const write = vi.spyOn(fs, 'write').mockImplementation(((_fd, data, _offset, length, _position, callback) => {
      completions.push(() => callback?.(null, length as number, data as Buffer));
    }) as never);

    for (let index = 0; index < 80; index += 1) {
      emitCaptureDiagnostic({ type: 'stalled-output', detail: `${index}:${'x'.repeat(64 * 1024)}` });
    }

    for (let index = 0; index < completions.length; index += 1) {
      completions[index]();
      await Promise.resolve();
    }

    expect(write.mock.calls.length).toBeGreaterThan(1);
    expect(write.mock.calls.length).toBeLessThan(20);
  });
});
