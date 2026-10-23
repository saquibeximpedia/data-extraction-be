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

/** What a stored file is, read from its path */
export interface ExportFileInfo {
  countryCode: string | null;
  period: Period | null;
  /** 'extracted' files are written by runs; 'uploaded' ones were added by users */
  origin: 'extracted' | 'uploaded';
}

// {CC}_{YYYY-MM}.csv (extracted) or {CC}_{YYYY-MM}__{original name} (uploaded)
const FILE_RE = /^([A-Z]{2,3})_(\d{4}-\d{2})(__.+)?\.[a-z0-9]+$/i;

/**
 * Files in Storage, one folder per country and year:
 *   {CC}/{YYYY}/{CC}_{YYYY-MM}.csv            written by extractions (replaced on each run)
 *   {CC}/{YYYY}/{CC}_{YYYY-MM}__{name}.xlsx   uploaded by users for download-only countries
 */
export const exportService = {
  pathFor: (countryCode: string, period: Period) => `${countryCode}/${period.slice(0, 4)}/${countryCode}_${period}.csv`,

  /** Where an uploaded file is stored; the original name is kept, made path-safe */
  uploadPathFor(countryCode: string, period: Period, originalName: string): string {
    const clean = originalName.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(-120) || 'file';
    return `${countryCode}/${period.slice(0, 4)}/${countryCode}_${period}__${clean}`;
  },

  describe(relativePath: string): ExportFileInfo {
    const m = (relativePath.split('/').pop() ?? '').match(FILE_RE);
    if (!m) return { countryCode: null, period: null, origin: 'uploaded' };
    return { countryCode: m[1].toUpperCase(), period: m[2], origin: m[3] ? 'uploaded' : 'extracted' };
  },
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

  /** Uploads the month's CSV over the previous one; returns its path and row count */
  async save(period: Period): Promise<{ path: string; rows: number }> {
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

    const relativePath = exportService.pathFor(this.countryCode, period);
    await storageService.uploadFile(relativePath, csv, 'text/csv; charset=utf-8');
    return { path: relativePath, rows: this.counts.get(period) ?? 0 };
  }

  async cleanup(): Promise<void> {
    await this.writing.catch(() => {});
    await fs.promises.rm(this.dir, { recursive: true, force: true });
  }

  private file(period: Period): string {
    return path.join(this.dir, `${period}.jsonl`);
  }
}
