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
  source: {
    name: 'BPS (Statistics Indonesia) DataExim API',
    url: 'https://webapi.bps.go.id/',
    endpoint: 'https://webapi.bps.go.id/v1/api/dataexim',
    method: 'JSON API, one request per HS code, flow and year (cached and split into months); returns one row per partner country and port.',
    output: 'Every field of the response (HS code and description, port, partner, net weight in kg, value in USD), plus the requested HS code and flow.',
  },
  lagMonths: 2,
  publishDay: 15,
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint: 'Indonesia needs 8-digit codes.',
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

    // The yearly response is cut to the requested month; every field is kept as returned,
    // with the flow added in front (the response doesn't carry it)
    return rows
      .filter((r) => (String(r.bulan || '').match(/\[(\d{2})\]/)?.[1] ?? String(r.bulan || '').trim().padStart(2, '0')) === mm)
      .map((r) => ({ request_hs_code: hsCode, trade_flow: tradeType, ...r }));
  },
};
