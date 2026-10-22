import { Country } from './country.types';
import { BROWSER_UA, getJson } from '../utils/http';
import { splitPeriod } from '../utils/period';

interface MocRow {
  year?: string | number;
  month?: string | number;
  country_code?: string; // partner country (destination for exports, origin for imports)
  country_name_en?: string;
  quantity?: string | number;
  acc_quantity?: string | number;
  value_usd?: string | number;
  acc_value_usd?: string | number;
  [key: string]: any;
}

const API_BASE = process.env.THA_API_BASE || 'https://tradereport.moc.go.th/api';

// Same response shape for both flows; only the endpoint differs
const ENDPOINTS = {
  EXPORT: 'exportharmonizecountries',
  IMPORT: 'importharmonizecountries',
} as const;

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

  // The API aggregates shorter prefixes, so 4–11 digits all work
  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{4,11}$/.test(digits) ? digits : null;
  },

  async fetchRecords({ hsCode, period, tradeType }) {
    const { year, month } = splitPeriod(period);
    const url = `${API_BASE}/${ENDPOINTS[tradeType]}?year=${year}&month=${month}&hs_code=${hsCode}&limit=100000`;
    const rows = await getJson<MocRow[] | { data?: MocRow[] }>(url, {
      source: 'Thai MOC',
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://tradereport.moc.go.th/' },
    });
    const list = Array.isArray(rows) ? rows : rows.data ?? [];
    // An unpublished month comes back as one zero-valued row per partner country
    const hasTrade = list.some((r) => parseFloat(String(r.value_usd || 0)) > 0 || parseFloat(String(r.quantity || 0)) > 0);
    if (!hasTrade) return [];
    // The response doesn't say which code and flow were asked for, so they lead each row
    return list.map((r) => ({ request_hs_code: hsCode, trade_flow: tradeType, ...r }));
  },
};
