import { fetch, Response } from 'undici';
import { Country } from './country.types';
import { perMonth, requestMatcher } from './opendatasoft';
import { env } from '../config/env';
import { Period, TradeFlow, TradeRecord } from '../types';
import { BROWSER_UA, RetryableError } from '../utils/http';
import { splitPeriod } from '../utils/period';
import { ProxyPool, Route } from '../utils/proxy-pool';

/**
 * Office des Changes' foreign trade database (Base de données du commerce extérieur): a query form
 * whose result page holds a token for a CSV export of the whole query. The site refuses connections
 * from some networks (not by country), so requests go through a ProxyPool (direct when that works).
 * It allows 2 queries every 3 minutes per session, so each request opens its own session.
 */
const SITE = 'https://services.oc.gov.ma';
const BASE = `${SITE}/DataBase/CommerceExterieur`;
const FORM_URL = `${BASE}/requete.htm`;
const QUERY_URL = `${BASE}/resultat-recherche.htm`;
const EXPORT_URL = `${BASE}/export-csv-tabulaire.htm`;

/**
 * The flows of each direction: 14 imports CAF and 24 exports FAB, plus the inward-processing
 * (admission temporaire pour perfectionnement actif) imports 141/142 and their re-exports 241/242,
 * with and without payment. Each row keeps its flow code, so they can be told apart.
 */
const FLUX: Record<TradeFlow, string[]> = { IMPORT: ['14', '141', '142'], EXPORT: ['24', '241', '242'] };

/** The result's columns (the form's checkboxes) and indicators */
const COLUMNS = [
  'cbCodeProduitSH',
  'cbLibelleProduitSH',
  'cbCodeGroupementUtilisation',
  'cbLibelleGroupementUtilisation',
  'cbCodeNouveauProduitsRemarquables',
  'cbLibelleNouveauProduitsRemarquables',
  'cbCodePays',
  'cbLibellePays',
  'cbCodeFlux',
  'cbLibelleFlux',
  'cbMois',
  'cbAnnee',
];
const INDICATORS = ['cbPoids', 'cbValeurDHS', 'cbUniteComplementaire'];

/** The export's headers, by the field each is written as */
const HEADERS = {
  hs_code: 'Code du produit SH',
  description: 'Libellé du produit SH',
  usage_group_code: "Code du groupement d'utilisation",
  usage_group: "Libellé du groupement d'utilisation",
  remarkable_product_code: 'Code du nouveau produits remarquables',
  remarkable_product: 'Libellé du nouveau produits remarquables',
  partner_code: 'Code du pays',
  partner: 'Libellé du pays',
  flow_code: 'Code du flux',
  flow: 'Libellé du flux',
  year: 'Année',
  month: 'Mois',
  weight_kg: 'Poids en KG',
  value_mad: 'Valeur DHS',
  supplementary_unit: 'Unité complementaire',
} as const;
const AMOUNTS = new Set<keyof typeof HEADERS>(['weight_kg', 'value_mad', 'supplementary_unit']);

const PAGE_TIMEOUT_MS = 60_000;
/** A whole month runs in seconds; a query far longer means the session is stuck */
const QUERY_TIMEOUT_MS = 180_000;
/** A month and flow is 3–8 MB and takes 1–3 minutes through a proxy */
const EXPORT_TIMEOUT_MS = 600_000;
/** Sessions (each on a route) tried for one request before it fails and the engine retries it */
const ATTEMPTS = 5;

const pool = new ProxyPool({
  name: 'Office des Changes',
  testUrl: FORM_URL,
  testMarker: 'resultat-recherche.htm',
  fixed: env.ocProxies,
  fixedEnv: 'OC_PROXY',
  useFree: env.OC_FREE_PROXIES,
  // Not filtered by country: the site refuses some networks, not countries
  freeLists: [
    'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&timeout=3000',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  ],
});

type Log = (level: 'info' | 'warn', message: string) => void;

/** The site's per-session limit was hit; a new session gets through at once */
class Limited extends Error {}

/** One visitor on one route: keeps the cookies (session and firewall) the site sets */
class Session {
  private cookies = new Map<string, string>();

  constructor(
    private readonly route: Route,
    private readonly signal: AbortSignal
  ) {}

  async send(url: string, timeoutMs: number, form?: string): Promise<Response> {
    const res = await fetch(url, {
      method: form ? 'POST' : 'GET',
      body: form,
      dispatcher: this.route.dispatcher,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: '*/*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded', Origin: SITE, Referer: FORM_URL } : {}),
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url.slice(BASE.length + 1)}`);
    return res;
  }

  async text(url: string, timeoutMs: number, form?: string): Promise<string> {
    const text = await (await this.send(url, timeoutMs, form)).text();
    if (/limite autoris/i.test(text)) throw new Limited(text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    return text;
  }
}

/** The query form's fields as the page posts them (lists joined with commas) */
function queryForm(period: Period, flow: TradeFlow, extra: Record<string, string> = {}): string {
  const { year, month } = splitPeriod(period);
  return new URLSearchParams({
    Columns: COLUMNS.join(','),
    ColumnsIndicateur: INDICATORS.join(','),
    Annees: String(year),
    Mois: String(month),
    Page: '0',
    ExportToken: '',
    Flux: FLUX[flow].join(','),
    ChapSH: '',
    ProduitSH: '',
    Continents: '',
    Pays: '',
    DesignationFlux: '',
    DesignationChapSH: '',
    DesignationProduitSH: '',
    DesignationContinents: '',
    DesignationPays: '',
    gRecaptchaResponse: '',
    ...extra,
  }).toString();
}

/** French amounts: spaces between thousands, a decimal comma ("2 188 271,001") */
const amount = (s: string): number | null => {
  const clean = s.replace(/[\s  ]/g, '').replace(',', '.');
  return clean === '' ? null : Number(clean);
};

/**
 * Whether the result page's first rows hold anything: an unpublished month isn't refused but comes
 * back zero-filled (and exporting it fails with HTTP 500). A row's amounts are its last cells.
 */
export function pageHasTrade(html: string): boolean {
  for (const row of html.split(/<tr[\s>]/i).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/gi)].map((m) => m[1]);
    if (cells.length <= INDICATORS.length) continue;
    if (cells.slice(-INDICATORS.length).some((c) => (amount(c) ?? 0) !== 0)) return true;
  }
  return false;
}

/** The query's row count, from "Nombre de lignes total de votre requête : 56079" */
export function totalRows(html: string): number | undefined {
  const m = /Nombre de lignes total[^:]*:\s*([\d\s ]+)/i.exec(html);
  return m ? Number(m[1].replace(/\D/g, '')) : undefined;
}

/**
 * Splits a line of the export. Every field is quoted and separated by ";", and data lines end with
 * an extra ";". Quotes inside labels aren't escaped ("AUTRES PREPARATIONS "CHOCOLAT BLANC", …"), so
 * the line is split on the whole `";"` between fields rather than read as standard CSV.
 */
function splitLine(line: string): string[] {
  return line.replace(/^"/, '').replace(/";?$/, '').split('";"');
}

/**
 * The export's rows as records, keeping those under the requested codes, with the file's row count
 * (to tell a cut-off download) and its whole value (0: not published)
 */
export function parseExport(text: string, flow: TradeFlow, hsCodes: string[]): { records: TradeRecord[]; rows: number; value: number } {
  const lines = text.replace(/^﻿/, '').split('\n');
  const header = splitLine(lines[0].replace(/\r$/, '')).map((h) => h.trim());
  const at = Object.fromEntries(Object.entries(HEADERS).map(([field, name]) => [field, header.indexOf(name)])) as Record<keyof typeof HEADERS, number>;
  if (at.hs_code < 0 || at.value_mad < 0 || at.flow_code < 0) {
    throw new Error(`not an Office des Changes export: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  const matches = requestMatcher(hsCodes);
  const records: TradeRecord[] = [];
  let value = 0;
  let rows = 0;
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    // A whole line has every column and ends with '";'; anything less was cut off
    const fields = splitLine(line);
    if (!line.endsWith('";') || fields.length < header.length) throw new Error(`the export was cut off after ${rows} rows`);
    rows++;
    value += amount(fields[at.value_mad] ?? '') ?? 0;
    const hsCode = fields[at.hs_code]?.trim() ?? '';
    const request = matches(hsCode);
    if (!request) continue;
    const record: TradeRecord = { trade_flow: flow, request_hs_code: request };
    for (const [field, index] of Object.entries(at) as [keyof typeof HEADERS, number][]) {
      if (index < 0) continue;
      const cell = (fields[index] ?? '').trim();
      record[field] = AMOUNTS.has(field) ? amount(cell) : cell;
    }
    records.push(record);
  }
  return { records, rows, value };
}

/**
 * Every row of a month and flow: a new session opens the form, runs the query (whose page holds the
 * export token) and exports it as CSV. An unpublished month comes back as zeros: no rows then.
 */
async function exportMonth(period: Period, flow: TradeFlow, hsCodes: string[], signal: AbortSignal, log?: Log): Promise<TradeRecord[]> {
  const what = `${period} ${flow.toLowerCase()}`;
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const route = await pool.route(signal);
    try {
      const session = new Session(route, signal);
      await session.text(FORM_URL, PAGE_TIMEOUT_MS);
      const page = await session.text(QUERY_URL, QUERY_TIMEOUT_MS, queryForm(period, flow));
      if (!/Nombre de lignes total/i.test(page)) throw new Error(`unexpected result page: ${page.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150)}`);
      if (!pageHasTrade(page)) {
        log?.('info', `Office des Changes: ${what} has no trade yet (not published)`);
        return [];
      }
      const token = /id="ajaxExportToken"\s+value="([^"]+)"/.exec(page)?.[1];
      if (!token) throw new Error('the result page has no export token');
      const form = queryForm(period, flow, { ExportToken: token, ExtractionAction: '1', ExtractionMode: '0', ExtractionSeparateur: ';' });
      const res = await session.send(EXPORT_URL, EXPORT_TIMEOUT_MS, form);
      const text = await res.text();
      if (!/text\/csv/i.test(res.headers.get('content-type') ?? '')) {
        if (/limite autoris/i.test(text)) throw new Limited('export refused by the rate limit');
        throw new Error(`the export is not a CSV: ${text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150)}`);
      }
      const { records, rows, value } = parseExport(text, flow, hsCodes);
      // Free proxies often drop long downloads; a short file is fetched again on another route
      const expected = totalRows(page);
      if (expected !== undefined && rows !== expected) throw new Error(`the export has ${rows} of the query's ${expected} rows (cut off)`);
      pool.succeeded(route);
      log?.('info', `Office des Changes: ${what}: ${rows} rows via ${route.label}`);
      return value === 0 ? [] : records;
    } catch (err: any) {
      if (signal.aborted) throw signal.reason;
      last = err;
      if (err instanceof Limited) {
        // The limit is per session: the next attempt opens a new one on the same kind of route
        log?.('warn', `Office des Changes: ${what} hit the site's limit (${err.message}); opening a new session`);
        continue;
      }
      pool.failed(route);
      log?.('warn', `Office des Changes: ${what} failed via ${route.label} (${err?.cause?.code ?? err?.message}); trying another route`);
    }
  }
  throw new RetryableError(`Office des Changes: ${what} failed in ${ATTEMPTS} sessions (${(last as any)?.message})`);
}

/** Office des Changes foreign trade statistics: every 10-digit product × partner country of a month */
export const morocco: Country = {
  code: 'MAR',
  name: 'Morocco',
  source: {
    name: 'Office des Changes: base de données du commerce extérieur',
    url: FORM_URL,
    endpoint: `${QUERY_URL} (query, gives an export token) → ${EXPORT_URL} (CSV)`,
    method:
      'The query form, no key or login: each request opens a session, runs one month and flow (imports 14, 141, 142; exports 24, 241, 242) ' +
      'and exports the result as CSV, every product and partner at once. The site refuses some networks, so it is reached directly ' +
      'when possible, else through OC_PROXY or free public proxies (TLS end to end). It allows 2 queries per session every 3 minutes.',
    output:
      '10-digit national HS code and description, usage group and "produits remarquables" code and label, partner ISO code and French name ' +
      '(AV is ship supplies, AP other countries), flow code and label (CAF imports, FAB exports, inward-processing imports and re-exports ' +
      'with or without payment), year, month, weight in kg, value in dirhams and supplementary unit.',
  },
  // June 2026 was the latest month on 16 November 2026
  lagMonths: 4,
  publishDay: 1,
  startPeriod: '1998-01',
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint:
    'Every code comes with each month, so no list is needed. Codes are 10-digit national lines; enter 2 to 10 digits to keep only those codes.',
  // Each request is a session of three calls, one of them a 1–3 minute export
  rateLimitPerMinute: 6,
  concurrency: 2,
  retryDelayMs: 60_000,
  allHsCodes: true,

  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{2,10}$/.test(digits) ? digits : null;
  },

  splitQueries: perMonth,

  async fetchRecords({ hsCodes, periods: [period], tradeType }, signal, { log }) {
    const records = await exportMonth(period, tradeType, hsCodes, signal, log);
    return new Map<Period, TradeRecord[]>(records.length ? [[period, records]] : []);
  },
};
