import { sleep } from './async-utils.js';
import { CaptureAttemptTimeoutError } from './errors.js';

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.');
}

export class CaptureDeadline {
  private readonly controller = new AbortController();
  private readonly expiresAt: number;
  private readonly timeoutHandle?: ReturnType<typeof setTimeout>;
  private readonly parentSignal?: AbortSignal;
  private readonly onParentAbort: () => void;
  private timedOut = false;
  readonly interruption: Promise<never>;
  readonly timeoutError: CaptureAttemptTimeoutError;

  constructor(timeoutMs: number, requestId: string, parentSignal?: AbortSignal) {
    const effectiveTimeout = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 5000;
    this.expiresAt = Date.now() + effectiveTimeout;
    this.timeoutError = new CaptureAttemptTimeoutError(effectiveTimeout, requestId);
    this.parentSignal = parentSignal;
    this.onParentAbort = () => this.controller.abort(abortReason(parentSignal!));
    if (parentSignal?.aborted) this.onParentAbort();
    else parentSignal?.addEventListener('abort', this.onParentAbort, { once: true });

    if (!this.controller.signal.aborted) {
      this.timeoutHandle = setTimeout(() => {
        this.timedOut = true;
        this.controller.abort(this.timeoutError);
      }, effectiveTimeout);
    }
    this.interruption = new Promise<never>((_resolve, reject) => {
      if (this.controller.signal.aborted) reject(abortReason(this.controller.signal));
      else {
        this.controller.signal.addEventListener('abort', () => reject(abortReason(this.controller.signal)), {
          once: true,
        });
      }
    });
  }

  get signal() {
    return this.controller.signal;
  }

  get didTimeout() {
    return this.timedOut;
  }

  remaining(maximum = Number.POSITIVE_INFINITY) {
    this.throwIfAborted();
    const remaining = this.expiresAt - Date.now();
    if (remaining <= 0) {
      this.timedOut = true;
      this.controller.abort(this.timeoutError);
      throw this.timeoutError;
    }
    return Math.min(maximum, remaining);
  }

  navigationTimeout(maximum = 60_000) {
    return Math.max(1, Math.floor(this.remaining(maximum)));
  }

  async wait(milliseconds: number) {
    this.throwIfAborted();
    if (milliseconds <= 0) return;
    await Promise.race([sleep(milliseconds), this.interruption]);
  }

  dispose() {
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    this.parentSignal?.removeEventListener('abort', this.onParentAbort);
  }

  private throwIfAborted() {
    if (this.controller.signal.aborted) throw abortReason(this.controller.signal);
  }
}
