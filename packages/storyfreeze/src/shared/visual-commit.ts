export type VisualCommitOptions = {
  paintFallbackMs: number;
  timeoutMs: number;
};

export type VisualCommitResult = {
  didTimeout: boolean;
  elapsedMs: number;
  fontsStatus: FontFaceSetLoadStatus | 'unsupported';
  imageCount: number;
  imageDecodeFailureCount: number;
  usedAnimationFrameFallback: boolean;
  visibilityState: DocumentVisibilityState;
};

export async function waitForVisualCommitInPage(
  options: VisualCommitOptions,
  externalSignal?: AbortSignal,
): Promise<VisualCommitResult> {
  const startedAt = performance.now();
  if (externalSignal?.aborted) throw externalSignal.reason;

  const controller = new AbortController();
  let didTimeout = false;
  let imageDecodeFailureCount = 0;
  let usedAnimationFrameFallback = false;
  const images = Array.from(document.images);

  const abortError = () => controller.signal.reason ?? new Error('Visual commit wait was aborted.');
  const raceWithAbort = <T>(operation: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      controller.signal.addEventListener('abort', onAbort, { once: true });
      operation.then(
        value => {
          controller.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        error => {
          controller.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });

  const waitForImage = async (image: HTMLImageElement) => {
    if (!image.complete) {
      await new Promise<void>((resolve, reject) => {
        let finish = () => {};
        let onAbort = () => {};
        const cleanup = () => {
          image.removeEventListener('load', finish);
          image.removeEventListener('error', finish);
          controller.signal.removeEventListener('abort', onAbort);
        };
        finish = () => {
          cleanup();
          resolve();
        };
        onAbort = () => {
          cleanup();
          reject(abortError());
        };
        image.addEventListener('load', finish, { once: true });
        image.addEventListener('error', finish, { once: true });
        controller.signal.addEventListener('abort', onAbort, { once: true });
        // The resource can finish between the initial complete check and
        // listener registration; close that event-loss window explicitly.
        if (image.complete) finish();
      });
    }
    if (typeof image.decode === 'function') {
      try {
        await raceWithAbort(image.decode());
      } catch (error) {
        if (controller.signal.aborted) throw error;
        imageDecodeFailureCount += 1;
      }
    }
  };

  const waitForPaint = () =>
    new Promise<void>((resolve, reject) => {
      let finished = false;
      let onAbort = () => {};
      const fallback = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
      const cleanup = () => {
        if (fallback.timer) clearTimeout(fallback.timer);
        controller.signal.removeEventListener('abort', onAbort);
      };
      const finish = (fallback: boolean) => {
        if (finished) return;
        finished = true;
        usedAnimationFrameFallback = fallback;
        cleanup();
        resolve();
      };
      onAbort = () => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(abortError());
      };
      fallback.timer = setTimeout(() => finish(true), options.paintFallbackMs);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(() => finish(false)));
      }
    });

  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error(`Visual commit wait exceeded ${options.timeoutMs} msec.`));
  }, options.timeoutMs);

  try {
    if ('fonts' in document) await raceWithAbort(document.fonts.ready).then(() => {});
    await Promise.all(images.map(waitForImage));
    await waitForPaint();
  } catch (error) {
    if (externalSignal?.aborted) throw externalSignal.reason;
    if (!didTimeout) throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }

  return {
    didTimeout,
    elapsedMs: performance.now() - startedAt,
    fontsStatus: 'fonts' in document ? document.fonts.status : 'unsupported',
    imageCount: images.length,
    imageDecodeFailureCount,
    usedAnimationFrameFallback,
    visibilityState: document.visibilityState,
  };
}

export function waitForVisualCommitWithAbort(
  operation: Promise<VisualCommitResult>,
  signal?: AbortSignal,
): Promise<VisualCommitResult> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    let onAbort = () => {};
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      result => finish(() => resolve(result)),
      error => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}
