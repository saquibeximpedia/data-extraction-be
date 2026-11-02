import { Country, FetchQuery, MonthRows } from './country.types';
import { getJson } from '../utils/http';

/** HS codes per request: the most BPS accepts in `kodehs` */
const BATCH_SIZE = 20;

/** BPS (Badan Pusat Statistik) DataExim API */
export const indonesia: Country = {
  code: 'IDN',
  name: 'Indonesia',
  source: {
    name: 'BPS (Statistics Indonesia) DataExim API',
    url: 'https://webapi.bps.go.id/',
    endpoint: 'https://webapi.bps.go.id/v1/api/dataexim',
    method: `JSON API, one request per flow, year and batch of up to ${BATCH_SIZE} HS codes (split into months); returns one row per HS code, partner country and port.`,
    output: 'Every field of the response (HS code and description, port, partner, net weight in kg, value in USD), plus the requested HS code and flow.',
  },
  lagMonths: 2,
  publishDay: 15,
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint: 'Indonesia needs 8-digit codes.',
  requiredEnv: ['BPS_API_KEY'],
  // A key allows 60 requests a minute but only 1,000 an hour (and 10,000 a day): 15/min stays under
  // the hourly quota, which otherwise runs out within minutes and fails every request after it
  rateLimitPerMinute: 15,

  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{8}$/.test(digits) ? digits : null;
  },

  // One request returns a whole year for up to BATCH_SIZE codes
  splitQueries: (hsCodes, periods, tradeType) => {
    const years = [...new Set(periods.map((p) => p.slice(0, 4)))];
    const queries: FetchQuery[] = [];
    for (let i = 0; i < hsCodes.length; i += BATCH_SIZE) {
      for (const year of years) queries.push({ hsCodes: hsCodes.slice(i, i + BATCH_SIZE), periods: periods.filter((p) => p.startsWith(year)), tradeType });
    }
    return queries;
  },

  async fetchRecords({ hsCodes, periods, tradeType }, signal) {
    const year = periods[0].slice(0, 4);
    const sumber = tradeType === 'EXPORT' ? 1 : 2;
    const url = `https://webapi.bps.go.id/v1/api/dataexim/sumber/${sumber}/kodehs/${hsCodes.join('%2C')}/jenishs/2/tahun/${year}/periode/1/key/${process.env.BPS_API_KEY}`;
    const json = await getJson<any>(url, { source: 'BPS API', headers: { 'User-Agent': 'Mozilla/5.0' }, signal, timeoutMs: 180_000 });
    if (json?.['data-availability'] !== 'available' || !json.data) return new Map();

    // "bulan" is "[08] Agustus" and "kodehs" is "[01012900] live horses…"; the flow and the row's code lead each row
    const out: MonthRows = new Map();
    for (const row of Array.isArray(json.data) ? json.data : [json.data]) {
      const bulan = String(row.bulan ?? '');
      const period = `${year}-${bulan.match(/\[(\d{2})\]/)?.[1] ?? bulan.trim().padStart(2, '0')}`;
      if (!periods.includes(period)) continue;
      const hsCode = String(row.kodehs ?? '').match(/^\[(\d{8})\]/)?.[1] ?? (hsCodes.length === 1 ? hsCodes[0] : '');
      out.set(period, [...(out.get(period) ?? []), { request_hs_code: hsCode, trade_flow: tradeType, ...row }]);
    }
    return out;
  },
};
