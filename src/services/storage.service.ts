import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { env } from '../config/env';

export interface FileMetadata {
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: Date;
}

export interface IStorageService {
  saveFile(relativePath: string, data: Buffer): Promise<string>;
  fileExists(relativePath: string): Promise<boolean>;
  getFileStream(relativePath: string): Promise<Readable>;
  listFiles(countryCode?: string): Promise<FileMetadata[]>;
}

export class LocalStorageService implements IStorageService {
  private baseDir: string;

  constructor(baseDir: string = env.resolvedStoragePath) {
    this.baseDir = baseDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /** Resolves a path under the storage root and refuses anything that escapes it */
  private resolveSafe(relativePath: string): string {
    const fullPath = path.resolve(this.baseDir, relativePath);
    const rel = path.relative(this.baseDir, fullPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return fullPath;
  }

  public async saveFile(relativePath: string, data: Buffer): Promise<string> {
    const fullPath = this.resolveSafe(relativePath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    // Write then rename so a download never sees a half-written file
    const tempPath = `${fullPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tempPath, data);
    await fs.promises.rename(tempPath, fullPath);
    return fullPath;
  }

  public async fileExists(relativePath: string): Promise<boolean> {
    return fs.existsSync(this.resolveSafe(relativePath));
  }

  public async getFileStream(relativePath: string): Promise<Readable> {
    const fullPath = this.resolveSafe(relativePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return fs.createReadStream(fullPath);
  }

  public async deleteFile(relativePath: string): Promise<void> {
    const fullPath = this.resolveSafe(relativePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    await fs.promises.unlink(fullPath);
  }

  /**
   * If a file already exists at relativePath, renames it with an overwrite timestamp
   * so historical data is never lost.
   */
  public async archiveIfExisting(relativePath: string): Promise<string | null> {
    const fullPath = this.resolveSafe(relativePath);
    if (!fs.existsSync(fullPath)) {
      return null;
    }

    const dir = path.dirname(fullPath);
    const ext = path.extname(fullPath);
    const baseName = path.basename(fullPath, ext);

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    let archivedName = `${baseName}_overwritten_${dateStr}_${timeStr}${ext}`;
    let archivedPath = path.join(dir, archivedName);

    // If somehow a collision occurs, add an extra counter
    let counter = 1;
    while (fs.existsSync(archivedPath)) {
      archivedName = `${baseName}_overwritten_${dateStr}_${timeStr}_${counter}${ext}`;
      archivedPath = path.join(dir, archivedName);
      counter++;
    }

    await fs.promises.rename(fullPath, archivedPath);
    return path.relative(this.baseDir, archivedPath).replace(/\\/g, '/');
  }

  public async listFiles(countryCode?: string): Promise<FileMetadata[]> {
    const searchDir = countryCode ? this.resolveSafe(countryCode.toUpperCase()) : this.baseDir;
    const results: FileMetadata[] = [];

    if (!fs.existsSync(searchDir)) {
      return results;
    }

    const traverse = async (currentDir: string) => {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullEntryPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await traverse(fullEntryPath);
        } else if (entry.isFile() && (entry.name.endsWith('.xlsx') || entry.name.endsWith('.csv'))) {
          const stats = await fs.promises.stat(fullEntryPath);
          results.push({
            fileName: entry.name,
            relativePath: path.relative(this.baseDir, fullEntryPath).replace(/\\/g, '/'),
            sizeBytes: stats.size,
            modifiedAt: stats.mtime,
          });
        }
      }
    };

    await traverse(searchDir);
    return results.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  }
}

export const storageService = new LocalStorageService();
