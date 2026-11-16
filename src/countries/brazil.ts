import { Country } from './country.types';
import { perMonth, requestMatcher } from './opendatasoft';
import { Period, TradeFlow, TradeRecord } from '../types';
import { BROWSER_UA, RetryableError, getJson } from '../utils/http';
import { splitPeriod } from '../utils/period';

/** MDIC/SECEX's Comex Stat API, the one behind comexstat.mdic.gov.br */
const API = 'https://api-comexstat.mdic.gov.br';
/** A whole month of one flow (12–15 MB, about 20 s) */
const MONTH_TIMEOUT_MS = 240_000;
/** Lookup tables (countries, NCM descriptions and units) are read again after this long */
const TABLES_MS = 24 * 60 * 60 * 1000;
/** The latest published month is read again after this long */
const UPDATED_MS = 60 * 60 * 1000;

const FLOW: Record<TradeFlow, string> = { IMPORT: 'import', EXPORT: 'export' };
/** Imports carry freight, insurance and CIF; exports only FOB */
const METRICS: Record<TradeFlow, string[]> = {
  IMPORT: ['metricFOB', 'metricFreight', 'metricInsurance', 'metricCIF', 'metricKG', 'metricStatistic'],
  EXPORT: ['metricFOB', 'metricKG', 'metricStatistic'],
};

interface Row {
  coNcm: string;
  year: string;
  monthNumber: string;
  ncm: string;
  country: string;
  metricFOB?: string;
  metricFreight?: string;
  metricInsurance?: string;
  metricCIF?: string;
  metricKG?: string;
  metricStatistic?: string;
}

interface Tables {
  /** English country name (as the data gives it) → Comex Stat's 3-digit code */
  countryCodes: Map<string, string>;
  /** NCM → English description and statistical unit */
  ncm: Map<string, { description: string; unit: string }>;
}

const cached = <T>(ttl: number, load: (signal: AbortSignal) => Promise<T>) => {
  let entry: { at: number; value: Promise<T> } | null = null;
  return (signal: AbortSignal): Promise<T> => {
    if (!entry || Date.now() - entry.at > ttl) {
      const value = load(signal);
      entry = { at: Date.now(), value };
      // A failed read is tried again by the next request, not kept
      value.catch(() => (entry = null));
    }
    return entry.value;
  };
};

const get = <T>(path: string, signal: AbortSignal) =>
  getJson<T>(`${API}${path}`, { source: 'Comex Stat', signal, timeoutMs: 120_000, headers: { 'User-Agent': BROWSER_UA } });

const tables = cached<Tables>(TABLES_MS, async (signal) => {
  const [countries, ncm] = await Promise.all([
    get<{ data: { list: { id: string; text: string }[] } }>('/tables/countries?language=en', signal),
    get<{ data: { list: { coNcm: string; noNCM: string; unit: string }[] } }>('/tables/ncm?language=en', signal),
  ]);
  return {
    // Two codes share a name (Guernsey, Jersey): the first is kept
    countryCodes: new Map(countries.data.list.reverse().map((c) => [clean(c.text), c.id])),
    ncm: new Map(ncm.data.list.map((n) => [n.coNcm, { description: clean(n.noNCM), unit: clean(n.unit) }])),
  };
});

/** "YYYY-MM" of the latest month in Comex Stat */
const latestMonth = cached<Period>(UPDATED_MS, async (signal) => {
  const { data } = await get<{ data: { year: string; monthNumber: string } }>('/general/dates/updated', signal);
  return `${data.year}-${String(data.monthNumber).padStart(2, '0')}`;
});

/** ISO 3166 alpha-3 per Comex Stat country code, read once per code (the list doesn't carry it) */
const isoCodes = new Map<string, Promise<string>>();
function isoOf(code: string, signal: AbortSignal): Promise<string> {
  let iso = isoCodes.get(code);
  if (!iso) {
    iso = get<{ data: { coPaisIsoa3?: string } }>(`/tables/countries/${code}?language=en`, signal).then((r) => r.data?.coPaisIsoa3 ?? '');
    iso.catch(() => isoCodes.delete(code));
    isoCodes.set(code, iso);
  }
  return iso;
}

/** Looks up several country codes, a few at a time */
async function isoAll(codes: string[], signal: AbortSignal): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = [...codes];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let code = queue.shift(); code !== undefined; code = queue.shift()) out.set(code, await isoOf(code, signal));
    })
  );
  return out;
}

/** One flow's month, every NCM by partner country */
async function monthRows(period: Period, flow: TradeFlow, signal: AbortSignal): Promise<Row[]> {
  const body = { flow: FLOW[flow], monthDetail: true, period: { from: period, to: period }, details: ['ncm', 'country'], metrics: METRICS[flow] };
  let text: string;
  try {
    const res = await fetch(`${API}/general?language=en`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.any([signal, AbortSignal.timeout(MONTH_TIMEOUT_MS)]),
    });
    text = await res.text();
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`Comex Stat: temporary error HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Comex Stat: HTTP ${res.status} ${text.slice(0, 200)}`);
  } catch (err: any) {
    if (signal.aborted) throw signal.reason;
    if (err instanceof RetryableError || err instanceof Error && err.message.startsWith('Comex Stat: HTTP')) throw err;
    if (err?.name === 'TimeoutError') throw new RetryableError(`Comex Stat: no response within ${MONTH_TIMEOUT_MS / 1000}s`);
    throw new RetryableError(`Comex Stat: network error (${err?.message})`);
  }
  const json = JSON.parse(text);
  if (!Array.isArray(json?.data?.list)) throw new RetryableError(`Comex Stat: unexpected answer: ${text.slice(0, 300)}`);
  return json.data.list;
}

const num = (value: string | undefined) => (value === undefined || value === '' ? null : Number(value));
/** Some descriptions and names carry line breaks or doubled spaces */
const clean = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** MDIC/SECEX Comex Stat: every NCM by partner country, value, weight and statistical quantity */
export const brazil: Country = {
  code: 'BRA',
  name: 'Brazil',
  source: {
    name: 'Comex Stat (Ministry of Development, Industry, Trade and Services · SECEX)',
    url: 'https://comexstat.mdic.gov.br/en/geral',
    endpoint: `${API}/general (POST, details ncm + country, one month) · ${API}/tables/countries · ${API}/tables/ncm`,
    method:
      'Comex Stat’s public JSON API, no key: one request per flow and month returns every NCM by partner country (about 55,000–65,000 rows). ' +
      'Country codes, ISO codes, English NCM descriptions and statistical units come from its lookup tables, read once a day.',
    output:
      'One row per 8-digit NCM and partner country: hs_code, hs_description, partner_code (Comex Stat), partner_iso3, partner_name, value_fob_usd, ' +
      'freight_usd, insurance_usd and value_cif_usd (imports only), net_kg, stat_quantity and stat_unit. Nothing is withheld: the rows add up to the month’s total.',
    links: [
      { label: 'Comex Stat query (compare figures)', url: 'https://comexstat.mdic.gov.br/en/geral' },
      { label: 'Full database files (EXP/IMP by year)', url: 'https://www.gov.br/mdic/pt-br/assuntos/comercio-exterior/estatisticas/base-de-dados-bruta' },
    ],
  },
  // October 2026 was in Comex Stat on 6 November 2026 (admins can change it)
  lagMonths: 1,
  publishDay: 7,
  startPeriod: '1997-01',
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint: 'Not needed: every 8-digit NCM comes with each month. Enter 2–8 digits to keep only those codes.',
  concurrency: 2,
  rateLimitPerMinute: 20,
  allHsCodes: true,

  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{2,8}$/.test(digits) ? digits : null;
  },

  splitQueries: perMonth,

  async fetchRecords({ hsCodes, periods: [period], tradeType }, signal) {
    // A month not in Comex Stat yet has no rows (asking for it would return an empty list anyway)
    if (period > (await latestMonth(signal))) return new Map();
    const [rows, t] = await Promise.all([monthRows(period, tradeType, signal), tables(signal)]);
    const { year, month } = splitPeriod(period);
    const request = requestMatcher(hsCodes);
    const kept = rows.filter((r) => Number(r.year) === year && Number(r.monthNumber) === month && request(r.coNcm));
    const codes = [...new Set(kept.map((r) => t.countryCodes.get(clean(r.country)) ?? ''))].filter(Boolean);
    const iso = await isoAll(codes, signal);

    const records: TradeRecord[] = kept.map((r) => {
      const code = t.countryCodes.get(clean(r.country)) ?? '';
      const ncm = t.ncm.get(r.coNcm);
      return {
        trade_flow: tradeType,
        request_hs_code: request(r.coNcm),
        period,
        hs_code: r.coNcm,
        hs_description: ncm?.description ?? clean(r.ncm),
        partner_code: code,
        partner_iso3: iso.get(code) ?? '',
        partner_name: clean(r.country),
        value_fob_usd: num(r.metricFOB),
        ...(tradeType === 'IMPORT' ? { freight_usd: num(r.metricFreight), insurance_usd: num(r.metricInsurance), value_cif_usd: num(r.metricCIF) } : {}),
        net_kg: num(r.metricKG),
        stat_quantity: num(r.metricStatistic),
        stat_unit: ncm?.unit ?? '',
      };
    });
    return new Map<Period, TradeRecord[]>(records.length ? [[period, records]] : []);
  },
};
