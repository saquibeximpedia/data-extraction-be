import { Country } from './country.types';
import { BROWSER_UA, getJson } from '../utils/http';
import { splitPeriod } from '../utils/period';

const API_BASE = process.env.THA_API_BASE || 'https://tradereport.moc.go.th/api';
const ENDPOINTS = { EXPORT: 'exportharmonizecountries', IMPORT: 'importharmonizecountries' } as const;

/** Thailand Ministry of Commerce trade report, by partner country */
export const thailand: Country = {
  code: 'THA',
  name: 'Thailand',
  source: {
    name: 'Thailand Ministry of Commerce trade report',
    url: 'https://tradereport.moc.go.th/',
    endpoint: `${API_BASE}/importharmonizecountries · exportharmonizecountries`,
    method: 'JSON API, one request per HS code, month and flow; returns one row per partner country.',
    output: 'Every field of the response (values in USD and baht, quantities, year-to-date totals), plus the requested HS code and flow.',
  },
  lagMonths: 2,
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint: 'Thailand accepts 4 to 11 digits.',
  // One request per code, month and flow (~43,000 for a full month), answered in ~0.25s each;
  // the API handled 20 at once without throttling (Nov 2026), so the default 60/min would take ~12 hours
  concurrency: 8,
  rateLimitPerMinute: 1200,

  // The API aggregates shorter prefixes, so 4–11 digits all work
  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{4,11}$/.test(digits) ? digits : null;
  },

  async fetchRecords({ hsCodes: [hsCode], periods: [period], tradeType }, signal) {
    const { year, month } = splitPeriod(period);
    const url = `${API_BASE}/${ENDPOINTS[tradeType]}?year=${year}&month=${month}&hs_code=${hsCode}&limit=100000`;
    const res = await getJson<any[] | { data?: any[] }>(url, {
      source: 'Thai MOC',
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://tradereport.moc.go.th/' },
      signal,
      timeoutMs: 60_000,
    });
    const list = Array.isArray(res) ? res : res.data ?? [];
    // An unpublished month comes back as one zero-valued row per partner country
    const hasTrade = list.some((r) => parseFloat(String(r.value_usd || 0)) > 0 || parseFloat(String(r.quantity || 0)) > 0);
    return new Map(hasTrade ? [[period, list.map((r) => ({ request_hs_code: hsCode, trade_flow: tradeType, ...r }))]] : []);
  },
};
