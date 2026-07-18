import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import type { MainOptions } from './types.js';
import sanitize from 'sanitize-filename';

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
  private readonly maximumBufferedBytes = 64 * 1024 * 1024;
  private readonly writeWaiters: Array<{ bytes: number; resolve: () => void; reject: (error: unknown) => void }> = [];
  private readonly pendingWrites = new Set<Promise<unknown>>();
  private activeWrites = 0;
  private activeWriteBytes = 0;
  private writerError?: unknown;

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

  private acquireWrite(bytes: number) {
    if (this.writerError !== undefined) return Promise.reject(this.writerError);
    return new Promise<void>((resolve, reject) => {
      this.writeWaiters.push({ bytes, resolve, reject });
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

  private closeWriter(error: unknown) {
    if (this.writerError !== undefined) return;
    this.writerError = error;
    for (const waiter of this.writeWaiters.splice(0)) waiter.reject(error);
  }

  private writeAtomic(filePath: string, buffer: Buffer) {
    const operation = (async () => {
      await this.acquireWrite(buffer.byteLength);
      const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

      try {
        await this.ensureDirectory(path.dirname(filePath));
        await fs.writeFile(temporaryPath, buffer);
        await fs.rename(temporaryPath, filePath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        this.closeWriter(error);
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
    if (this.writerError !== undefined) throw this.writerError;
  }

  /**
   *
   * Save captured buffer as a PNG image.
   *
   * @param kind - Story kind
   * @param story - Name of this story
   * @param suffix - File name suffix
   * @param buffer - JSON trace buffer to save
   * @returns Absolute file path
   *
   **/
  async saveScreenshot(kind: string, story: string, suffix: string[], buffer: Buffer, logicalId?: string) {
    const filePath = this.getPath(kind, story, suffix, '.png', logicalId);

    await this.writeAtomic(filePath, buffer);

    return filePath;
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
          await fs.rm(temporaryPath, { force: true });
          throw error;
        }
      },
      discard: async () => {
        if (state !== 'open') return;
        state = 'discarded';
        try {
          await close();
        } finally {
          await fs.rm(temporaryPath, { force: true });
        }
      },
    };
  }
}
