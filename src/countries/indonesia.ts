import { Country } from './country.types';
import { getJson } from '../utils/http';
import { TtlCache } from '../utils/cache';
import { splitPeriod } from '../utils/period';

interface BpsRow {
  kodehs?: string; // "[84713020] Portable ..."
  bulan?: string; // "[08] Agustus"
  tahun?: string | number;
  ctr?: string;
  pod?: string;
  netweight?: string | number;
  value?: string | number;
  [key: string]: any;
}

// BPS returns a whole year per call; months of the same year share one response
const yearCache = new TtlCache<BpsRow[]>(15 * 60 * 1000);

/** BPS (Badan Pusat Statistik) DataExim API */
export const indonesia: Country = {
  code: 'IDN',
  name: 'Indonesia',
  lagMonths: 2,
  publishDay: 15,
  tradeTypes: ['IMPORT', 'EXPORT'],
  requiredEnv: ['BPS_API_KEY'],

  // 8-digit Indonesian tariff lines (BTKI)
  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{8}$/.test(digits) ? digits : null;
  },

  async fetchRecords({ hsCode, period, tradeType }) {
    const { year, month } = splitPeriod(period);
    const mm = String(month).padStart(2, '0');
    const sumber = tradeType === 'EXPORT' ? 1 : 2;
    const url = `https://webapi.bps.go.id/v1/api/dataexim/sumber/${sumber}/kodehs/${hsCode}/jenishs/2/tahun/${year}/periode/1/key/${process.env.BPS_API_KEY}`;

    const rows = await yearCache.get(url, async () => {
      const json = await getJson<any>(url, { source: 'BPS API', headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (json?.['data-availability'] !== 'available' || !json.data) return [];
      return Array.isArray(json.data) ? json.data : [json.data];
    });

    const isExport = tradeType === 'EXPORT';
    return rows
      .map((r) => ({
        r,
        code: String(r.kodehs || '').match(/\[?(\d{8})\]?\s*(.*)/),
        rowMonth: String(r.bulan || '').match(/\[(\d{2})\]/)?.[1] ?? String(r.bulan || '').trim().padStart(2, '0'),
      }))
      .filter(({ rowMonth }) => rowMonth === mm)
      .map(({ r, code, rowMonth }) => {
        const kg = parseFloat(String(r.netweight || 0));
        const usd = parseFloat(String(r.value || 0));
        return {
          date: `${r.tahun || year}-${rowMonth}-01`,
          hsCode: code?.[1] ?? hsCode,
          productDescription: code?.[2]?.trim() ?? '',
          tradeType,
          importer: isExport ? r.ctr || '' : 'PT Indonesia Importer',
          exporter: isExport ? 'PT Indonesia Exporter' : r.ctr || '',
          originCountry: isExport ? 'Indonesia' : r.ctr || '',
          destinationCountry: isExport ? r.ctr || '' : 'Indonesia',
          quantity: isNaN(kg) ? undefined : kg,
          unit: 'KG',
          valueUsd: isNaN(usd) ? undefined : usd,
          port: r.pod || '',
          declarationNo: '',
          rawRecord: r,
        };
      });
  },
};
