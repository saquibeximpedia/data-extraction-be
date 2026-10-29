import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { env } from '../config/env';
import { Period, TradeRecord } from '../types';
import { settingsService } from './settings.service';
import { storageService } from './storage.service';
import { ZipFileWriter } from '../utils/zip';

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

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

/** Top folder for files of runs on the test HS codes */
export const TEST_FOLDER = '_test';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Most rows in one CSV: Excel shows at most 1,048,576 rows (header included) and drops the rest,
 * so a bigger month goes into parts whatever its size. Exported for tests.
 */
export const MAX_ROWS_PER_FILE = 1_000_000;

/**
 * Extracted files in Storage, one folder per country and year: {CC}/{YYYY}/{CC}_{YYYY-MM}.csv.
 * Runs on the test HS codes write under _test/{CC}/{YYYY}/ instead, apart from the real data.
 * A month whose CSV is bigger than ZIP_OVER_MB (or than one upload, MAX_UPLOAD_MB) is stored zipped:
 * {CC}_{YYYY-MM}.zip, or {CC}_{YYYY-MM}_part1.zip, _part2.zip… when one zip would pass MAX_UPLOAD_MB
 * (Supabase rejects large uploads). Each zip holds one CSV with the header row. Replaced on each run. (Files users upload
 * for download-only countries sit next to them; the web app handles those.)
 */
export const exportService = {
  folderFor: (countryCode: string, period: Period, test = false) => `${test ? `${TEST_FOLDER}/` : ''}${countryCode}/${period.slice(0, 4)}`,
  /** part 0 = the whole month in one file */
  nameFor: (countryCode: string, period: Period, part = 0, ext: 'csv' | 'zip' = 'csv') => `${countryCode}_${period}${part ? `_part${part}` : ''}.${ext}`,
  /** Whether a stored file is one of the extracted files of that month (whole or a part, CSV or zip) */
  isMonthFile: (name: string, countryCode: string, period: Period) => new RegExp(`^${countryCode}_${period}(_part\\d+)?\\.(csv|zip)$`).test(name),
};

/**
 * A run's rows for one country, kept per month in local JSON-lines files while the run goes,
 * then written to Storage as one CSV per month. Columns are the source's own fields, in the
 * order they first appear. The files sit in {tempDir}/{runId}/{CC}/, so rows fetched before the
 * service died (e.g. out of memory) are still there to save at the next start.
 */
export class MonthFiles {
  private readonly dir: string;
  private readonly counts = new Map<Period, number>();
  private writing = Promise.resolve();

  constructor(
    private readonly countryCode: string,
    runId: string,
    /** A run on the test HS codes: its files go under _test/ */
    private readonly test = false
  ) {
    this.dir = path.join(env.tempDir, runId, countryCode);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Runs that left rows behind; nothing runs yet at start-up, so these were cut off */
  static leftoverRuns(): string[] {
    if (!fs.existsSync(env.tempDir)) return [];
    return fs.readdirSync(env.tempDir).filter((name) => RUN_ID.test(name));
  }

  /** The months each country of a cut-off run had written */
  static leftovers(runId: string, isTest: (countryCode: string) => boolean): MonthFiles[] {
    const runDir = path.join(env.tempDir, runId);
    return fs
      .readdirSync(runDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const files = new MonthFiles(entry.name, runId, isTest(entry.name));
        for (const name of fs.readdirSync(files.dir)) {
          const period = name.match(/^(\d{4}-\d{2})\.jsonl$/)?.[1];
          // The count is unknown until saved, which counts the rows itself
          if (period) files.counts.set(period, 0);
        }
        return files;
      });
  }

  /** Removes a run's folder (all countries), e.g. one holding nothing to save */
  static async discard(runId: string): Promise<void> {
    await fs.promises.rm(path.join(env.tempDir, runId), { recursive: true, force: true });
  }

  get country(): string {
    return this.countryCode;
  }

  /** Months that have rows, oldest first */
  get periods(): Period[] {
    return [...this.counts.keys()].sort();
  }

  add(period: Period, rows: TradeRecord[]): Promise<void> {
    if (!rows.length) return this.writing;
    this.counts.set(period, (this.counts.get(period) ?? 0) + rows.length);
    const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    // Appends run one after another so concurrent requests never interleave lines
    this.writing = this.writing.then(() => fs.promises.appendFile(this.file(period), text));
    return this.writing;
  }

  /**
   * Uploads the month over its previous files and returns their paths and the row count: one CSV,
   * or zipped when the CSV is bigger than ZIP_OVER_MB or one upload (see exportService).
   */
  async save(period: Period): Promise<{ paths: string[]; rows: number }> {
    await this.writing;
    const columns = new Set<string>();
    for await (const record of jsonLines(this.file(period))) for (const key of Object.keys(record)) columns.add(key);
    const keys = [...columns];
    const header = keys.map(escapeCell).join(',');
    const { maxUploadMb, zipOverMb } = settingsService.get();
    const limit = maxUploadMb * 1024 * 1024;

    // The whole month as one local CSV first
    const csv = `${this.file(period)}.csv`;
    const out = fs.createWriteStream(csv);
    // BOM so Excel reads UTF-8 names correctly
    out.write(`﻿${header}`);
    let size = 0;
    let rows = 0;
    for await (const record of jsonLines(this.file(period))) {
      rows++;
      const line = '\n' + keys.map((c) => escapeCell(record[c])).join(',');
      size += Buffer.byteLength(line);
      if (!out.write(line)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));

    const folder = exportService.folderFor(this.countryCode, period, this.test);
    let uploads: { name: string; file: string; type: string }[];
    if (size <= zipOverMb * 1024 * 1024 && size <= limit && rows <= MAX_ROWS_PER_FILE) {
      uploads = [{ name: exportService.nameFor(this.countryCode, period), file: csv, type: 'text/csv; charset=utf-8' }];
    } else {
      // Named as parts; a month that fits in one zip is written again under the month's own name
      let parts = await this.zipParts(csv, header, period, limit, true);
      if (parts.length === 1) parts = await this.zipParts(csv, header, period, limit, false);
      uploads = parts.map((p) => ({ ...p, type: 'application/zip' }));
    }
    for (const u of uploads) await storageService.uploadFile(`${folder}/${u.name}`, u.file, u.type);

    // Drop what an earlier run left for this month (more parts, the CSV instead of a zip, or the other way)
    const names = uploads.map((u) => u.name);
    const stale = (await storageService.list(folder).catch(() => [])).filter((n) => exportService.isMonthFile(n, this.countryCode, period) && !names.includes(n));
    if (stale.length) await storageService.removeFiles(stale.map((n) => `${folder}/${n}`)).catch(() => {});

    return { paths: names.map((n) => `${folder}/${n}`), rows };
  }

  /**
   * Zips the month's local CSV into zips under `limit`, each holding one CSV that starts with the
   * header row. A new zip starts once the current one nears the limit (deflate holds back a little)
   * or its CSV reaches MAX_ROWS_PER_FILE rows.
   */
  private async zipParts(csv: string, header: string, period: Period, limit: number, asParts: boolean): Promise<{ name: string; file: string }[]> {
    const margin = Math.min(2 * 1024 * 1024, limit * 0.1);
    const parts: { name: string; file: string }[] = [];
    let zip: ZipFileWriter | null = null;
    let partRows = 0;
    const open = () => {
      partRows = 0;
      const part = asParts ? parts.length + 1 : 0;
      const file = `${csv}.${parts.length + 1}.zip`;
      parts.push({ name: exportService.nameFor(this.countryCode, period, part, 'zip'), file });
      zip = new ZipFileWriter(file, exportService.nameFor(this.countryCode, period, part));
      return zip.write(`﻿${header}`);
    };

    let first = true;
    // Inside a quoted cell that holds a line break, where a part must not end
    let quoted = false;
    for await (const line of readline.createInterface({ input: fs.createReadStream(csv), crlfDelay: Infinity })) {
      // The local CSV's first line is its header
      if (first) {
        first = false;
        await open();
        continue;
      }
      if (asParts && !quoted && (zip!.compressedBytes > limit - margin || partRows >= MAX_ROWS_PER_FILE)) {
        await zip!.close();
        await open();
      }
      await zip!.write(`\n${line}`);
      if ((line.match(/"/g)?.length ?? 0) % 2) quoted = !quoted;
      // A row ends where no quoted cell is left open
      if (!quoted) partRows++;
    }
    await (zip as ZipFileWriter | null)?.close();
    return parts;
  }

  async cleanup(): Promise<void> {
    await this.writing.catch(() => {});
    await fs.promises.rm(this.dir, { recursive: true, force: true });
    // The run's folder goes once its last country is done
    await fs.promises.rmdir(path.dirname(this.dir)).catch(() => {});
  }

  private file(period: Period): string {
    return path.join(this.dir, `${period}.jsonl`);
  }
}
