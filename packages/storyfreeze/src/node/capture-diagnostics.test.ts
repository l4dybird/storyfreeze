import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  CAPTURE_DIAGNOSTIC_PREFIX,
  emitCaptureDiagnostic,
  measureCaptureDiagnostic,
  subscribeCaptureDiagnostics,
} from './capture-diagnostics.js';

describe('capture diagnostics', () => {
  const originalValue = process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalValue === undefined) delete process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS;
    else process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS = originalValue;
  });

  it('does not write or add an asynchronous boundary when diagnostics are disabled', async () => {
    delete process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
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
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(
      measureCaptureDiagnostic({ type: 'capture-phase', phase: 'test' }, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');

    expect(write).toHaveBeenCalledTimes(2);
    const line = String(write.mock.calls[1][0]);
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
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
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
});
