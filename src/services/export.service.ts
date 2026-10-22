import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { env } from '../config/env';
import { Period, TradeRecord } from '../types';
import { storageService } from './storage.service';

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Rows saved before raw rows were kept carry the response under `rawRecord` */
function asRaw(record: TradeRecord): TradeRecord {
  const raw = record.rawRecord;
  if (raw && typeof raw === 'object') return { request_hs_code: record.hsCode, trade_flow: record.tradeType, ...(raw as TradeRecord) };
  return record;
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
 * One file per country-month in Storage, holding every row stored for that month:
 *
 *   {CC}/{YYYY}/{CC}_{YYYY-MM}.csv               written by extractions (replaced on each run)
 *   {CC}/{YYYY}/{CC}_{YYYY-MM}__{name}.xlsx      uploaded by users for download-only countries
 *
 * Columns are the source's own fields, in the order they first appear.
 */
export class ExportService {
  public pathFor(countryCode: string, period: Period): string {
    return `${countryCode}/${period.slice(0, 4)}/${countryCode}_${period}.csv`;
  }

  /** Where an uploaded file for a month is stored; the original name is kept, made path-safe */
  public uploadPathFor(countryCode: string, period: Period, originalName: string): string {
    const clean = originalName.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(-120) || 'file';
    return `${countryCode}/${period.slice(0, 4)}/${countryCode}_${period}__${clean}`;
  }

  public describe(relativePath: string): ExportFileInfo {
    const m = (relativePath.split('/').pop() ?? '').match(FILE_RE);
    if (!m) return { countryCode: null, period: null, origin: 'uploaded' };
    return { countryCode: m[1].toUpperCase(), period: m[2], origin: m[3] ? 'uploaded' : 'extracted' };
  }

  /**
   * Writes the month's CSV from `rows` (called twice: once to collect the columns, once to
   * write) to a temp file, then uploads it over the previous one. Returns the path and row count.
   */
  public async writeCountryPeriod(countryCode: string, period: Period, rows: () => Iterable<TradeRecord>): Promise<{ path: string; rows: number }> {
    const columns = new Set<string>();
    for (const record of rows()) for (const key of Object.keys(asRaw(record))) columns.add(key);
    const header = [...columns];

    let count = 0;
    function* lines(): Generator<string> {
      yield '﻿' + header.map(escapeCell).join(',');
      for (const record of rows()) {
        const raw = asRaw(record);
        count++;
        yield '\r\n' + header.map((c) => escapeCell(raw[c])).join(',');
      }
    }

    await fs.promises.mkdir(env.tempDir, { recursive: true });
    const tempPath = path.join(env.tempDir, `${countryCode}_${period}_${process.pid}_${Date.now()}.csv`);
    const relativePath = this.pathFor(countryCode, period);
    try {
      await pipeline(Readable.from(lines()), fs.createWriteStream(tempPath));
      await storageService.uploadFile(relativePath, tempPath, 'text/csv; charset=utf-8');
    } finally {
      await fs.promises.rm(tempPath, { force: true });
    }
    return { path: relativePath, rows: count };
  }
}

export const exportService = new ExportService();
