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
  lagMonths: 2,
  tradeTypes: ['IMPORT', 'EXPORT'],

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
    const isExport = tradeType === 'EXPORT';

    return list
      // Unpublished months come back as one zero-valued row per partner country
      .filter((r) => parseFloat(String(r.value_usd || 0)) > 0 || parseFloat(String(r.quantity || 0)) > 0)
      .map((r) => {
        const qty = parseFloat(String(r.quantity || 0));
        const usd = parseFloat(String(r.value_usd || 0));
        const partner = r.country_name_en || '';
        return {
          date: `${r.year || year}-${String(r.month || month).padStart(2, '0')}-01`,
          hsCode,
          productDescription: r.description || '',
          tradeType,
          importer: isExport ? '' : 'Thailand Importer',
          exporter: isExport ? 'Thailand Exporter' : '',
          originCountry: isExport ? 'Thailand' : partner,
          destinationCountry: isExport ? partner : 'Thailand',
          quantity: isNaN(qty) ? undefined : qty,
          unit: 'KG',
          valueUsd: isNaN(usd) ? undefined : usd,
          port: '',
          declarationNo: '',
          accQuantity: r.acc_quantity,
          accValueUsd: r.acc_value_usd,
          countryIsoCode2: r.country_code,
          rawRecord: r,
        };
      });
  },
};
