import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { badRequest, forbidden, notFound } from '../utils/errors';

/** Download links last an hour; they are signed with a key made at start-up, so a restart ends them */
const LINK_MS = 60 * 60 * 1000;
const KEY = crypto.randomBytes(32);

/** Paths are "{CC}/{YYYY}/…", as in Storage: no leading slash, no "..", no empty segments */
function clean(relativePath: string): string {
  const p = relativePath.replace(/\\/g, '/').trim();
  if (!p || p.startsWith('/') || p.split('/').some((seg) => !seg || seg === '.' || seg === '..')) throw badRequest(`Invalid file path: ${relativePath}`);
  return p;
}

const fileOf = (relativePath: string) => path.join(env.serverFilesDir, ...clean(relativePath).split('/'));
const sign = (relativePath: string, expires: number) => crypto.createHmac('sha256', KEY).update(`${relativePath}\n${expires}`).digest('base64url');

export interface ServerFile {
  path: string;
  size: number;
  modifiedAt: string;
}

/**
 * Finished files kept on the service instead of Storage: one over the most one upload takes
 * (MAX_UPLOAD_MB), or whose upload failed (e.g. storage full). Laid out as in Storage, listed in
 * the web app's Files page as "On server", and kept until someone deletes them there.
 */
export const serverFilesService = {
  /** Copies a finished file in (its source is a temp file removed afterwards) */
  async put(relativePath: string, localPath: string): Promise<void> {
    const target = fileOf(relativePath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(localPath, target);
  },

  async has(relativePath: string): Promise<boolean> {
    return Boolean((await fs.promises.stat(fileOf(relativePath)).catch(() => null))?.isFile());
  },

  /** Every file under a folder (all of them without one), as paths from the root */
  async list(folder = ''): Promise<ServerFile[]> {
    const out: ServerFile[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
        else if (entry.isFile()) {
          const stat = await fs.promises.stat(path.join(dir, entry.name));
          out.push({ path: rel, size: stat.size, modifiedAt: stat.mtime.toISOString() });
        }
      }
    };
    const start = folder ? clean(folder) : '';
    await walk(start ? fileOf(start) : env.serverFilesDir, start);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  },

  /** Copies a kept file to a local path (e.g. for a merge) */
  async copyTo(relativePath: string, localPath: string): Promise<void> {
    await fs.promises.copyFile(fileOf(relativePath), localPath);
  },

  /** Removes files, and folders they leave empty */
  async remove(relativePaths: string[]): Promise<void> {
    for (const p of relativePaths) {
      const file = fileOf(p);
      await fs.promises.rm(file, { force: true });
      for (let dir = path.dirname(file); dir.startsWith(env.serverFilesDir) && dir !== env.serverFilesDir; dir = path.dirname(dir)) {
        if ((await fs.promises.readdir(dir).catch(() => ['?'])).length) break;
        await fs.promises.rmdir(dir).catch(() => {});
      }
    }
  },

  /** A download link for a file, from the service's root (the web app puts the service's address in front) */
  link(relativePath: string): string {
    const p = clean(relativePath);
    const expires = Date.now() + LINK_MS;
    return `/api/server-files/download?${new URLSearchParams({ path: p, expires: String(expires), sig: sign(p, expires) })}`;
  },

  /** The file a download link names, once its signature and expiry check out */
  async openSigned(query: { path?: unknown; expires?: unknown; sig?: unknown }): Promise<{ file: string; size: number; name: string }> {
    const p = clean(String(query.path ?? ''));
    const expires = Number(query.expires);
    const given = Buffer.from(String(query.sig ?? ''));
    const expected = Buffer.from(sign(p, expires));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw forbidden('This download link is not valid.');
    if (!(expires > Date.now())) throw forbidden('This download link has expired. Download the file again from the web app.');
    const file = fileOf(p);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) throw notFound('This file is no longer on the server.');
    return { file, size: stat.size, name: path.basename(file) };
  },
};
