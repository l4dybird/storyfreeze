import { describe, expect, it } from 'vite-plus/test';
import { CaptureDeadline } from './capture-deadline.js';
import { CaptureAttemptTimeoutError } from './errors.js';

describe(CaptureDeadline, () => {
  it('pre-observes an interruption until a caller attaches its race', async () => {
    const deadline = new CaptureDeadline(5, 'delayed-race');
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      await expect(deadline.interruption).rejects.toBeInstanceOf(CaptureAttemptTimeoutError);
    } finally {
      deadline.dispose();
    }
  });
});
