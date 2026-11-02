import { Country, FetchQuery } from './country.types';
import { Period, TradeFlow, TradeRecord } from '../types';
import { getJson } from '../utils/http';
import { splitPeriod } from '../utils/period';

const API_BASE = process.env.QAT_API_BASE || 'https://www.data.gov.qa/api/explore/v2.1/catalog/datasets';
/** HS codes per request; each becomes one condition in the query string */
const BATCH_SIZE = 40;

/** One Opendatasoft dataset and the names it gives the fields that are filtered on */
interface Dataset {
  id: string;
  /** Years it holds (inclusive); `to` null: still being added to */
  from: number;
  to: number | null;
  yearField: string;
  monthField: string;
  codeField: string;
  /** Digits of its codes. Numeric codes lose their leading zero, text ones keep it */
  digits: number;
  codeType: 'int' | 'text';
}

/**
 * Planning and Statistics Authority datasets on the Qatar Open Data Portal. Imports are split
 * by year range, each with its own field names; exports are one dataset at 4 digits.
 */
const DATASETS: Record<TradeFlow, Dataset[]> = {
  IMPORT: [
    { id: 'qatar-imports-2014-2018', from: 2014, to: 2018, yearField: 'year', monthField: 'month', codeField: 'hs8', digits: 8, codeType: 'int' },
    { id: 'qatar-imports-2019-2024-copy', from: 2019, to: 2024, yearField: 'lsn_year', monthField: 'lshhr_month', codeField: 'hs8', digits: 8, codeType: 'text' },
    { id: 'qatar-imports-2025-2026', from: 2025, to: null, yearField: 'year', monthField: 'month', codeField: 'harmonized_system_code', digits: 12, codeType: 'int' },
  ],
  EXPORT: [
    { id: 'qatar-export-statistics-2019-2024', from: 2014, to: null, yearField: 'year', monthField: 'month', codeField: 'hs4', digits: 4, codeType: 'int' },
  ],
};

const datasetFor = (flow: TradeFlow, year: number) => DATASETS[flow].find((d) => year >= d.from && (d.to === null || year <= d.to));

/**
 * The ODSQL condition matching `code` in a dataset: the line itself when the code is at least
 * as long as the dataset's codes (longer ones are cut to its length), else every line under it
 */
function condition(d: Dataset, code: string): string {
  const c = code.slice(0, d.digits);
  if (d.codeType === 'text') return c.length === d.digits ? `${d.codeField} = "${c}"` : `startswith(${d.codeField}, "${c}")`;
  const scale = 10 ** (d.digits - c.length);
  return scale === 1 ? `${d.codeField} = ${Number(c)}` : `(${d.codeField} >= ${Number(c) * scale} and ${d.codeField} < ${(Number(c) + 1) * scale})`;
}

/**
 * The codes to ask a dataset for: cut to its length (12-digit codes become 8-digit lines before
 * 2025 and 4-digit headings for exports), without repeats or codes a shorter one already covers,
 * so no two requests return the same row
 */
function codesFor(d: Dataset | undefined, hsCodes: string[]): string[] {
  const cut = [...new Set(hsCodes.map((c) => (d ? c.slice(0, d.digits) : c)))].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const kept: string[] = [];
  for (const c of cut) if (!kept.some((k) => c.startsWith(k))) kept.push(c);
  return kept.sort();
}

/** One request per flow, year and batch of codes (a dataset holds whole years) */
function splitQueries(hsCodes: string[], periods: Period[], tradeType: TradeFlow): FetchQuery[] {
  const years = new Map<number, Period[]>();
  for (const p of periods) years.set(splitPeriod(p).year, [...(years.get(splitPeriod(p).year) ?? []), p]);
  return [...years].flatMap(([year, yearPeriods]) => {
    const codes = codesFor(datasetFor(tradeType, year), hsCodes);
    const queries: FetchQuery[] = [];
    for (let i = 0; i < codes.length; i += BATCH_SIZE) queries.push({ hsCodes: codes.slice(i, i + BATCH_SIZE), periods: yearPeriods, tradeType });
    return queries;
  });
}

/** PSA foreign trade statistics on the Qatar Open Data Portal (data.gov.qa), commodity by partner country */
export const qatar: Country = {
  code: 'QAT',
  name: 'Qatar',
  source: {
    name: 'Qatar Open Data Portal: foreign merchandise trade (Planning and Statistics Authority)',
    url: 'https://www.data.gov.qa/explore/?q=qatar+imports',
    endpoint: `${API_BASE}/{dataset}/exports/json (imports: qatar-imports-2014-2018 · qatar-imports-2019-2024-copy · qatar-imports-2025-2026; exports: qatar-export-statistics-2019-2024)`,
    method:
      'Opendatasoft Explore API v2.1, no key. One request per flow, year and batch of up to 40 HS codes returns every month asked for; ' +
      'the year picks the dataset (each import dataset names its fields differently).',
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
    'Qatar accepts 4 to 12 digits. Imports are 12-digit lines from 2025 (8-digit before); exports are 4-digit headings only, ' +
    'so longer codes return their heading. Shorter codes return every line under them.',
  rateLimitPerMinute: 30,
  concurrency: 2,

  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{4,12}$/.test(digits) ? digits : null;
  },

  splitQueries,

  async fetchRecords({ hsCodes, periods, tradeType }) {
    const year = splitPeriod(periods[0]).year;
    const d = datasetFor(tradeType, year);
    if (!d) return new Map();

    const months = periods.map((p) => splitPeriod(p).month);
    const codeConditions = [...new Set(hsCodes.map((c) => condition(d, c)))];
    const where = `${d.yearField} = date'${year}' and ${d.monthField} in (${months.join(', ')}) and (${codeConditions.join(' or ')})`;
    const rows = await getJson<Record<string, unknown>[]>(`${API_BASE}/${d.id}/exports/json?${new URLSearchParams({ where })}`, { source: 'data.gov.qa' });

    // Longest first, so a row goes to the most specific requested code that covers it
    const requested = [...hsCodes].sort((a, b) => b.length - a.length);
    const out = new Map<Period, TradeRecord[]>();
    for (const row of rows) {
      const hsCode = String(row[d.codeField] ?? '').padStart(d.digits, '0');
      const request = requested.find((c) => hsCode.startsWith(c.slice(0, d.digits)));
      const period = periods[months.indexOf(Number(row[d.monthField]))];
      if (!request || !period) continue;
      if (!out.has(period)) out.set(period, []);
      out.get(period)!.push({ trade_flow: tradeType, request_hs_code: request, hs_code: hsCode, ...row });
    }
    return out;
  },
};
