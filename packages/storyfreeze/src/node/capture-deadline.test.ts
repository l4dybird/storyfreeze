import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { CaptureDeadline } from './capture-deadline.js';
import { CaptureAttemptTimeoutError } from './errors.js';

describe(CaptureDeadline, () => {
  afterEach(() => vi.useRealTimers());

  it('pre-observes an interruption until a caller attaches its race', async () => {
    const deadline = new CaptureDeadline(5, 'delayed-race');
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      await expect(deadline.interruption).rejects.toBeInstanceOf(CaptureAttemptTimeoutError);
    } finally {
      deadline.dispose();
    }
  });

  it('cancels a pending delay timer when its parent is aborted', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = new CaptureDeadline(120_000, 'abort-delay', parent.signal);
    const waiting = deadline.wait(60_000);
    expect(vi.getTimerCount()).toBe(2);

    parent.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
    expect(vi.getTimerCount()).toBe(1);

    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
