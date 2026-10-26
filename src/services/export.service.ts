import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import JSZip from 'jszip';
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
 * Extracted files in Storage, one folder per country and year: {CC}/{YYYY}/{CC}_{YYYY-MM}.csv,
 * or .zip (holding that CSV) when the CSV is over MAX_UPLOAD_MB. Replaced on each run. (Files
 * users upload sit next to them; the web app handles those.)
 */
export const exportService = {
  pathFor: (countryCode: string, period: Period, ext: 'csv' | 'zip' = 'csv') => `${countryCode}/${period.slice(0, 4)}/${countryCode}_${period}.${ext}`,
};

/** Zips one file, streaming it from disk; returns the zip's path */
async function zipFile(file: string, nameInZip: string): Promise<string> {
  const zipPath = `${file}.zip`;
  const zip = new JSZip().file(nameInZip, fs.createReadStream(file));
  await new Promise<void>((resolve, reject) =>
    zip
      .generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } })
      .pipe(fs.createWriteStream(zipPath))
      .on('finish', resolve)
      .on('error', reject)
  );
  return zipPath;
}

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

  /** Uploads the month's CSV (zipped when too big) over the previous file; returns its path and row count */
  async save(period: Period): Promise<{ path: string; rows: number; zipped: boolean }> {
    await this.writing;
    const columns = new Set<string>();
    for await (const record of jsonLines(this.file(period))) for (const key of Object.keys(record)) columns.add(key);
    const header = [...columns];

    const csv = `${this.file(period)}.csv`;
    const out = fs.createWriteStream(csv);
    out.write('﻿' + header.map(escapeCell).join(','));
    for await (const record of jsonLines(this.file(period))) {
      if (!out.write('\r\n' + header.map((c) => escapeCell(record[c])).join(','))) await new Promise((r) => out.once('drain', r));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));

    // Too big for one upload: store it zipped, and drop the other format so the month has one file
    const csvPath = exportService.pathFor(this.countryCode, period, 'csv');
    const zipPath = exportService.pathFor(this.countryCode, period, 'zip');
    const tooBig = (await fs.promises.stat(csv)).size > env.MAX_UPLOAD_MB * 1024 * 1024;
    if (tooBig) {
      const zipped = await zipFile(csv, csvPath.split('/').pop()!);
      const size = (await fs.promises.stat(zipped)).size;
      if (size > env.MAX_UPLOAD_MB * 1024 * 1024) {
        throw new Error(`${this.countryCode} ${period} is ${Math.round(size / 1048576)} MB even zipped, over MAX_UPLOAD_MB (${env.MAX_UPLOAD_MB}). Raise the upload limit in Supabase (Storage settings) and MAX_UPLOAD_MB.`);
      }
      await storageService.uploadFile(zipPath, zipped, 'application/zip');
    } else {
      await storageService.uploadFile(csvPath, csv, 'text/csv; charset=utf-8');
    }
    await storageService.removeFiles([tooBig ? csvPath : zipPath]).catch(() => {});
    return { path: tooBig ? zipPath : csvPath, rows: this.counts.get(period) ?? 0, zipped: tooBig };
  }

  async cleanup(): Promise<void> {
    await this.writing.catch(() => {});
    await fs.promises.rm(this.dir, { recursive: true, force: true });
  }

  private file(period: Period): string {
    return path.join(this.dir, `${period}.jsonl`);
  }
}
