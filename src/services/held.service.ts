import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { badRequest, notFound } from '../utils/errors';

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function runDir(runId: string): string {
  if (!RUN_ID.test(runId)) throw badRequest('Invalid run id');
  return path.join(env.heldDir, runId);
}

/** Paths are "{CC}/{YYYY}/{file}" (or under _test/): no leading slash, no "..", no empty segments */
function resolveIn(dir: string, relativePath: string): string {
  const p = relativePath.replace(/\\/g, '/').trim();
  if (!p || p.startsWith('/') || p.split('/').some((seg) => !seg || seg === '.' || seg === '..')) throw badRequest(`Invalid file path: ${relativePath}`);
  return path.join(dir, ...p.split('/'));
}

/**
 * Files of runs saved to the user's device. The service can't reach the user's folder, so a
 * finished month waits here, laid out as in Storage, until the web app downloads it into the
 * folder and clears it; anything left is removed after HELD_KEEP_DAYS.
 */
export const heldService = {
  /** Copies a finished file in (its source is a temp file the run removes afterwards) */
  async put(runId: string, relativePath: string, localPath: string): Promise<void> {
    const target = resolveIn(runDir(runId), relativePath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(localPath, target);
  },

  /** The run's files still waiting, with their sizes */
  async list(runId: string): Promise<{ path: string; size: number }[]> {
    const root = runDir(runId);
    const out: { path: string; size: number }[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
        else out.push({ path: rel, size: (await fs.promises.stat(path.join(dir, entry.name))).size });
      }
    };
    await walk(root, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  },

  /** A held file to stream to the browser */
  async open(runId: string, relativePath: string): Promise<{ file: string; size: number; name: string }> {
    const file = resolveIn(runDir(runId), relativePath);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) throw notFound('This file is no longer held: it was saved already, or removed after a while.');
    return { file, size: stat.size, name: path.basename(file) };
  },

  /** Drops held files once saved: the ones given, or the whole run */
  async remove(runId: string, relativePaths?: string[]): Promise<void> {
    const root = runDir(runId);
    if (!relativePaths) return fs.promises.rm(root, { recursive: true, force: true });
    for (const p of relativePaths) await fs.promises.rm(resolveIn(root, p), { force: true });
    // Tidy folders left empty, and the run's own folder when nothing is left
    if (!(await this.list(runId)).length) await fs.promises.rm(root, { recursive: true, force: true });
  },

  /** Removes runs held longer than HELD_KEEP_DAYS; returns how many */
  async prune(): Promise<number> {
    const cutoff = Date.now() - env.HELD_KEEP_DAYS * DAY_MS;
    const entries = await fs.promises.readdir(env.heldDir, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
      const dir = path.join(env.heldDir, entry.name);
      if ((await fs.promises.stat(dir)).mtimeMs < cutoff) {
        await fs.promises.rm(dir, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  },
};
