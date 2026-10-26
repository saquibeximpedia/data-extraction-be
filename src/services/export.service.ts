import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { env } from '../config/env';
import { Period, TradeRecord } from '../types';
import { storageService } from './storage.service';

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

async function* jsonLines(file: string): AsyncGenerator<TradeRecord> {
  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    if (line) yield JSON.parse(line);
  }
}

/**
 * Extracted files in Storage, one folder per country and year: {CC}/{YYYY}/{CC}_{YYYY-MM}.csv.
 * A month bigger than MAX_UPLOAD_MB is split into {CC}_{YYYY-MM}_part1.csv, _part2.csv… (each with
 * the header row), since Supabase rejects large uploads. Replaced on each run. (Files users upload
 * for download-only countries sit next to them; the web app handles those.)
 */
export const exportService = {
  folderFor: (countryCode: string, period: Period) => `${countryCode}/${period.slice(0, 4)}`,
  /** part 0 = the whole month in one file */
  nameFor: (countryCode: string, period: Period, part = 0) => `${countryCode}_${period}${part ? `_part${part}` : ''}.csv`,
  /** Whether a stored file is one of the extracted files of that month (any part, or an older .zip) */
  isMonthFile: (name: string, countryCode: string, period: Period) => new RegExp(`^${countryCode}_${period}(_part\\d+)?\\.(csv|zip)$`).test(name),
};

/**
 * A run's rows for one country, kept per month in local JSON-lines files while the run goes,
 * then written to Storage as one CSV per month. Columns are the source's own fields, in the
 * order they first appear.
 */
export class MonthFiles {
  private readonly dir = path.join(env.tempDir, crypto.randomUUID());
  private readonly counts = new Map<Period, number>();
  private writing = Promise.resolve();

  constructor(private readonly countryCode: string) {
    fs.mkdirSync(this.dir, { recursive: true });
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

  /** Uploads the month as one CSV, or in parts when it is too big, over the previous files; returns their paths and the row count */
  async save(period: Period): Promise<{ paths: string[]; rows: number }> {
    await this.writing;
    const columns = new Set<string>();
    for await (const record of jsonLines(this.file(period))) for (const key of Object.keys(record)) columns.add(key);
    const header = '﻿' + [...columns].map(escapeCell).join(',');
    const keys = [...columns];
    const limit = env.MAX_UPLOAD_MB * 1024 * 1024;

    // Rows go to part files, starting a new one (with the header again) before a part passes the limit
    const parts: string[] = [];
    let out: fs.WriteStream | null = null;
    let size = 0;
    const close = () => new Promise<void>((resolve, reject) => (out ? out.end((err?: Error | null) => (err ? reject(err) : resolve())) : resolve()));
    const open = async () => {
      await close();
      const file = `${this.file(period)}.${parts.length + 1}.csv`;
      parts.push(file);
      out = fs.createWriteStream(file);
      out.write(header);
      size = Buffer.byteLength(header);
    };
    await open();
    for await (const record of jsonLines(this.file(period))) {
      const line = '\n' + keys.map((c) => escapeCell(record[c])).join(',');
      const bytes = Buffer.byteLength(line);
      if (size + bytes > limit && size > Buffer.byteLength(header)) await open();
      size += bytes;
      if (!out!.write(line)) await new Promise((r) => out!.once('drain', r));
    }
    await close();

    const folder = exportService.folderFor(this.countryCode, period);
    const names = parts.length === 1 ? [exportService.nameFor(this.countryCode, period)] : parts.map((_, i) => exportService.nameFor(this.countryCode, period, i + 1));
    for (const [i, file] of parts.entries()) await storageService.uploadFile(`${folder}/${names[i]}`, file, 'text/csv; charset=utf-8');

    // Drop what an earlier run left for this month (more parts, the single file, or an old .zip)
    const stale = (await storageService.list(folder).catch(() => [])).filter((n) => exportService.isMonthFile(n, this.countryCode, period) && !names.includes(n));
    if (stale.length) await storageService.removeFiles(stale.map((n) => `${folder}/${n}`)).catch(() => {});

    return { paths: names.map((n) => `${folder}/${n}`), rows: this.counts.get(period) ?? 0 };
  }

  async cleanup(): Promise<void> {
    await this.writing.catch(() => {});
    await fs.promises.rm(this.dir, { recursive: true, force: true });
  }

  private file(period: Period): string {
    return path.join(this.dir, `${period}.jsonl`);
  }
}
