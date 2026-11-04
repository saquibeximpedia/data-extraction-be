import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { env } from '../config/env';
import { Period, TradeFlow, TradeRecord } from '../types';
import { escapeCell } from '../utils/csv';
import { ZipFileWriter } from '../utils/zip';
import { heldService } from './held.service';
import { serverFilesService } from './server-files.service';
import { settingsService } from './settings.service';
import { storageService } from './storage.service';

async function* jsonLines(file: string): AsyncGenerator<TradeRecord> {
  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Only the last line can be cut off, when the service died mid-write
    }
  }
}

/** Where a run's files go: Storage, or held for the web app to save into the user's folder */
export type RunDestination = 'storage' | 'device';

/** Top folder for files of runs on the test HS codes */
export const TEST_FOLDER = '_test';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FLOWS: TradeFlow[] = ['IMPORT', 'EXPORT'];

/**
 * Most rows in one CSV (9 lakh): below Excel's 1,048,576, so every file opens whole. A bigger
 * month goes into parts whatever its size. Exported for tests.
 */
export const MAX_ROWS_PER_FILE = 900_000;

/** Rows turned into text and appended at a time by MonthFiles.add */
const ADD_CHUNK_ROWS = 2_000;

/** Largest zip written (parts end at MAX_ROWS_PER_FILE long before this; zips without ZIP64 stop at 4 GB) */
export const ZIP_LIMIT = 3 * 1024 ** 3;

/**
 * Extracted files, one folder per country, year, month and flow:
 *   {CC}/{YYYY}/{MM}/{IMPORT|EXPORT}/{CC}_{YYYY-MM}_{FLOW}.zip
 * or {CC}_{YYYY-MM}_{FLOW}_part1.zip, _part2.zip… when the month has more than MAX_ROWS_PER_FILE
 * rows. Each zip holds one CSV with the header row. Files for Storage are always zipped; one that
 * Storage can't take (over MAX_UPLOAD_MB, or the upload failed) is kept on the server instead, in
 * the same place (see storeFile). Files held for the user's device stay a plain CSV up to
 * ZIP_OVER_MB. Runs on the test HS codes write under _test/ instead, apart from the real data.
 * Replaced on each run.
 */
export const exportService = {
  folderFor: (countryCode: string, period: Period, flow: TradeFlow, test = false) =>
    `${test ? `${TEST_FOLDER}/` : ''}${countryCode}/${period.slice(0, 4)}/${period.slice(5, 7)}/${flow}`,
  /** The file's name without its extension; part 0 = the whole month in one file */
  baseFor: (countryCode: string, period: Period, flow: TradeFlow, part = 0) => `${countryCode}_${period}_${flow}${part ? `_part${part}` : ''}`,
  /** Whether a stored file is one of the extracted files of that month and flow (whole or a part, CSV or zip) */
  isMonthFile: (name: string, countryCode: string, period: Period, flow: TradeFlow) => new RegExp(`^${countryCode}_${period}_${flow}(_part\\d+)?\\.(csv|zip)$`).test(name),
};

/**
 * Zips CSV records into zips under `limit` bytes, each holding one CSV that starts with the header
 * row: one zip named `base(0)` when `single`, else parts `base(1)`, `base(2)`… A part ends once it
 * nears the limit (deflate holds back a little) or holds MAX_ROWS_PER_FILE rows. Returns null when
 * `single` and the records don't fit in one zip, for the caller to zip them again as parts.
 */
export async function zipRecords(
  records: AsyncIterable<string>,
  header: string,
  dir: string,
  base: (part: number) => string,
  limit: number,
  single: boolean
): Promise<{ name: string; file: string }[] | null> {
  const margin = Math.min(2 * 1024 * 1024, limit * 0.1);
  const parts: { name: string; file: string }[] = [];
  let zip!: ZipFileWriter;
  let rows = 0;
  const open = async () => {
    rows = 0;
    const name = base(single ? 0 : parts.length + 1);
    const file = path.join(dir, `${name}.zip`);
    parts.push({ name: `${name}.zip`, file });
    zip = new ZipFileWriter(file, `${name}.csv`);
    // BOM so Excel reads UTF-8 names correctly
    await zip.write(`﻿${header}`);
  };
  await open();
  for await (const record of records) {
    if (zip.compressedBytes > limit - margin || rows >= MAX_ROWS_PER_FILE) {
      await zip.close();
      if (single) return null;
      await open();
    }
    await zip.write(`\n${record}`);
    rows++;
  }
  await zip.close();
  return parts;
}

/** Where a finished file went; `reason` says why one was kept on the server */
export interface Stored {
  path: string;
  onServer: boolean;
  reason?: string;
}

/**
 * Uploads a finished file to Storage, or keeps it on the server when it is bigger than one upload
 * takes (MAX_UPLOAD_MB) or the upload fails (e.g. storage full), so a file is never lost for
 * want of room in the cloud.
 */
export async function storeFile(relativePath: string, localPath: string, contentType = 'application/zip'): Promise<Stored> {
  const { maxUploadMb } = settingsService.get();
  const { size } = await fs.promises.stat(localPath);
  let reason: string;
  if (size > maxUploadMb * 1024 * 1024) reason = `${(size / 1048576).toFixed(1)} MB is over the ${maxUploadMb} MB one upload takes`;
  else {
    try {
      await storageService.uploadFile(relativePath, localPath, contentType);
      return { path: relativePath, onServer: false };
    } catch (err: any) {
      reason = `the upload failed (${err.message})`;
    }
  }
  await serverFilesService.put(relativePath, localPath);
  return { path: relativePath, onServer: true, reason };
}

/** One month and flow of a run */
export interface MonthFlow {
  period: Period;
  flow: TradeFlow;
}

const keyOf = (period: Period, flow: TradeFlow) => `${period}_${flow}`;

/**
 * A run's rows for one country, kept per month and flow in local JSON-lines files while the run
 * goes, then written to Storage (or held for the device) as described in exportService. Columns
 * are the source's own fields, in the order they first appear. The files sit in
 * {tempDir}/{runId}/{CC}/, so rows fetched before the service died (e.g. out of memory) are still
 * there to save at the next start.
 */
export class MonthFiles {
  private readonly dir: string;
  private readonly counts = new Map<string, MonthFlow>();
  private writing = Promise.resolve();

  constructor(
    private readonly countryCode: string,
    private readonly runId: string,
    /** A run on the test HS codes: its files go under _test/ */
    private readonly test = false,
    /** 'device': finished months are held on the service for the web app to save into the user's folder, not uploaded */
    private readonly destination: RunDestination = 'storage'
  ) {
    this.dir = path.join(env.tempDir, runId, countryCode);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Runs that left rows behind; nothing runs yet at start-up, so these were cut off */
  static leftoverRuns(): string[] {
    if (!fs.existsSync(env.tempDir)) return [];
    return fs.readdirSync(env.tempDir).filter((name) => RUN_ID.test(name));
  }

  /**
   * The months and flows each country of a cut-off run had written. Files from before rows were
   * kept per flow ({YYYY-MM}.jsonl) are split by each row's trade_flow; rows without one can't be
   * placed, so their file is left (`stuck`) for a person to look at.
   */
  static async leftovers(runId: string, isTest: (countryCode: string) => boolean, destination: RunDestination = 'storage'): Promise<{ files: MonthFiles; stuck: string[] }[]> {
    const runDir = path.join(env.tempDir, runId);
    const out: { files: MonthFiles; stuck: string[] }[] = [];
    for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = new MonthFiles(entry.name, runId, isTest(entry.name), destination);
      const stuck: string[] = [];
      for (const name of fs.readdirSync(files.dir)) {
        const m = name.match(/^(\d{4}-\d{2})_(IMPORT|EXPORT)\.jsonl$/);
        if (m) files.counts.set(keyOf(m[1], m[2] as TradeFlow), { period: m[1], flow: m[2] as TradeFlow });
        const legacy = name.match(/^(\d{4}-\d{2})\.jsonl$/)?.[1];
        if (legacy && !(await files.splitLegacy(legacy))) stuck.push(path.join(files.dir, name));
      }
      out.push({ files, stuck });
    }
    return out;
  }

  /** Splits a {YYYY-MM}.jsonl by its rows' trade_flow; false (file kept) when a row has none */
  private async splitLegacy(period: Period): Promise<boolean> {
    const legacy = path.join(this.dir, `${period}.jsonl`);
    for await (const record of jsonLines(legacy)) {
      if (!FLOWS.includes(record.trade_flow as TradeFlow)) return false;
    }
    const batches: Record<string, TradeRecord[]> = { IMPORT: [], EXPORT: [] };
    for await (const record of jsonLines(legacy)) {
      const batch = batches[record.trade_flow as TradeFlow];
      batch.push(record);
      if (batch.length >= ADD_CHUNK_ROWS) await this.add(period, record.trade_flow as TradeFlow, batch.splice(0));
    }
    for (const flow of FLOWS) await this.add(period, flow, batches[flow]);
    await this.writing;
    await fs.promises.rm(legacy);
    return true;
  }

  /** Removes a run's folder (all countries), e.g. one holding nothing to save */
  static async discard(runId: string): Promise<void> {
    await fs.promises.rm(path.join(env.tempDir, runId), { recursive: true, force: true });
  }

  get country(): string {
    return this.countryCode;
  }

  /** Months and flows that have rows, oldest first, imports before exports */
  get months(): MonthFlow[] {
    return [...this.counts.values()].sort((a, b) => a.period.localeCompare(b.period) || FLOWS.indexOf(a.flow) - FLOWS.indexOf(b.flow));
  }

  /**
   * Appends rows to the month's file for the flow, ADD_CHUNK_ROWS at a time: one string for a whole
   * request ran the heap out (a Turkey batch of 61,330 rows × 59 columns took ~260 MB as one string)
   */
  add(period: Period, flow: TradeFlow, rows: TradeRecord[]): Promise<void> {
    if (!rows.length) return this.writing;
    this.counts.set(keyOf(period, flow), { period, flow });
    // Appends run one after another so concurrent requests never interleave lines
    this.writing = this.writing.then(async () => {
      for (let i = 0; i < rows.length; i += ADD_CHUNK_ROWS) {
        const text = rows.slice(i, i + ADD_CHUNK_ROWS).map((r) => JSON.stringify(r)).join('\n') + '\n';
        await fs.promises.appendFile(this.file(period, flow), text);
      }
    });
    return this.writing;
  }

  /**
   * Writes the month and flow over its previous files and returns their paths and the row count:
   * zipped for Storage (built here, then uploaded), a CSV or zips for the device (see exportService).
   */
  async save(period: Period, flow: TradeFlow): Promise<{ paths: string[]; rows: number; stored: Stored[] }> {
    await this.writing;
    const source = this.file(period, flow);
    const columns = new Set<string>();
    let rows = 0;
    for await (const record of jsonLines(source)) {
      rows++;
      for (const key of Object.keys(record)) columns.add(key);
    }
    const keys = [...columns];
    const header = keys.map(escapeCell).join(',');
    const records = async function* () {
      for await (const record of jsonLines(source)) yield keys.map((c) => escapeCell(record[c])).join(',');
    };
    const base = (part: number) => exportService.baseFor(this.countryCode, period, flow, part);
    const folder = exportService.folderFor(this.countryCode, period, flow, this.test);

    let outputs: { name: string; file: string }[] | null = null;
    if (this.destination === 'device' && rows <= MAX_ROWS_PER_FILE) {
      // A small month stays a plain CSV on the device
      const csv = path.join(this.dir, `${base(0)}.csv`);
      const out = fs.createWriteStream(csv);
      out.write(`﻿${header}`);
      for await (const record of records()) if (!out.write(`\n${record}`)) await new Promise((r) => out.once('drain', r));
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      if ((await fs.promises.stat(csv)).size <= settingsService.get().zipOverMb * 1024 * 1024) outputs = [{ name: `${base(0)}.csv`, file: csv }];
    }
    // Parts end at MAX_ROWS_PER_FILE rows only: a zip Storage can't take stays whole on the server
    outputs ??= (rows <= MAX_ROWS_PER_FILE && (await zipRecords(records(), header, this.dir, base, ZIP_LIMIT, true))) || (await zipRecords(records(), header, this.dir, base, ZIP_LIMIT, false))!;

    const stored: Stored[] = [];
    if (this.destination === 'device') {
      for (const o of outputs) {
        await heldService.put(this.runId, `${folder}/${o.name}`, o.file);
        stored.push({ path: `${folder}/${o.name}`, onServer: false });
      }
    } else {
      for (const o of outputs) stored.push(await storeFile(`${folder}/${o.name}`, o.file));
      // Drop what an earlier run left for this month and flow, in either place (more parts, one file
      // instead of parts, or the same file now kept in the other place)
      const isStale = (name: string, onServer: boolean) =>
        exportService.isMonthFile(name, this.countryCode, period, flow) && !stored.some((s) => s.path === `${folder}/${name}` && s.onServer === onServer);
      const cloud = (await storageService.list(folder).catch(() => [])).filter((n) => isStale(n, false));
      if (cloud.length) await storageService.removeFiles(cloud.map((n) => `${folder}/${n}`)).catch(() => {});
      const kept = (await serverFilesService.list(folder)).map((f) => f.path.split('/').pop()!).filter((n) => isStale(n, true));
      if (kept.length) await serverFilesService.remove(kept.map((n) => `${folder}/${n}`));
    }
    for (const o of outputs) await fs.promises.rm(o.file, { force: true });
    return { paths: stored.map((s) => s.path), rows, stored };
  }

  async cleanup(): Promise<void> {
    await this.writing.catch(() => {});
    await fs.promises.rm(this.dir, { recursive: true, force: true });
    // The run's folder goes once its last country is done
    await fs.promises.rmdir(path.dirname(this.dir)).catch(() => {});
  }

  private file(period: Period, flow: TradeFlow): string {
    return path.join(this.dir, `${keyOf(period, flow)}.jsonl`);
  }
}
