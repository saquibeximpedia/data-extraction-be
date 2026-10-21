import { Period, TradeRecord } from '../types';
import { storageService } from './storage.service';

const COLUMNS: [header: string, value: (r: TradeRecord) => unknown][] = [
  ['Date', (r) => r.date],
  ['HS Code', (r) => r.hsCode],
  ['Product Description', (r) => r.productDescription],
  ['Trade Type', (r) => r.tradeType],
  ['Importer', (r) => r.importer],
  ['Exporter', (r) => r.exporter],
  ['Origin Country', (r) => r.originCountry],
  ['Destination Country', (r) => r.destinationCountry],
  ['Quantity', (r) => r.quantity],
  ['Unit', (r) => r.unit],
  ['Value (USD)', (r) => r.valueUsd],
  ['Value (Local)', (r) => r.valueLocal],
  ['Currency', (r) => r.currency],
  ['Port', (r) => r.port],
  ['Declaration No', (r) => r.declarationNo],
];

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Writes one CSV per country-month ({CC}/{CC}_{YYYY-MM}.csv) holding every
 * HS code and flow extracted for that month. Rebuilt from the ledger after each
 * run, so re-extracting a single HS code updates the file in place.
 */
export class ExportService {
  public relativePathFor(countryCode: string, period: Period): string {
    const year = period.split('-')[0];
    return `${countryCode}/${year}/${countryCode}_${period}.csv`;
  }

  public async writeCountryPeriod(countryCode: string, period: Period, records: TradeRecord[]): Promise<string> {
    const lines = [COLUMNS.map(([header]) => header).join(',')];
    for (const record of records) {
      lines.push(COLUMNS.map(([, value]) => escapeCell(value(record))).join(','));
    }

    const relativePath = this.relativePathFor(countryCode, period);

    // If a file for this period already exists, archive it with the overwrite date
    // so no historical data is ever automatically lost or silently overwritten
    await storageService.archiveIfExisting(relativePath);

    // Also check the old flat format (e.g. THA/THA_2026-08.csv) if present
    const legacyPath = `${countryCode}/${countryCode}_${period}.csv`;
    if (await storageService.fileExists(legacyPath)) {
      await storageService.archiveIfExisting(legacyPath);
    }

    await storageService.saveFile(relativePath, Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf-8'));
    return relativePath;
  }
}

export const exportService = new ExportService();
