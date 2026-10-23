import fs from 'fs';
import path from 'path';
import { parseHsCsv } from '../utils/hs-codes';

const HS_DIR = path.resolve(process.cwd(), 'storage/hs_codes');

export type HsMode = 'complete' | 'test';

/**
 * Saved HS code lists, one CSV per country:
 * - Complete: storage/hs_codes/{CODE}.csv
 * - Test: storage/hs_codes/{CODE}_TEST.csv
 * They are edited on the server only and never sent to the client.
 */
export const hsCodesService = {
  filePath(countryCode: string, mode: HsMode = 'complete'): string {
    const base = countryCode.toUpperCase();
    const filename = mode === 'test' ? `${base}_TEST.csv` : `${base}.csv`;
    return path.join(HS_DIR, filename);
  },

  /** The country's saved codes (the test list falls back to the complete one), or [] */
  getSaved(countryCode: string, mode: HsMode = 'complete'): string[] {
    const file = [this.filePath(countryCode, mode), this.filePath(countryCode)].find((f) => fs.existsSync(f));
    return file ? parseHsCsv(fs.readFileSync(file, 'utf-8')) : [];
  },

  hasTestFile(countryCode: string): boolean {
    return fs.existsSync(this.filePath(countryCode, 'test'));
  },
};

