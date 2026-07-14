import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import type { MainOptions } from './types.js';
import sanitize from 'sanitize-filename';

export class FileSystem {
  private readonly reservedPaths = new Map<string, string>();

  constructor(private opt: MainOptions) {}

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
    const outputRoot = path.resolve(this.opt.outDir);
    const resolvedPath = path.resolve(outputRoot, relativePath);
    const relativeToRoot = path.relative(outputRoot, resolvedPath);
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

  private async writeAtomic(filePath: string, buffer: Buffer) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

    try {
      await fs.writeFile(temporaryPath, buffer);
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
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

  /**
   *
   * Save captured tracing buffer as a json file.
   *
   * @param kind - Story kind
   * @param story - Name of this story
   * @param suffix - File name suffix
   * @param buffer - PNG image buffer to save
   * @returns Absolute file path
   *
   **/
  async saveTrace(kind: string, story: string, suffix: string[], buffer: Buffer, logicalId?: string) {
    const filePath = this.getPath(kind, story, [...suffix, 'trace'], '.json', logicalId);

    await this.writeAtomic(filePath, buffer);

    return filePath;
  }
}
