import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import type { MainOptions } from './types.js';
import sanitize from 'sanitize-filename';

export const MAXIMUM_RETAINED_SCREENSHOT_BYTES = 64 * 1024 * 1024;

export interface TraceFile {
  write(chunk: Buffer): Promise<void>;
  commit(kind: string, story: string, suffix: string[], logicalId?: string): Promise<string>;
  discard(): Promise<void>;
}

export class FileSystem {
  private readonly reservedPaths = new Map<string, string>();
  private readonly directoryPromises = new Map<string, Promise<void>>();
  private readonly outputRoot: string;
  private readonly maximumConcurrentWrites: number;
  private readonly maximumBufferedBytes = MAXIMUM_RETAINED_SCREENSHOT_BYTES;
  private readonly writeWaiters: Array<{ bytes: number; resolve: () => void; reject: (error: unknown) => void }> = [];
  private readonly screenshotWaiters: Array<{
    bytes: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly screenshotReservations = new WeakMap<Buffer, number>();
  private readonly pendingWrites = new Set<Promise<unknown>>();
  private activeWrites = 0;
  private activeWriteBytes = 0;
  private activeScreenshotReservations = 0;
  private retainedScreenshotBytes = 0;
  private writerFailure?: { error: unknown };

  constructor(private opt: MainOptions) {
    this.outputRoot = path.resolve(opt.outDir);
    this.maximumConcurrentWrites = Math.max(1, Math.min(8, opt.parallel || 1));
  }

  private getPath(kind: string, story: string, suffix: string[], extension: string, logicalId?: string) {
    const name = this.opt.flat
      ? sanitize((kind + '_' + story).replace(/\//g, '_'))
      : kind
          .split('/')
          .map(k => sanitize(k))
          .join('/') +
        '/' +
        sanitize(story);
    const safeSuffix = suffix.map(part => sanitize(part));
    const relativePath = name + (safeSuffix.length ? `_${safeSuffix.join('_')}` : '') + extension;
    const resolvedPath = path.resolve(this.outputRoot, relativePath);
    const relativeToRoot = path.relative(this.outputRoot, resolvedPath);
    if (!relativeToRoot || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Refusing to write outside the output directory: ${relativePath}`);
    }

    const reservationKey = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    const identity = logicalId ?? JSON.stringify({ extension, kind, story, suffix });
    const reservedBy = this.reservedPaths.get(reservationKey);
    if (reservedBy !== undefined && reservedBy !== identity) {
      throw new Error(
        `Output path collision for ${relativePath}. Use unique story names and variant suffixes so captures cannot overwrite each other.`,
      );
    }
    this.reservedPaths.set(reservationKey, identity);

    return resolvedPath;
  }

  private ensureDirectory(directory: string) {
    let creating = this.directoryPromises.get(directory);
    if (!creating) {
      creating = fs.mkdir(directory, { recursive: true }).then(() => undefined);
      this.directoryPromises.set(directory, creating);
      void creating.catch(() => this.directoryPromises.delete(directory));
    }
    return creating;
  }

  private acquireWrite(bytes: number, signal?: AbortSignal) {
    if (this.writerFailure !== undefined) return Promise.reject(this.writerFailure.error);
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Screenshot output write was aborted.'));
    return new Promise<void>((resolve, reject) => {
      let onAbort = () => {};
      const waiter = {
        bytes,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (error: unknown) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      onAbort = () => {
        const index = this.writeWaiters.indexOf(waiter);
        if (index < 0) return;
        this.writeWaiters.splice(index, 1);
        waiter.reject(signal?.reason ?? new Error('Screenshot output write was aborted.'));
        this.startWaitingWrites();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.writeWaiters.push(waiter);
      this.startWaitingWrites();
    });
  }

  private startWaitingWrites() {
    while (this.writeWaiters.length > 0 && this.activeWrites < this.maximumConcurrentWrites) {
      const next = this.writeWaiters[0];
      const fits = this.activeWriteBytes + next.bytes <= this.maximumBufferedBytes;
      if (!fits && this.activeWrites > 0) return;
      this.writeWaiters.shift();
      this.activeWrites += 1;
      this.activeWriteBytes += next.bytes;
      next.resolve();
    }
  }

  private releaseWrite(bytes: number) {
    this.activeWrites -= 1;
    this.activeWriteBytes -= bytes;
    this.startWaitingWrites();
  }

  private acquireScreenshotReservation(bytes: number, signal?: AbortSignal) {
    if (this.writerFailure !== undefined) return Promise.reject(this.writerFailure.error);
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? new Error('Screenshot output reservation was aborted.'));
    return new Promise<void>((resolve, reject) => {
      let onAbort = () => {};
      const waiter = {
        bytes,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (error: unknown) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      onAbort = () => {
        const index = this.screenshotWaiters.indexOf(waiter);
        if (index < 0) return;
        this.screenshotWaiters.splice(index, 1);
        waiter.reject(signal?.reason ?? new Error('Screenshot output reservation was aborted.'));
        this.startWaitingScreenshotCaptures();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.screenshotWaiters.push(waiter);
      this.startWaitingScreenshotCaptures();
    });
  }

  private startWaitingScreenshotCaptures() {
    while (this.screenshotWaiters.length > 0 && this.activeScreenshotReservations < this.maximumConcurrentWrites) {
      const next = this.screenshotWaiters[0];
      const fits = this.retainedScreenshotBytes + next.bytes <= this.maximumBufferedBytes;
      if (!fits && this.activeScreenshotReservations > 0) return;
      this.screenshotWaiters.shift();
      this.activeScreenshotReservations += 1;
      this.retainedScreenshotBytes += next.bytes;
      next.resolve();
    }
  }

  private releaseScreenshotReservation(bytes: number) {
    this.activeScreenshotReservations -= 1;
    this.retainedScreenshotBytes -= bytes;
    this.startWaitingScreenshotCaptures();
  }

  private closeWriter(error: unknown) {
    if (this.writerFailure !== undefined) return;
    this.writerFailure = { error };
    for (const waiter of this.writeWaiters.splice(0)) waiter.reject(error);
    for (const waiter of this.screenshotWaiters.splice(0)) waiter.reject(error);
  }

  /** Reserves retained-buffer capacity before Chromium creates a PNG. */
  async captureScreenshot(
    reservationBytes: number | undefined,
    capture: () => Promise<Buffer | null>,
    signal?: AbortSignal,
  ) {
    let reservedBytes =
      reservationBytes === undefined || !Number.isFinite(reservationBytes)
        ? this.maximumBufferedBytes
        : Math.max(1, Math.ceil(reservationBytes));
    await this.acquireScreenshotReservation(reservedBytes, signal);
    try {
      const buffer = await capture();
      if (!buffer) {
        this.releaseScreenshotReservation(reservedBytes);
        return null;
      }
      if (this.writerFailure !== undefined) throw this.writerFailure.error;
      if (this.screenshotReservations.has(buffer)) {
        throw new Error('A captured screenshot buffer cannot hold more than one output reservation.');
      }
      const reservationDelta = buffer.byteLength - reservedBytes;
      if (reservationDelta > 0) {
        if (
          this.activeScreenshotReservations > 1 &&
          this.retainedScreenshotBytes + reservationDelta > this.maximumBufferedBytes
        ) {
          throw new Error(
            `A screenshot used ${buffer.byteLength} bytes, exceeding its ${reservedBytes}-byte output reservation.`,
          );
        }
      }
      this.retainedScreenshotBytes += reservationDelta;
      reservedBytes = buffer.byteLength;
      this.screenshotReservations.set(buffer, reservedBytes);
      if (reservationDelta < 0) this.startWaitingScreenshotCaptures();
      return buffer;
    } catch (error) {
      this.releaseScreenshotReservation(reservedBytes);
      throw error;
    }
  }

  releaseScreenshotBuffer(buffer: Buffer | null | undefined) {
    if (!buffer) return;
    const reservedBytes = this.screenshotReservations.get(buffer);
    if (reservedBytes === undefined) return;
    this.screenshotReservations.delete(buffer);
    this.releaseScreenshotReservation(reservedBytes);
  }

  private writeAtomic(filePath: string, buffer: Buffer, signal?: AbortSignal) {
    const operation = (async () => {
      await this.acquireWrite(buffer.byteLength, signal);
      const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

      try {
        await this.ensureDirectory(path.dirname(filePath));
        if (signal?.aborted) throw signal.reason ?? new Error('Screenshot output write was aborted.');
        await fs.writeFile(temporaryPath, buffer, signal ? { signal } : undefined);
        if (signal?.aborted) throw signal.reason ?? new Error('Screenshot output write was aborted.');
        await fs.rename(temporaryPath, filePath);
      } catch (error) {
        this.closeWriter(error);
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        this.releaseWrite(buffer.byteLength);
      }
    })();
    this.pendingWrites.add(operation);
    void operation.then(
      () => this.pendingWrites.delete(operation),
      () => this.pendingWrites.delete(operation),
    );
    return operation;
  }

  async flush() {
    await Promise.allSettled([...this.pendingWrites]);
    if (this.writerFailure !== undefined) throw this.writerFailure.error;
  }

  /**
   *
   * Save a captured buffer as a PNG image. The method takes ownership of the
   * retained buffer and releases its reservation after the write settles.
   *
   * @param kind - Story kind
   * @param story - Name of this story
   * @param suffix - File name suffix
   * @param buffer - PNG buffer to save
   * @returns Absolute file path
   *
   **/
  async saveScreenshot(
    kind: string,
    story: string,
    suffix: string[],
    buffer: Buffer,
    logicalId?: string,
    signal?: AbortSignal,
  ) {
    try {
      const filePath = this.getPath(kind, story, suffix, '.png', logicalId);
      await this.writeAtomic(filePath, buffer, signal);
      return filePath;
    } finally {
      this.releaseScreenshotBuffer(buffer);
    }
  }

  async createTraceFile(): Promise<TraceFile> {
    await this.ensureDirectory(this.outputRoot);
    const temporaryPath = path.join(
      this.outputRoot,
      `.storyfreeze-trace.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    const handle = await fs.open(temporaryPath, 'wx');
    let state: 'open' | 'committed' | 'discarded' = 'open';
    let closed = false;
    const close = async () => {
      if (closed) return;
      await handle.close();
      closed = true;
    };

    return {
      write: async chunk => {
        if (state !== 'open') throw new Error('Cannot write to a finalized Chromium trace.');
        await handle.writeFile(chunk);
      },
      commit: async (kind, story, suffix, logicalId) => {
        if (state !== 'open') throw new Error('Cannot commit a finalized Chromium trace.');
        const filePath = this.getPath(kind, story, [...suffix, 'trace'], '.json', logicalId);
        await this.ensureDirectory(path.dirname(filePath));
        await close();
        try {
          await fs.rename(temporaryPath, filePath);
          state = 'committed';
          return filePath;
        } catch (error) {
          state = 'discarded';
          try {
            await fs.rm(temporaryPath, { force: true });
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Trace commit and temporary-file cleanup both failed.');
          }
          throw error;
        }
      },
      discard: async () => {
        if (state !== 'open') return;
        state = 'discarded';
        let closeFailure: { error: unknown } | undefined;
        try {
          await close();
        } catch (error) {
          closeFailure = { error };
        }
        let removeFailure: { error: unknown } | undefined;
        try {
          await fs.rm(temporaryPath, { force: true });
        } catch (error) {
          removeFailure = { error };
        }
        if (closeFailure !== undefined && removeFailure !== undefined) {
          throw new AggregateError(
            [closeFailure.error, removeFailure.error],
            'Trace close and temporary-file cleanup both failed.',
          );
        }
        if (closeFailure !== undefined) throw closeFailure.error;
        if (removeFailure !== undefined) throw removeFailure.error;
      },
    };
  }
}
