import { gunzipSync } from 'zlib';
import { Country, CountrySource, FetchQuery } from './country.types';
import { Period, TradeFlow, TradeRecord } from '../types';
import { RetryableError } from '../utils/http';

const API_ROOT = process.env.EU_API_BASE || 'https://ec.europa.eu/eurostat/api/comext/dissemination';
/** EU trade since 1988 by HS2-4-6 and CN8 */
const DATASET = 'ds-045409';
const DATA_URL = `${API_ROOT}/sdmx/3.0/data/dataflow/ESTAT/${DATASET}/1.0/*`;
const ASYNC_URL = `${API_ROOT}/1.0/async`;
const FLOW_CODES: Record<TradeFlow, string> = { IMPORT: '1', EXPORT: '2' };
/**
 * Eurostat refuses extractions estimated above 5,000,000 rows; one code costs ~26,000 estimated
 * rows per flow and month, so 150 codes stay under it (a batch that is still too big is halved)
 */
const BATCH_SIZE = 150;
const REQUEST_TIMEOUT_MS = 600_000;
/** Large extractions are queued; a job not ready by then is resubmitted */
const ASYNC_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 5000;
/** Totals computed by Eurostat (sums of the country rows), not individual countries */
const AGGREGATE_REPORTERS = new Set(['EU', 'EU27_2020', 'EU28', 'EA', 'EA19', 'EA20', 'EA21']);
const AGGREGATE_PARTNER = /^(WORLD|EXT_|INT_)/;

class ExtractionTooBig extends Error {}

class InvalidCodes extends Error {
  constructor(public readonly codes: string[]) {
    super(`Eurostat rejected product codes: ${codes.join(', ')}`);
  }
}

async function send(url: string): Promise<{ status: number; type: string; body: Buffer }> {
  let res: Response;
  let body: Buffer;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/vnd.sdmx.data+csv;version=2.0.0;labels=both' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Kept as a Buffer (outside the JS heap); a big batch's CSV runs to ~100 MB
    body = Buffer.from(await res.arrayBuffer());
  } catch (err: any) {
    throw new RetryableError(`Eurostat: network error (${err.message})`);
  }
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`Eurostat: temporary error HTTP ${res.status}`);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body };
}

/** The cells of one CSV line (quoted cells may hold commas and doubled quotes) */
function splitLine(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let cell = '';
      let from = i + 1;
      for (;;) {
        const quote = line.indexOf('"', from);
        if (quote < 0) {
          cell += line.slice(from);
          i = line.length + 1;
          break;
        }
        cell += line.slice(from, quote);
        if (line[quote + 1] === '"') {
          cell += '"';
          from = quote + 2;
        } else {
          // Past the closing quote and the comma after it
          i = quote + 2;
          break;
        }
      }
      cells.push(cell);
    } else {
      const comma = line.indexOf(',', i);
      const end = comma < 0 ? line.length : comma;
      cells.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return cells;
}

/** "AT: Austria" → ["AT", "Austria"] */
function label(cell: string): [string, string] {
  const at = cell.indexOf(': ');
  return at < 0 ? [cell, ''] : [cell.slice(0, at), cell.slice(at + 2)];
}

/**
 * Builds one row per product, reporter and partner, with the indicators side by side, straight
 * from the SDMX-CSV lines. Codes, names and values are kept exactly as Eurostat sends them.
 * Responses are read line by line and labels are shared between rows: a big batch has ~200,000
 * observations, each repeating long product and country names.
 */
class Rows {
  private readonly lines = new Map<string, TradeRecord>();
  private readonly labels = new Map<string, [string, string]>();

  /** Reads one SDMX-CSV response; Eurostat sends a .csv.gz attachment without saying so */
  public read(raw: Buffer): void {
    const buf = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    let col: Record<string, number> | null = null;
    let pending = '';
    for (let start = 0; start < buf.length; ) {
      const nl = buf.indexOf(10, start);
      const end = nl < 0 ? buf.length : nl;
      const line = pending + buf.toString('utf-8', start, end > start && buf[end - 1] === 13 ? end - 1 : end);
      start = end + 1;
      // A quoted cell holding a line break continues on the next line
      if ((line.match(/"/g)?.length ?? 0) % 2) {
        pending = `${line}\n`;
        continue;
      }
      pending = '';
      if (!line) continue;
      const cells = splitLine(line);
      if (!col) {
        // "reporter: REPORTER" → "reporter"
        const keys = cells.map((h) => h.replace(/^﻿/, '').split(':')[0].trim());
        col = Object.fromEntries(['reporter', 'partner', 'product', 'flow', 'indicators', 'TIME_PERIOD', 'OBS_VALUE'].map((k) => [k, keys.indexOf(k)]));
        if (Object.values(col).some((i) => i < 0)) throw new Error(`Eurostat: unexpected CSV header: ${line.slice(0, 300)}`);
        continue;
      }
      this.add(cells[col.TIME_PERIOD], cells[col.flow], cells[col.reporter], cells[col.partner], cells[col.product], cells[col.indicators], cells[col.OBS_VALUE] ?? '');
    }
  }

  public records(): TradeRecord[] {
    return [...this.lines.values()].sort(
      (a, b) =>
        String(a.product_code).localeCompare(String(b.product_code)) ||
        String(a.reporter_code).localeCompare(String(b.reporter_code)) ||
        String(a.partner_code).localeCompare(String(b.partner_code))
    );
  }

  /** "AT: Austria" → ["AT", "Austria"], the code and name as sent */
  private label(cell: string | undefined): [string, string] {
    const raw = cell ?? '';
    let hit = this.labels.get(raw);
    if (!hit) {
      hit = label(raw);
      this.labels.set(raw, hit);
    }
    return hit;
  }

  private add(period: string, flowCell: string, reporterCell: string, partnerCell: string, productCell: string, indicator: string, value: string): void {
    const [reporterCode, reporterName] = this.label(reporterCell);
    const [partnerCode, partnerName] = this.label(partnerCell);
    if (AGGREGATE_REPORTERS.has(reporterCode) || AGGREGATE_PARTNER.test(partnerCode)) return;
    const [productCode, productName] = this.label(productCell);
    const key = `${period}|${productCode}|${reporterCode}|${partnerCode}`;
    let line = this.lines.get(key);
    if (!line) {
      const [flowCode, flow] = this.label(flowCell);
      line = {
        time_period: period,
        flow_code: flowCode,
        flow,
        reporter_code: reporterCode,
        reporter_name: reporterName,
        partner_code: partnerCode,
        partner_name: partnerName,
        product_code: productCode,
        product_name: productName,
        VALUE_IN_EUROS: '',
        QUANTITY_IN_100KG: '',
        SUPPLEMENTARY_QUANTITY: '',
      };
      this.lines.set(key, line);
    }
    // "VALUE_IN_EUROS: VALUE_IN_EUROS" → its column
    const [name] = this.label(indicator);
    if (name in line) line[name] = value;
  }
}

async function waitForJob(id: string, rows: Rows): Promise<void> {
  const deadline = Date.now() + ASYNC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await send(`${ASYNC_URL}/status/${id}`);
    const status = [...res.body.toString().matchAll(/<ns1:status>([A-Z_]+)<\/ns1:status>/g)].pop()?.[1] ?? 'UNKNOWN';
    if (status === 'AVAILABLE') {
      const data = await send(`${ASYNC_URL}/data/${id}`);
      if (data.status !== 200) throw new RetryableError(`Eurostat: job ${id} download failed (HTTP ${data.status})`);
      return rows.read(data.body);
    }
    if (status !== 'SUBMITTED' && status !== 'PROCESSING') throw new RetryableError(`Eurostat: job ${id} ended as ${status}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new RetryableError(`Eurostat: job ${id} not ready after ${ASYNC_TIMEOUT_MS / 60_000} minutes`);
}

/** One data query: answered directly, or queued as a job that is polled until ready */
async function query(codes: string[], period: Period, flow: TradeFlow, rows: Rows): Promise<void> {
  const params = new URLSearchParams({
    'c[product]': codes.join(','),
    'c[TIME_PERIOD]': period,
    'c[flow]': FLOW_CODES[flow],
    attributes: 'none',
    measures: 'all',
  });
  const res = await send(`${DATA_URL}?${params}`);
  if (res.status === 200 && !res.type.includes('xml')) return rows.read(res.body);
  // Anything else is a short XML message
  const body = res.body.toString();
  if (res.status === 200) {
    const job = body.match(/<queued><id>([^<]+)<\/id>/)?.[1];
    if (job) return waitForJob(job, rows);
    throw new RetryableError(`Eurostat: unexpected response: ${body.slice(0, 300)}`);
  }
  if (res.status === 413 || body.includes('EXTRACTION_TOO_BIG')) throw new ExtractionTooBig();
  if (body.includes('INVALID_QUERY_DIMENSION_VALUE')) {
    const rejected = [...body.matchAll(/PRODUCT=([0-9A-Z]+)/g)].map((m) => m[1]);
    if (rejected.length) throw new InvalidCodes(rejected);
  }
  throw new Error(`Eurostat: HTTP ${res.status}: ${body.replace(/<[^>]+>/g, ' ').trim().slice(0, 300)}`);
}

/** Like `query`, halving a batch that is too big and dropping codes Eurostat doesn't know */
async function queryAll(codes: string[], period: Period, flow: TradeFlow, rows: Rows): Promise<void> {
  try {
    await query(codes, period, flow, rows);
  } catch (err) {
    if (err instanceof ExtractionTooBig && codes.length > 1) {
      const mid = Math.ceil(codes.length / 2);
      await queryAll(codes.slice(0, mid), period, flow, rows);
      return queryAll(codes.slice(mid), period, flow, rows);
    }
    if (err instanceof InvalidCodes) {
      const remaining = codes.filter((c) => !err.codes.includes(c));
      if (remaining.length === codes.length) throw err;
      console.warn(`⚠️ [EU] ${period} ${flow}: ${err.message}; skipped`);
      if (remaining.length) await queryAll(remaining, period, flow, rows);
      return;
    }
    throw err;
  }
}


const API_SOURCE: CountrySource = {
    name: 'Eurostat Comext: EU trade since 1988 by HS2-4-6 and CN8 (DS-045409)',
    url: 'https://ec.europa.eu/eurostat/databrowser/view/ds-045409/default/table?lang=en',
    endpoint: `${DATA_URL} (SDMX 3.0, CSV)`,
    method:
      `SDMX API. One request per flow, month and batch of up to ${BATCH_SIZE} codes, covering every reporting member state and partner. ` +
      'Large requests are queued by Eurostat and polled until ready; a batch Eurostat finds too big is halved.',
    output:
      'One row per product, EU reporter and partner country, with codes, names and values exactly as Eurostat sends them: ' +
      'period, flow, reporter, partner and product (code and name), VALUE_IN_EUROS, QUANTITY_IN_100KG, SUPPLEMENTARY_QUANTITY. ' +
      'Eurostat totals (EU27, euro area, world, extra/intra-EU) are left out.',
};

/** Eurostat's bulk download, where Comext puts one detailed file per month */
const BULK_FILES = 'https://ec.europa.eu/eurostat/api/dissemination/files/?sort=1';
const BULK_FOLDER = 'comext/COMEXT_DATA/PRODUCTS';

/** Eurostat Comext: every EU member state's trade with every partner (DS-045409), plus links to its monthly bulk files */
export const eu: Country = {
  code: 'EU',
  name: 'European Union',
  source: API_SOURCE,
  bulkDownload: {
    description:
      'Eurostat’s monthly Comext file, straight from Eurostat (nothing is fetched by the extraction service): every EU member state’s trade with every partner, both flows, ' +
      'all products including confidential XX rows, with all 18 columns it publishes (SITC, CPA and BEC codes, trade procedure, supplementary unit, value in national currency, kg). ' +
      'A 7z archive of 25–45 MB (about 400 MB unpacked); open it with 7-Zip. No product or country names.',
    urlTemplate: `${BULK_FILES}&downfile=${encodeURIComponent(`${BULK_FOLDER}/full_v2_`)}{YYYYMM}.7z`,
    listingUrl: `${BULK_FILES}&dir=${encodeURIComponent(BULK_FOLDER)}`,
    source: {
      name: 'Eurostat Comext bulk download: monthly detailed files',
      url: `${BULK_FILES}&dir=${encodeURIComponent(BULK_FOLDER)}`,
      endpoint: `${BULK_FILES}&downfile=${encodeURIComponent(`${BULK_FOLDER}/full_v2_`)}YYYYMM.7z`,
      method: 'Direct links to Eurostat’s files, opened in your browser; the extraction service downloads nothing. A month not published yet shows an error page.',
      output:
        'full_v2_YYYYMM.7z, one CSV of about 5 million rows: REPORTER, PARTNER, TRADE_TYPE, PRODUCT_NC, PRODUCT_SITC, PRODUCT_CPA21, PRODUCT_CPA22, PRODUCT_BEC, PRODUCT_BEC5, ' +
        'PRODUCT_SECTION, FLOW, STAT_PROCEDURE, SUPPL_UNIT, PERIOD, VALUE_EUR, VALUE_NAC, QUANTITY_KG, QUANTITY_SUPPL_UNIT (one row per trade procedure).',
    },
  },
  // Month M is published during month M+2
  lagMonths: 2,
  publishDay: 20,
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint:
    'The EU uses 8-digit CN codes only. An HS subheading the CN doesn’t split is its code plus "00" (293341 → 29334100). ' +
    'A leading zero lost by Excel is restored (1012100 → 01012100).',
  concurrency: 4,

  // 8-digit CN codes only: Eurostat's HS2/4/6 totals look like codes but also hold trade it can't
  // attribute to a CN code, so they don't match the CN8 rows and can't be told apart in a file
  normalizeHsCode: (raw) => {
    const digits = raw.replace(/[\s.]/g, '');
    if (/^\d{8}$/.test(digits)) return digits;
    // Excel drops a leading zero
    if (/^\d{7}$/.test(digits)) return `0${digits}`;
    return null;
  },

  splitQueries: (hsCodes, periods, tradeType) => {
    const queries: FetchQuery[] = [];
    for (const period of periods) {
      for (let i = 0; i < hsCodes.length; i += BATCH_SIZE) queries.push({ hsCodes: hsCodes.slice(i, i + BATCH_SIZE), periods: [period], tradeType });
    }
    return queries;
  },

  async fetchRecords({ hsCodes, periods: [period], tradeType }) {
    const collected = new Rows();
    await queryAll(hsCodes, period, tradeType, collected);
    const rows = collected.records();
    return new Map(rows.length ? [[period, rows]] : []);
  },
};
