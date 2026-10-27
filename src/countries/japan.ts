import { Country, FetchQuery } from './country.types';
import { TradeFlow, TradeRecord } from '../types';
import { getJson } from '../utils/http';
import { splitPeriod } from '../utils/period';

const API_BASE = process.env.JPN_API_BASE || 'https://api.e-stat.go.jp/rest/3.0/app/json';
/** Trade Statistics, Ministry of Finance */
const STATS_CODE = '00350300';
const TABLE_NAMES: Record<TradeFlow, string> = {
  IMPORT: 'Trade Statistics Data for Japan Commodity by Country Import',
  EXPORT: 'Trade Statistics Data for Japan Commodity by Country Export',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** HS codes per request (codes of one heading always share a request) */
const BATCH_SIZE = 20;
/** Commodity codes per API call */
const CODES_PER_CALL = 100;
/** e-Stat re-issues a year's table under a new ID as months are added, so lookups are kept briefly */
const CACHE_MS = 30 * 60_000;

type Field = 'unit1' | 'unit2' | 'quantity1' | 'quantity2' | 'value';
type Values = Partial<Record<Field, string>>;

/** One commodity and partner country: its units, and per month the quantities and value */
interface Line {
  units: Values;
  byMonth: Map<number, Values>;
}

interface Table {
  id: string;
  /** Commodity codes (9-digit statistical codes) */
  commodities: string[];
  countries: Map<string, string>;
  /** "2026" → its time code */
  years: Map<string, string>;
  /** cat02 code → what it holds; month 0 is a unit, which applies to every month */
  metrics: Map<string, { field: Field; month: number }>;
}

const text = (v: unknown): string => String((v && typeof v === 'object' ? (v as any).$ : v) ?? '').normalize('NFKC').trim();
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const positive = (v: string | undefined) => Number((v ?? '').replace(/,/g, '')) > 0;

/** Calls the e-Stat JSON API; "no data" comes back as a normal response */
async function estat(endpoint: string, params: Record<string, string>): Promise<any> {
  const query = new URLSearchParams({ appId: process.env.ESTAT_APP_ID ?? '', lang: 'E', ...params });
  const res = await getJson(`${API_BASE}/${endpoint}?${query}`, { source: 'e-Stat' });
  const body = Object.values(res ?? {})[0] as any;
  const status = Number(body?.RESULT?.STATUS);
  // 0 ok, 1 no data, 2 ok with ignored parameters; 100+ are errors
  if (!(status < 100)) throw new Error(`e-Stat: ${body?.RESULT?.ERROR_MSG ?? 'unexpected response'}`);
  return body;
}

const cache = new Map<string, { at: number; value: Promise<any> }>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

function loadTable(id: string): Promise<Table> {
  return cached(`meta:${id}`, async () => {
    const body = await estat('getMetaInfo', { statsDataId: id });
    const classes = list<any>(body.METADATA_INF?.CLASS_INF?.CLASS_OBJ);
    const items = (dim: string) => list<any>(classes.find((c) => c['@id'] === dim)?.CLASS);

    const metrics = new Map<string, { field: Field; month: number }>();
    for (const item of items('cat02')) {
      // "Unit1", "Quantity2-March", "Value-March"; yearly totals are skipped
      const m = text(item['@name']).match(/^(Unit|Quantity|Value)([12]?)(?:-(\w+))?$/);
      if (!m) continue;
      const month = m[3] ? MONTHS.indexOf(m[3]) + 1 : 0;
      if (m[1] === 'Unit') metrics.set(item['@code'], { field: `unit${m[2]}` as Field, month: 0 });
      else if (month > 0) metrics.set(item['@code'], { field: (m[1] === 'Value' ? 'value' : `quantity${m[2]}`) as Field, month });
    }
    if (!metrics.size) throw new Error(`e-Stat table ${id} has an unexpected layout (no monthly quantity/value items)`);

    return {
      id,
      commodities: items('cat01').map((c) => String(c['@code'])),
      countries: new Map(items('area').map((c) => [String(c['@code']), text(c['@name'])])),
      years: new Map(items('time').map((c) => [text(c['@name']), String(c['@code'])])),
      metrics,
    };
  });
}

/** The current table holding `year` for a flow; a table usually covers several years */
async function findTable(flow: TradeFlow, year: number): Promise<Table | null> {
  const body = await cached('tables', () => estat('getStatsList', { statsCode: STATS_CODE, searchWord: 'Commodity AND Country', limit: '1000' }));
  const candidates = list<any>(body.DATALIST_INF?.TABLE_INF)
    .filter((t) => text(t.STATISTICS_NAME) === TABLE_NAMES[flow] && Number(text(t.SURVEY_DATE).slice(0, 4)) >= year)
    .sort((a, b) => text(a.SURVEY_DATE).localeCompare(text(b.SURVEY_DATE)));
  for (const t of candidates) {
    const table = await loadTable(String(t['@id']));
    if (table.years.has(String(year))) return table;
  }
  return null;
}

/**
 * The table's codes for a requested code: itself when the table has it, else every code under it.
 * Import and export use different 9-digit codes, so a 9-digit code the table lacks falls back to
 * its 6-digit HS subheading.
 */
function resolveCodes(table: Table, code: string): string[] {
  if (table.commodities.includes(code)) return [code];
  const prefix = code.length === 9 ? code.slice(0, 6) : code;
  return table.commodities.filter((c) => c.startsWith(prefix));
}

/** Requests per year, with codes of one 4-digit heading kept together so fallbacks never overlap */
function splitQueries(hsCodes: string[], periods: string[], tradeType: TradeFlow): FetchQuery[] {
  const headings = new Map<string, string[]>();
  for (const code of hsCodes) headings.set(code.slice(0, 4), [...(headings.get(code.slice(0, 4)) ?? []), code]);
  const batches: string[][] = [];
  for (const group of headings.values()) {
    const last = batches[batches.length - 1];
    if (last && last.length + group.length <= BATCH_SIZE) last.push(...group);
    else batches.push([...group]);
  }

  const years = new Map<number, string[]>();
  for (const p of periods) years.set(splitPeriod(p).year, [...(years.get(splitPeriod(p).year) ?? []), p]);
  return [...years.values()].flatMap((yearPeriods) => batches.map((codes) => ({ hsCodes: codes, periods: yearPeriods, tradeType })));
}

/** e-Stat (Japan Ministry of Finance trade statistics), commodity by country */
export const japan: Country = {
  code: 'JPN',
  name: 'Japan',
  source: {
    name: 'e-Stat: Trade Statistics of Japan (Ministry of Finance)',
    url: 'https://www.e-stat.go.jp/en/stat-search/database?statdisp_id=0004049306',
    endpoint: `${API_BASE}/getStatsData (tables "Commodity by Country Import" / "Export")`,
    method:
      'JSON API. The current table for each flow and year is looked up first (e-Stat re-issues it under a new ID every month). ' +
      'One request per flow, year and batch of up to 20 HS codes returns every month of that year.',
    output:
      'One row per 9-digit commodity code, partner country and month: units and quantities (two units), value in thousand yen, ' +
      'with the flow, country code and name, year and month. Rows without trade are left out.',
  },
  lagMonths: 2,
  publishDay: 1,
  startPeriod: '2026-01',
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint:
    'Japan uses 9-digit statistical codes (import and export codes differ); 4 or 6 digits return every code under them. ' +
    'A 9-digit code missing from a flow returns that flow’s codes under its 6-digit subheading.',
  requiredEnv: ['ESTAT_APP_ID'],
  concurrency: 2,

  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{4,9}$/.test(digits) ? digits : null;
  },

  splitQueries,

  async fetchRecords({ hsCodes, periods, tradeType }) {
    const year = splitPeriod(periods[0]).year;
    const table = await findTable(tradeType, year);
    // No table for the year yet: nothing published
    if (!table) return new Map();
    const codes = [...new Set(hsCodes.flatMap((c) => resolveCodes(table, c)))];
    if (!codes.length) return new Map();

    const months = periods.map((p) => splitPeriod(p).month);
    const metricCodes = [...table.metrics].filter(([, m]) => m.month === 0 || months.includes(m.month)).map(([code]) => code);

    // By "commodity|country"
    const lines = new Map<string, Line>();
    for (let i = 0; i < codes.length; i += CODES_PER_CALL) {
      let startPosition: string | undefined = '1';
      while (startPosition) {
        const body = await estat('getStatsData', {
          statsDataId: table.id,
          metaGetFlg: 'N',
          cntGetFlg: 'N',
          cdCat01: codes.slice(i, i + CODES_PER_CALL).join(','),
          cdCat02: metricCodes.join(','),
          cdTime: table.years.get(String(year))!,
          startPosition,
        });
        for (const v of list<any>(body.STATISTICAL_DATA?.DATA_INF?.VALUE)) {
          const metric = table.metrics.get(String(v['@cat02']));
          if (!metric) continue;
          const key = `${v['@cat01']}|${v['@area']}`;
          const line: Line = lines.get(key) ?? { units: {}, byMonth: new Map() };
          lines.set(key, line);
          if (metric.month === 0) line.units[metric.field] = text(v.$);
          else {
            const values = line.byMonth.get(metric.month) ?? {};
            values[metric.field] = text(v.$);
            line.byMonth.set(metric.month, values);
          }
        }
        startPosition = body.STATISTICAL_DATA?.RESULT_INF?.NEXT_KEY ? String(body.STATISTICAL_DATA.RESULT_INF.NEXT_KEY) : undefined;
      }
    }

    const out = new Map<string, TradeRecord[]>();
    for (const period of periods) {
      const month = splitPeriod(period).month;
      const rows: TradeRecord[] = [];
      for (const [key, line] of lines) {
        const m = line.byMonth.get(month);
        if (!m || !(positive(m.value) || positive(m.quantity1) || positive(m.quantity2))) continue;
        const [hsCode, area] = key.split('|');
        rows.push({
          trade_flow: tradeType,
          hs_code: hsCode,
          country_code: area,
          country_name: table.countries.get(area) ?? '',
          year,
          month,
          unit1: line.units.unit1 ?? '',
          quantity1: m.quantity1 ?? '',
          unit2: line.units.unit2 ?? '',
          quantity2: m.quantity2 ?? '',
          value_1000_yen: m.value ?? '',
        });
      }
      if (rows.length) out.set(period, rows.sort((a, b) => String(a.hs_code).localeCompare(String(b.hs_code)) || String(a.country_code).localeCompare(String(b.country_code))));
    }
    return out;
  },
};
