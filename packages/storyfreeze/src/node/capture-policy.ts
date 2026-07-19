import type { RecyclingPolicy, RunMode } from './types.js';

export class StorySessionOutputCallbackError extends Error {
  constructor(readonly outputError: unknown) {
    super('A story-session output callback failed.');
    this.name = 'StorySessionOutputCallbackError';
  }
}

export class CaptureAttemptDidNotDrainError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'CaptureAttemptDidNotDrainError';
  }
}

export function containsUndrainedAttemptError(error: unknown): boolean {
  return (
    error instanceof CaptureAttemptDidNotDrainError ||
    (error instanceof AggregateError && error.errors.some(containsUndrainedAttemptError))
  );
}

export function shouldWaitForVisualCommit(mode: RunMode, viewportChanged: boolean, touched: boolean) {
  return mode === 'simple' || viewportChanged || touched;
}

export function shouldRecoverPlaywrightWorker(options: {
  aborted: boolean;
  healthy: boolean;
  maxRetryCount: number;
  protocolFault?: boolean;
  retryCount: number;
}) {
  return (
    !options.aborted &&
    (!options.healthy || options.protocolFault === true) &&
    options.retryCount < options.maxRetryCount
  );
}

export function shouldRecycleContext(
  policy: RecyclingPolicy | undefined,
  capturesInContext: number,
  contextAgeMs: number,
) {
  if (!policy) return false;
  return (
    (policy.maxCapturesPerContext !== undefined &&
      policy.maxCapturesPerContext > 0 &&
      capturesInContext >= policy.maxCapturesPerContext) ||
    (policy.maxContextAgeMs !== undefined && policy.maxContextAgeMs > 0 && contextAgeMs >= policy.maxContextAgeMs)
  );
}
