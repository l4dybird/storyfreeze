import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { waitForVisualCommitInPage, waitForVisualCommitWithAbort } from './visual-commit.js';

describe(waitForVisualCommitInPage, () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');

  function installDocument(value: Record<string, unknown>) {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { images: [], visibilityState: 'visible', ...value },
    });
  }

  afterEach(() => {
    vi.useRealTimers();
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalRequestAnimationFrame) {
      Object.defineProperty(globalThis, 'requestAnimationFrame', originalRequestAnimationFrame);
    } else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  });

  it('waits for image decoding and two animation frames', async () => {
    const frames: FrameRequestCallback[] = [];
    const decode = vi.fn(async () => {});
    installDocument({ images: [{ complete: true, decode }] });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    });

    let completed = false;
    const waiting = waitForVisualCommitInPage({ paintFallbackMs: 250, timeoutMs: 3000 }).then(result => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    frames.shift()!(0);
    expect(completed).toBe(false);
    expect(frames).toHaveLength(1);
    frames.shift()!(16);

    await expect(waiting).resolves.toMatchObject({
      didTimeout: false,
      imageCount: 1,
      imageDecodeFailureCount: 0,
      usedAnimationFrameFallback: false,
    });
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('continues after an image decode failure', async () => {
    installDocument({ images: [{ complete: true, decode: vi.fn(async () => Promise.reject(new Error('decode'))) }] });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });

    await expect(waitForVisualCommitInPage({ paintFallbackMs: 250, timeoutMs: 3000 })).resolves.toMatchObject({
      didTimeout: false,
      imageDecodeFailureCount: 1,
    });
  });

  it('uses the paint fallback when animation frames stop', async () => {
    vi.useFakeTimers();
    installDocument({});
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: () => 1,
    });

    const waiting = waitForVisualCommitInPage({ paintFallbackMs: 250, timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(249);
    let completed = false;
    void waiting.then(() => (completed = true));
    await Promise.resolve();
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(waiting).resolves.toMatchObject({ didTimeout: false, usedAnimationFrameFallback: true });
  });

  it('returns a timeout result and rejects immediately when externally aborted', async () => {
    vi.useFakeTimers();
    installDocument({ fonts: { ready: new Promise(() => {}), status: 'loading' } });
    const waiting = waitForVisualCommitInPage({ paintFallbackMs: 250, timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(waiting).resolves.toMatchObject({ didTimeout: true, fontsStatus: 'loading' });

    const controller = new AbortController();
    controller.abort(new Error('aborted'));
    await expect(
      waitForVisualCommitInPage({ paintFallbackMs: 250, timeoutMs: 3000 }, controller.signal),
    ).rejects.toThrow('aborted');
  });

  it('aborts an adapter-side visual commit wait without leaving an unhandled operation', async () => {
    let resolveOperation = (_value: Awaited<ReturnType<typeof waitForVisualCommitInPage>>) => {};
    const operation = new Promise<Awaited<ReturnType<typeof waitForVisualCommitInPage>>>(
      resolve => (resolveOperation = resolve),
    );
    const controller = new AbortController();
    const waiting = waitForVisualCommitWithAbort(operation, controller.signal);

    controller.abort(new Error('interrupted'));
    await expect(waiting).rejects.toThrow('interrupted');
    resolveOperation({
      didTimeout: false,
      elapsedMs: 1,
      fontsStatus: 'loaded',
      imageCount: 0,
      imageDecodeFailureCount: 0,
      usedAnimationFrameFallback: false,
      visibilityState: 'visible',
    });
    await Promise.resolve();
  });
});
