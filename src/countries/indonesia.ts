import { Country, MonthRows } from './country.types';
import { getJson } from '../utils/http';

/** BPS (Badan Pusat Statistik) DataExim API */
export const indonesia: Country = {
  code: 'IDN',
  name: 'Indonesia',
  source: {
    name: 'BPS (Statistics Indonesia) DataExim API',
    url: 'https://webapi.bps.go.id/',
    endpoint: 'https://webapi.bps.go.id/v1/api/dataexim',
    method: 'JSON API, one request per HS code, flow and year (split into months); returns one row per partner country and port.',
    output: 'Every field of the response (HS code and description, port, partner, net weight in kg, value in USD), plus the requested HS code and flow.',
  },
  lagMonths: 2,
  publishDay: 15,
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint: 'Indonesia needs 8-digit codes.',
  requiredEnv: ['BPS_API_KEY'],

  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{8}$/.test(digits) ? digits : null;
  },

  // One request returns a whole year
  splitQueries: (hsCodes, periods, tradeType) =>
    hsCodes.flatMap((hsCode) =>
      [...new Set(periods.map((p) => p.slice(0, 4)))].map((year) => ({ hsCodes: [hsCode], periods: periods.filter((p) => p.startsWith(year)), tradeType }))
    ),

  async fetchRecords({ hsCodes: [hsCode], periods, tradeType }) {
    const year = periods[0].slice(0, 4);
    const sumber = tradeType === 'EXPORT' ? 1 : 2;
    const url = `https://webapi.bps.go.id/v1/api/dataexim/sumber/${sumber}/kodehs/${hsCode}/jenishs/2/tahun/${year}/periode/1/key/${process.env.BPS_API_KEY}`;
    const json = await getJson<any>(url, { source: 'BPS API', headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (json?.['data-availability'] !== 'available' || !json.data) return new Map();

    // "bulan" is "[08] Agustus"; the flow and requested code lead each row
    const out: MonthRows = new Map();
    for (const row of Array.isArray(json.data) ? json.data : [json.data]) {
      const bulan = String(row.bulan ?? '');
      const period = `${year}-${bulan.match(/\[(\d{2})\]/)?.[1] ?? bulan.trim().padStart(2, '0')}`;
      if (!periods.includes(period)) continue;
      out.set(period, [...(out.get(period) ?? []), { request_hs_code: hsCode, trade_flow: tradeType, ...row }]);
    }
    return out;
  },
};
