import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sanitize from 'sanitize-filename';
import type { MainOptions } from './types.js';
import type { ScreenshotCaptureDimensions } from './playwright-runtime.js';

export const MAXIMUM_RETAINED_SCREENSHOT_BYTES = 64 * 1024 * 1024;

export function estimateScreenshotBufferReservation(dimensions: ScreenshotCaptureDimensions | undefined) {
  if (!dimensions) return undefined;
  const scale = Math.max(1, dimensions.deviceScaleFactor);
  const width = Math.ceil(dimensions.width * scale);
  const height = Math.ceil(dimensions.height * scale);
  const rawBytes = width * height * 4 + height;
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 1) return undefined;
  return rawBytes + Math.ceil(rawBytes * 0.02) + 1024 * 1024;
}

type Permit = { bytes: number; released: boolean };
type Waiter = {
  bytes: number;
  resolve(permit: Permit): void;
  reject(error: unknown): void;
};

/** Safe output paths plus one weighted screenshot-to-write ownership budget. */
export class FileSystem {
  private readonly reservedPaths = new Map<string, string>();
  private readonly directoryPromises = new Map<string, Promise<void>>();
  private readonly outputRoot: string;
  private readonly maximumConcurrent: number;
  private readonly maximumBytes = MAXIMUM_RETAINED_SCREENSHOT_BYTES;
  private readonly waiters: Waiter[] = [];
  private readonly bufferPermits = new WeakMap<Buffer, Permit>();
  private active = 0;
  private activeBytes = 0;
  private failure?: { error: unknown };

  constructor(private readonly opt: MainOptions) {
    this.outputRoot = path.resolve(opt.outDir);
    this.maximumConcurrent = Math.max(1, Math.min(8, opt.parallel || 1));
  }

  private getPath(kind: string, story: string, suffix: string[], extension: string, logicalId?: string) {
    const name = this.opt.flat
      ? sanitize((kind + '_' + story).replace(/\//g, '_'))
      : `${kind
          .split('/')
          .map(part => sanitize(part))
          .join('/')}/${sanitize(story)}`;
    const safeSuffix = suffix.map(part => sanitize(part));
    const relativePath = name + (safeSuffix.length ? `_${safeSuffix.join('_')}` : '') + extension;
    const resolvedPath = path.resolve(this.outputRoot, relativePath);
    const relativeToRoot = path.relative(this.outputRoot, resolvedPath);
    if (!relativeToRoot || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Refusing to write outside the output directory: ${relativePath}`);
    }

    const key = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    const identity = logicalId ?? JSON.stringify({ extension, kind, story, suffix });
    const existing = this.reservedPaths.get(key);
    if (existing !== undefined && existing !== identity) {
      throw new Error(
        `Output path collision for ${relativePath}. Use unique story names and variant suffixes so captures cannot overwrite each other.`,
      );
    }
    this.reservedPaths.set(key, identity);
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

  private acquire(bytes: number, signal?: AbortSignal): Promise<Permit> {
    if (this.failure) return Promise.reject(this.failure.error);
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Screenshot output was aborted.'));
    return new Promise((resolve, reject) => {
      let onAbort = () => {};
      const waiter: Waiter = {
        bytes,
        resolve: permit => {
          signal?.removeEventListener('abort', onAbort);
          resolve(permit);
        },
        reject: error => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        waiter.reject(signal?.reason ?? new Error('Screenshot output was aborted.'));
        this.drain();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private drain() {
    while (this.waiters.length > 0 && this.active < this.maximumConcurrent) {
      const next = this.waiters[0];
      if (this.active > 0 && this.activeBytes + next.bytes > this.maximumBytes) return;
      this.waiters.shift();
      const permit = { bytes: next.bytes, released: false };
      this.active += 1;
      this.activeBytes += next.bytes;
      next.resolve(permit);
    }
  }

  private resize(permit: Permit, bytes: number) {
    const delta = bytes - permit.bytes;
    if (delta > 0 && this.active > 1 && this.activeBytes + delta > this.maximumBytes) {
      throw new Error(`A screenshot used ${bytes} bytes, exceeding its ${permit.bytes}-byte output reservation.`);
    }
    permit.bytes = bytes;
    this.activeBytes += delta;
    if (delta < 0) this.drain();
  }

  private release(permit: Permit) {
    if (permit.released) return;
    permit.released = true;
    this.active -= 1;
    this.activeBytes -= permit.bytes;
    this.drain();
  }

  private fail(error: unknown) {
    if (this.failure) return;
    this.failure = { error };
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async captureScreenshot(
    reservationBytes: number | undefined,
    capture: () => Promise<Buffer | null>,
    signal?: AbortSignal,
  ) {
    const bytes =
      reservationBytes === undefined || !Number.isFinite(reservationBytes)
        ? this.maximumBytes
        : Math.max(1, Math.ceil(reservationBytes));
    const permit = await this.acquire(bytes, signal);
    try {
      const buffer = await capture();
      if (!buffer) {
        this.release(permit);
        return null;
      }
      if (this.failure) throw this.failure.error;
      if (this.bufferPermits.has(buffer)) throw new Error('A screenshot buffer cannot own two output permits.');
      this.resize(permit, buffer.byteLength);
      this.bufferPermits.set(buffer, permit);
      return buffer;
    } catch (error) {
      this.release(permit);
      throw error;
    }
  }

  releaseScreenshotBuffer(buffer: Buffer | null | undefined) {
    if (!buffer) return;
    const permit = this.bufferPermits.get(buffer);
    if (!permit) return;
    this.bufferPermits.delete(buffer);
    this.release(permit);
  }

  private async writeAtomic(filePath: string, buffer: Buffer, signal?: AbortSignal) {
    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await this.ensureDirectory(path.dirname(filePath));
      if (signal?.aborted) throw signal.reason ?? new Error('Screenshot output write was aborted.');
      await fs.writeFile(temporaryPath, buffer, signal ? { signal } : undefined);
      if (signal?.aborted) throw signal.reason ?? new Error('Screenshot output write was aborted.');
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      this.fail(error);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async flush() {
    if (this.failure) throw this.failure.error;
  }

  /** Takes ownership of the buffer and releases its permit after the atomic write. */
  async saveScreenshot(
    kind: string,
    story: string,
    suffix: string[],
    buffer: Buffer,
    logicalId?: string,
    signal?: AbortSignal,
  ) {
    const writeSignal = signal ?? this.opt.signal;
    let permit = this.bufferPermits.get(buffer);
    if (!permit) {
      permit = await this.acquire(buffer.byteLength, writeSignal);
      this.bufferPermits.set(buffer, permit);
    }
    try {
      const filePath = this.getPath(kind, story, suffix, '.png', logicalId);
      await this.writeAtomic(filePath, buffer, writeSignal);
      return filePath;
    } finally {
      this.releaseScreenshotBuffer(buffer);
    }
  }
}
