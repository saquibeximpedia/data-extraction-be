import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { csvRecords, escapeCell, parseRecord } from '../utils/csv';
import { badRequest, conflict, notFound } from '../utils/errors';
import { entryStream, zipEntries } from '../utils/unzip';
import { MAX_ROWS_PER_FILE, Stored, storeFile, ZIP_LIMIT, zipRecords } from './export.service';
import { serverFilesService } from './server-files.service';
import { storageService } from './storage.service';

/** Merged files go under merged/{name}/ */
export const MERGED_FOLDER = 'merged';

/** An extracted file: {_test/}{CC}/{YYYY}/{MM}/{FLOW}/{CC}_{YYYY-MM}_{FLOW}[_partN].(csv|zip) */
const EXTRACTED = /^(?:_test\/)?([A-Z]{2,3})\/(\d{4})\/(\d{2})\/(IMPORT|EXPORT)\/\1_\2-\3_\4(?:_part\d+)?\.(csv|zip)$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
/** Finished merges kept for the web app to show */
const KEPT = 50;

/** Columns every merged file starts with, filled from the file's folder when its rows lack them */
const LEAD = ['source_country', 'trade_flow', 'period'] as const;

export interface MergeJob {
  id: string;
  /** Its folder: merged/{name}/ */
  name: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedBy: string;
  startedAt: string;
  finishedAt?: string;
  /** The extracted files merged, in order */
  sources: string[];
  /** Selected files that are not extracted files (uploads, merged files), left out */
  skipped: string[];
  /** What it is doing now */
  step: string;
  filesDone: number;
  /** Rows in the selected files, counted before writing */
  rowsTotal: number;
  rowsWritten: number;
  /** The merged file, or its parts */
  outputs: string[];
  /** Outputs kept on the server instead of the cloud (too big for one upload, or the upload failed), with why */
  onServer: { path: string; reason: string }[];
  error?: string;
}

/** One CSV to read: a stored file, or one CSV inside a stored zip */
interface Source {
  path: string;
  local: string;
  country: string;
  period: string;
  flow: string;
  header: string[];
  rows: number;
  /** Its records, the header first */
  records: () => AsyncGenerator<string>;
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);

/** The CSVs of a downloaded file: the file itself, or each CSV in the zip */
async function csvsOf(local: string): Promise<(() => AsyncGenerator<string>)[]> {
  if (!local.endsWith('.zip')) return [() => csvRecords(fs.createReadStream(local))];
  const entries = (await zipEntries(local)).filter((e) => e.name.toLowerCase().endsWith('.csv'));
  return entries.map((entry) => () => csvRecords(entryStream(local, entry)));
}

/**
 * Merges extracted files (picked as folders or files) into one dataset in Storage, under
 * merged/{name}/: a zip, or parts of at most MAX_ROWS_PER_FILE rows (one Storage can't take is kept on the server). Its
 * columns are every column of every file, in the order they first appear, after source_country,
 * trade_flow and period (from the file's folder when its rows don't have them), so files of
 * different countries keep all their data side by side; a file without a column leaves it empty.
 * Rows are counted first and again as they are written: a difference fails the merge, and a row
 * with more or fewer cells than its header stops it, rather than losing data. One merge runs at a
 * time; merges are kept in memory (one cut off by a restart is lost: start it again).
 */
class MergeService {
  private jobs = new Map<string, MergeJob>();

  list(): MergeJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): MergeJob {
    const job = this.jobs.get(id);
    if (!job) throw notFound('No such merge: it finished long ago, or the service restarted since.');
    return job;
  }

  /** Works out the files, then merges them in the background */
  async start(selection: string[], requestedName: string | undefined, startedBy: string): Promise<MergeJob> {
    if (this.list().some((j) => j.status === 'RUNNING')) throw conflict('A merge is already running. Wait for it to finish.');
    const name = requestedName?.trim() || `merge_${stamp()}`;
    if (!NAME.test(name)) throw badRequest('Name the merge with letters, digits, _ and - (up to 80), starting with a letter or digit.');
    const taken = (await storageService.list(`${MERGED_FOLDER}/${name}`).catch(() => [])).length || (await serverFilesService.list(`${MERGED_FOLDER}/${name}`)).length;
    if (taken) throw conflict(`A merge named ${name} exists already. Choose another name, or delete it first.`);

    const sources = new Set<string>();
    const skipped = new Set<string>();
    for (const raw of selection) {
      const p = raw.trim().replace(/\/+$/, '');
      if (EXTRACTED.test(p)) {
        sources.add(p);
        continue;
      }
      // Files in the cloud and files kept on the server sit under the same folders
      const under = p.startsWith(`${MERGED_FOLDER}/`) || p === MERGED_FOLDER ? [] : [...(await storageService.listTree(p)), ...(await serverFilesService.list(p))];
      if (!under.length) skipped.add(p);
      for (const f of under) (EXTRACTED.test(f.path) ? sources : skipped).add(f.path);
    }
    if (!sources.size) throw badRequest('Nothing to merge: the selection has no extracted files (uploaded and merged files are not merged).');

    const job: MergeJob = {
      id: crypto.randomUUID(),
      name,
      status: 'RUNNING',
      startedBy,
      startedAt: new Date().toISOString(),
      sources: [...sources].sort(),
      skipped: [...skipped].sort(),
      step: 'Starting',
      filesDone: 0,
      rowsTotal: 0,
      rowsWritten: 0,
      outputs: [],
      onServer: [],
    };
    this.jobs.set(job.id, job);
    for (const old of this.list().filter((j) => j.status !== 'RUNNING').slice(KEPT)) this.jobs.delete(old.id);
    this.run(job).catch((err) => console.error(`❌ Merge ${name}: ${err.message}`));
    return job;
  }

  private async run(job: MergeJob): Promise<void> {
    const dir = path.join(env.tempDir, `merge-${job.id}`);
    const stored: Stored[] = [];
    console.log(`🔗 Merge ${job.name}: ${job.sources.length} files, started by ${job.startedBy}`);
    try {
      await fs.promises.mkdir(dir, { recursive: true });

      const sources: Source[] = [];
      for (const [i, file] of job.sources.entries()) {
        job.step = `Downloading ${i + 1} of ${job.sources.length}`;
        const local = path.join(dir, `${i}${path.extname(file)}`);
        if (await serverFilesService.has(file)) await serverFilesService.copyTo(file, local);
        else await storageService.download(file, local);
        const [, country, year, month, flow] = file.match(EXTRACTED)!;
        for (const records of await csvsOf(local)) {
          // The header, then a count of the rows (read through once, before anything is written)
          let header: string[] | null = null;
          let rows = 0;
          for await (const record of records()) {
            if (header) rows++;
            else header = parseRecord(record);
          }
          if (header) sources.push({ path: file, local, country, period: `${year}-${month}`, flow, header, rows, records });
        }
        job.rowsTotal = sources.reduce((n, s) => n + s.rows, 0);
      }

      const columns: string[] = [...LEAD];
      for (const s of sources) for (const c of s.header) if (!columns.includes(c)) columns.push(c);
      const header = columns.map(escapeCell).join(',');

      async function* merged() {
        job.rowsWritten = 0;
        for (const [i, s] of sources.entries()) {
          job.filesDone = i;
          // Each output column's cell in this file's rows; -1: not a column of this file
          const at = columns.map((c) => s.header.indexOf(c));
          const fromFolder: Record<string, string> = { source_country: s.country, trade_flow: s.flow, period: s.period };
          let line = 0;
          for await (const record of s.records()) {
            if (line++ === 0) continue;
            const cells = parseRecord(record);
            if (cells.length !== s.header.length) throw new Error(`${s.path}, row ${line - 1}: ${cells.length} cells where its header has ${s.header.length}; nothing was saved`);
            yield columns.map((c, j) => escapeCell(at[j] >= 0 ? cells[at[j]] : (fromFolder[c] ?? ''))).join(',');
            job.rowsWritten++;
          }
        }
        job.filesDone = sources.length;
      }

      job.step = `Writing ${job.rowsTotal.toLocaleString('en')} rows`;
      const base = (part: number) => `${job.name}${part ? `_part${part}` : ''}`;
      const parts = (job.rowsTotal <= MAX_ROWS_PER_FILE && (await zipRecords(merged(), header, dir, base, ZIP_LIMIT, true))) || (await zipRecords(merged(), header, dir, base, ZIP_LIMIT, false))!;
      if (job.rowsWritten !== job.rowsTotal) throw new Error(`${job.rowsWritten} rows were written of the ${job.rowsTotal} in the files; nothing was saved`);

      for (const [i, part] of parts.entries()) {
        job.step = `Saving ${i + 1} of ${parts.length}`;
        stored.push(await storeFile(`${MERGED_FOLDER}/${job.name}/${part.name}`, part.file));
      }
      const onServer = stored.filter((s) => s.onServer).map((s) => ({ path: s.path, reason: s.reason! }));
      Object.assign(job, { status: 'COMPLETED', step: 'Done', outputs: stored.map((s) => s.path), onServer, finishedAt: new Date().toISOString() });
      console.log(`✅ Merge ${job.name}: ${job.rowsWritten} rows from ${job.sources.length} files → ${job.outputs.join(', ')}${onServer.length ? ` (${onServer.length} kept on the server)` : ''}`);
    } catch (err: any) {
      // An incomplete merge is not left looking like a finished one
      const cloud = stored.filter((s) => !s.onServer).map((s) => s.path);
      if (cloud.length) await storageService.removeFiles(cloud).catch(() => {});
      await serverFilesService.remove(stored.filter((s) => s.onServer).map((s) => s.path)).catch(() => {});
      Object.assign(job, { status: 'FAILED', error: err.message, finishedAt: new Date().toISOString() });
      throw err;
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export const mergeService = new MergeService();
