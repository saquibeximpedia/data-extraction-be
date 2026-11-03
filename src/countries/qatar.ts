import { Country, DatasetRef } from './country.types';
import { chosenDataset, datasetFields, exportRows, noDataset, perMonth, pickDataset } from './opendatasoft';
import { Period, TradeRecord } from '../types';
import { getJson } from '../utils/http';
import { splitPeriod } from '../utils/period';

const API_BASE = process.env.QAT_API_BASE || 'https://www.data.gov.qa/api/explore/v2.1';

/**
 * Planning and Statistics Authority datasets on the Qatar Open Data Portal. Imports are split by
 * year range; exports are one dataset at 4 digits. Another can be chosen or entered on the extract page.
 */
const DATASETS: DatasetRef[] = [
  { flow: 'IMPORT', from: 2014, to: 2018, id: 'qatar-imports-2014-2018' },
  { flow: 'IMPORT', from: 2019, to: 2024, id: 'qatar-imports-2019-2024-copy' },
  { flow: 'IMPORT', from: 2025, to: 2100, id: 'qatar-imports-2025-2026' },
  { flow: 'EXPORT', from: 2014, to: 2100, id: 'qatar-export-statistics-2019-2024' },
];

/** Where a dataset keeps what is filtered on: each one names its fields differently */
interface Layout {
  yearField: string;
  yearIsDate: boolean;
  monthField: string;
  monthIsText: boolean;
  codeField: string;
  /** Digits of its codes. Numeric codes lose their leading zero, text ones keep it */
  digits: number;
}

const layouts = new Map<string, Promise<Layout>>();

/**
 * A dataset's layout, read from its field list (year/lsn_year, month/lshhr_month, hs8/hs4/
 * harmonized_system_code…). The code length comes from a name like "hs8", else from the longest code.
 */
function layoutOf(id: string, signal: AbortSignal): Promise<Layout> {
  let found = layouts.get(id);
  if (!found) {
    found = (async () => {
      const fields = await datasetFields(API_BASE, id, signal);
      const year = fields.find((f) => /year/i.test(f.name) && f.type === 'date') ?? fields.find((f) => /year/i.test(f.name));
      const month = fields.find((f) => /month/i.test(f.name));
      const code = fields.find((f) => /^hs\d+$/i.test(f.name)) ?? fields.find((f) => /harmoni[sz]ed|hs_?code/i.test(f.name));
      if (!year || !month || !code) throw new Error(`data.gov.qa: dataset ${id} has no recognisable year, month or HS code field (fields: ${fields.map((f) => f.name).join(', ')})`);
      let digits = Number(code.name.match(/^hs(\d+)$/i)?.[1]);
      if (!digits) {
        const top = await getJson<{ results: Record<string, unknown>[] }>(
          `${API_BASE}/catalog/datasets/${encodeURIComponent(id)}/records?${new URLSearchParams({ select: code.name, order_by: `${code.name} desc`, limit: '1' })}`,
          { source: 'data.gov.qa', signal }
        );
        digits = String(top.results[0]?.[code.name] ?? '').replace(/\D/g, '').length;
      }
      return { yearField: year.name, yearIsDate: year.type === 'date', monthField: month.name, monthIsText: month.type === 'text', codeField: code.name, digits };
    })();
    found.catch(() => layouts.delete(id));
    layouts.set(id, found);
  }
  return found;
}

/** The ODSQL condition for one month of a dataset */
function monthWhere(l: Layout, year: number, month: number): string {
  const y = l.yearIsDate ? `${l.yearField} = date'${year}'` : `${l.yearField} = ${year}`;
  const mm = String(month).padStart(2, '0');
  const m = l.monthIsText ? `(${l.monthField} = "${month}" or startswith(${l.monthField}, "${mm}"))` : `${l.monthField} = ${month}`;
  return `${y} and ${m}`;
}

/** PSA foreign trade statistics on the Qatar Open Data Portal (data.gov.qa), commodity by partner country */
export const qatar: Country = {
  code: 'QAT',
  name: 'Qatar',
  source: {
    name: 'Qatar Open Data Portal: foreign merchandise trade (Planning and Statistics Authority)',
    url: 'https://www.data.gov.qa/explore/?q=qatar+imports',
    endpoint: `${API_BASE}/catalog/datasets/{dataset}/exports/json (imports: qatar-imports-2014-2018 · qatar-imports-2019-2024-copy · qatar-imports-2025-2026; exports: qatar-export-statistics-2019-2024)`,
    method:
      'Opendatasoft Explore API v2.1, no key. One request per flow and month returns every HS code and partner; ' +
      'the year picks the dataset, whose year, month and code fields are read from its field list. Another dataset can be chosen or entered on the extract page.',
    output:
      'Every field of the dataset row (year, quarter, month, HS code, English and Arabic description and partner country, quantity, ' +
      'weight in kg, value in riyals), with the flow, the requested HS code and the HS code with its leading zero restored. ' +
      'In January 2026 imports the source copied value into quantity.',
  },
  // Months reach the portal irregularly, about eight months late (February 2026 was the latest in October 2026)
  lagMonths: 8,
  publishDay: 1,
  startPeriod: '2014-01',
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint:
    'Every code comes with each month, so no list is needed. Imports are 12-digit lines from 2025 (8-digit before); exports are ' +
    '4-digit headings only. Enter 4 to 12 digits to keep only those codes (longer codes keep their heading).',
  rateLimitPerMinute: 30,
  concurrency: 2,
  allHsCodes: true,
  datasets: DATASETS,

  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{4,12}$/.test(digits) ? digits : null;
  },

  splitQueries: perMonth,

  async fetchRecords({ hsCodes, periods: [period], tradeType }, signal, { dataset }) {
    const { year, month } = splitPeriod(period);
    const d = chosenDataset(DATASETS, dataset, tradeType, year, pickDataset(DATASETS, tradeType, year));
    if (!d) throw noDataset(API_BASE, tradeType, year);
    const l = await layoutOf(d.id, signal);
    const rows = await exportRows(API_BASE, d.id, monthWhere(l, year, month), signal);

    // Longest first, so a row goes to the most specific requested code that covers it; a code
    // longer than the dataset's is cut to its length (12 digits become an 8-digit line or 4-digit heading)
    const requested = [...hsCodes].sort((a, b) => b.length - a.length);
    const records: TradeRecord[] = [];
    for (const row of rows) {
      const hsCode = String(row[l.codeField] ?? '').padStart(l.digits, '0');
      const request = requested.length ? requested.find((c) => hsCode.startsWith(c.slice(0, l.digits))) : hsCode;
      if (request) records.push({ trade_flow: tradeType, request_hs_code: request, hs_code: hsCode, ...row });
    }
    return new Map<Period, TradeRecord[]>(records.length ? [[period, records]] : []);
  },
};
