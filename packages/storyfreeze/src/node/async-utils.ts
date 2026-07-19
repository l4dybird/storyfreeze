/*
 * Portions derived from storycrawler's async utilities and timer.
 * Copyright (c) 2019 reg-viz. Licensed under the MIT License.
 * Source: https://github.com/reg-viz/storycap/tree/master/packages/storycrawler
 */

export async function sleep(msec = 0): Promise<void> {
  await Promise.resolve();
  if (msec <= 0) return;
  await new Promise<void>(resolve => setTimeout(resolve, msec));
}

export type TimeoutRaceResult<T> = { timedOut: false; value: T } | { timedOut: true };

const maximumTimerDelayMs = 2_147_483_647;

export function raceAgainstTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TimeoutRaceResult<T>> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    onAbort = () => finish(() => reject(signal?.reason));
    if (Number.isFinite(timeoutMs)) {
      const timerDelay = Math.min(maximumTimerDelayMs, Math.max(0, timeoutMs));
      timeout = setTimeout(() => finish(() => resolve({ timedOut: true })), timerDelay);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => finish(() => resolve({ timedOut: false, value })),
      error => finish(() => reject(error)),
    );
  });
}

export async function time<T>(target: Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const result = await target;
  return [result, Date.now() - start];
}
