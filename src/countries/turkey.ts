import { Country, FetchQuery } from './country.types';
import { Period, TradeFlow, TradeRecord } from '../types';
import { BROWSER_UA, RetryableError, sleep } from '../utils/http';
import { splitPeriod } from '../utils/period';

const HOST = 'https://bi.tuik.gov.tr';
const RELOAD_URI = `${HOST}/extensions/tuik-mashup/index.html`;
/** The dashboard's English general-trade app (from its bundle, extensions/tuik-mashup/assets/index-*.js) */
const APP_ID = process.env.TUR_APP_ID || '6310efbf-deef-43d9-b397-dfcf355ce1fd';
/** IHRITH_FLAG in the app: 1 exports, 2 imports */
const FLOW_FLAG: Record<TradeFlow, number> = { EXPORT: 1, IMPORT: 2 };
/** HS codes per request */
const BATCH_SIZE = 500;
/** The engine returns at most 10,000 cells per call */
const PAGE_CELLS = 10_000;
/** A call takes a few seconds; one taking much longer means the session is stuck */
const CALL_TIMEOUT_MS = 60_000;
/** Tries per page, each on a new session, before the request fails (then the engine retries it) */
const PAGE_ATTEMPTS = 6;
/** Wait before reading a stalled page again, times the try: 10 s, 20 s, 30 s… */
const PAGE_RETRY_MS = 10_000;

/**
 * Fields of each row, codes only (names come from LOOKUPS, which keeps pages wide): code, partner,
 * unit, then the declaration's province, customs office, transport mode, payment method, nature of
 * transaction and invoice currency (dimensions), then the flow's values (measures). The last six
 * split a code and partner into about 5× as many rows (Sep 2026 imports: 79,720 → 406,774).
 * The app's other values aren't per code and partner: ILFAALIYET_* (exports by the exporter's
 * province of activity) are province totals with no code or partner, MEVSIMSEL_* national totals.
 */
const DIMENSIONS = ['ISTPOZ', 'ULKE_KODU', 'OLCU_KODU', 'IL_KODU', 'GUMRUK', 'TASIMA_SEKLI', 'ODEME_SEKLI', 'SOZLESME_KODU', 'DOVIZ_KODU'];
const MEASURE_FIELDS = ['DOLAR', 'EURO', 'TL', 'MIKTAR_1', 'MIKTAR_2'];

/** Output column → field, for the fields that depend only on one dimension */
interface Lookup {
  key: string;
  columns: Record<string, string>;
}

/** Read once per request, for the month and codes selected */
const LOOKUPS: Lookup[] = [
  {
    key: 'ISTPOZ',
    columns: {
      description: 'ISTPOZ_ADI',
      chapter: 'FASIL', chapter_name: 'FASIL_ADI',
      hs4: 'TARIFE4', hs4_name: 'TARIFE4_ADI',
      hs6: 'TARIFE6', hs6_name: 'TARIFE6_ADI',
      hs8: 'TARIFE8', hs8_name: 'TARIFE8_ADI',
      bec: 'BEC', bec_name: 'BEC_ADI',
      bec_broad: 'BEC_1', bec_broad_name: 'BEC_1_ADI',
      sitc_section: 'SITC4_1', sitc_section_name: 'SITC4_1_ADI',
      sitc_division: 'SITC4_2', sitc_division_name: 'SITC4_2_ADI',
      sitc_group: 'SITC4_3', sitc_group_name: 'SITC4_3_ADI',
      sitc_subgroup: 'SITC4_4', sitc_subgroup_name: 'SITC4_4_ADI',
      sitc_item: 'SITC4_5', sitc_item_name: 'SITC4_5_ADI',
      isic_section: 'ISIC4_1', isic_section_name: 'ISIC4_1_ADI',
      isic_division: 'ISIC4_2', isic_division_name: 'ISIC4_2_ADI',
      isic_group: 'ISIC4_3', isic_group_name: 'ISIC4_3_ADI',
      isic_class: 'ISIC4_4', isic_class_name: 'ISIC4_4_ADI',
    },
  },
  // A country is in several economic groups (EU 27, OECD, G-8…): they're joined with "; "
  { key: 'ULKE_KODU', columns: { partner_name: 'ULKE_ADI', partner_region_code: 'ULKE_COGRAFI_GRUBU', partner_region: 'ULKE_COGRAFI_ADI', partner_groups: 'ULKE_EKONOMIK_ADI' } },
  { key: 'OLCU_KODU', columns: { unit: 'OLCU_ADI' } },
  { key: 'IL_KODU', columns: { province: 'IL_ADI' } },
  { key: 'GUMRUK', columns: { customs_office: 'GUMRUK_ADI' } },
  { key: 'TASIMA_SEKLI', columns: { transport_mode: 'TASIMA_SEKLI_ADI' } },
  { key: 'ODEME_SEKLI', columns: { payment_method: 'ODEME_SEKLI_ADI' } },
  { key: 'SOZLESME_KODU', columns: { transaction_nature: 'SOZLESME_ADI' } },
  { key: 'DOVIZ_KODU', columns: { invoice_currency: 'DOVIZ_ADI' } },
  // The month's release date
  { key: 'AY', columns: { published: 'YAYIN_TARIHI' } },
];

/** Key → column → value, for each lookup's key field */
type Names = Map<string, Map<string, Record<string, string>>>;

/** The code as TÜİK stores it: text, without the leading zero (010121000000 → "10121000000") */
const tuikCode = (code: string) => code.replace(/^0+/, '');
/** Back to 12 digits */
const code12 = (text: string) => (/^\d+$/.test(text) ? text.padStart(12, '0') : text);

interface Cell {
  qText?: string;
  qNum?: number | string;
  qIsNull?: boolean;
}

/** A dimension cell's text; empty when null */
const text = (cell: Cell) => (cell.qIsNull ? '' : (cell.qText ?? ''));

/**
 * One anonymous session on TÜİK's Qlik engine, the way the dashboard page opens one: a session
 * cookie, a CSRF token for it, then JSON-RPC over a WebSocket. Failures and stalls throw
 * RetryableError; aborting `signal` closes the session.
 */
export class QlikSession {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  private closedWith: unknown;

  private constructor(private readonly signal?: AbortSignal) {}

  /** A session with the app open; returns the session and the app's handle */
  static async open(signal?: AbortSignal): Promise<{ session: QlikSession; doc: number }> {
    const session = new QlikSession(signal);
    try {
      await session.connect();
      const doc = (await session.call(-1, 'OpenDoc', [APP_ID])).qReturn.qHandle as number;
      return { session, doc };
    } catch (err) {
      session.close();
      throw err;
    }
  }

  private async connect(): Promise<void> {
    const get = async (path: string, headers: Record<string, string> = {}) => {
      try {
        const res = await fetch(`${HOST}${path}`, { headers: { 'User-Agent': BROWSER_UA, Referer: RELOAD_URI, ...headers }, signal: this.signal });
        if (!res.ok) throw new RetryableError(`TÜİK: HTTP ${res.status} on ${path}`);
        return res;
      } catch (err: any) {
        if (this.signal?.aborted) throw this.signal.reason;
        throw err instanceof RetryableError ? err : new RetryableError(`TÜİK: network error (${err.message})`);
      }
    };
    const cookie = (await get('/resources/autogenerated/product-info.json')).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    if (!cookie.includes('X-Qlik-Session-Anon=')) throw new RetryableError('TÜİK did not give an anonymous session cookie');
    const token = (await get('/qps/csrftoken', { Cookie: cookie })).headers.get('qlik-csrf-token');
    if (!token) throw new RetryableError('TÜİK did not give a CSRF token');

    // Without reloadUri the server answers HTTP 200 instead of opening the WebSocket
    const url = `wss://bi.tuik.gov.tr/app/${APP_ID}?` + new URLSearchParams({ reloadUri: RELOAD_URI, 'qlik-csrf-token': token });
    // Node's WebSocket (undici) accepts headers, which browsers' doesn't
    this.ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: HOST, 'User-Agent': BROWSER_UA } } as any);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RetryableError('TÜİK: the engine did not open a session within 30s')), 30_000);
      this.ws.onopen = () => (clearTimeout(timer), resolve());
      this.ws.onerror = () => (clearTimeout(timer), reject(new RetryableError('TÜİK: could not open a session on the engine')));
    });
    this.ws.onmessage = (event) => this.receive(String(event.data));
    this.ws.onclose = () => this.fail(new RetryableError('TÜİK: the engine closed the session'));
    this.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  private onAbort = () => this.close();

  private receive(message: string): void {
    const data = JSON.parse(message);
    const call = this.pending.get(data.id);
    if (!call) return;
    this.pending.delete(data.id);
    clearTimeout(call.timer);
    if (data.error) call.reject(new Error(`TÜİK engine: ${data.error.message} ${data.error.parameter ?? ''}`.trim()));
    else call.resolve(data.result);
  }

  private fail(err: unknown): void {
    this.closedWith ??= this.signal?.aborted ? this.signal.reason : err;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(this.closedWith);
    }
    this.pending.clear();
  }

  call(handle: number, method: string, params: unknown = []): Promise<any> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RetryableError(`TÜİK: ${method} got no answer within ${CALL_TIMEOUT_MS / 1000}s`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, handle, method, params }));
    });
  }

  close(): void {
    this.signal?.removeEventListener('abort', this.onAbort);
    this.fail(new RetryableError('TÜİK: the session was closed'));
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
  }

  /** Selects values of a field; numbers for numeric fields (YIL, AY), text for the rest (ISTPOZ is text) */
  async select(doc: number, field: string, values: (string | number)[]): Promise<void> {
    const handle = (await this.call(doc, 'GetField', [field])).qReturn.qHandle;
    const list = values.map((v) => (typeof v === 'number' ? { qText: String(v), qIsNumeric: true, qNumber: v } : { qText: v }));
    await this.call(handle, 'SelectValues', [list, false, false]);
  }

  /** Field → how many of its values are selected. SelectValues answers true even when nothing matched, so this is the check. */
  async selections(doc: number): Promise<Map<string, { count: number; text: string }>> {
    const obj = await this.call(doc, 'CreateSessionObject', [{ qInfo: { qType: 'selections' }, qSelectionObjectDef: {} }]);
    const layout = await this.call(obj.qReturn.qHandle, 'GetLayout');
    return new Map(
      (layout.qLayout.qSelectionObject.qSelections as any[]).map((s) => [s.qField as string, { count: s.qSelectedCount as number, text: s.qSelected as string }])
    );
  }

  /**
   * Builds a straight table and returns its handle and row count. Rows are sorted by the dimensions,
   * so another session's table has the same rows on the same page and reading can carry on there.
   * Rows without the first dimension are left out; nulls in the others are kept (a row without,
   * say, a currency still has its values).
   */
  async createTable(doc: number, dimensions: string[], measures: string[]): Promise<Table> {
    const obj = await this.call(doc, 'CreateSessionObject', [
      {
        qInfo: { qType: 'table' },
        qHyperCubeDef: {
          qDimensions: dimensions.map((d, i) => ({ qDef: { qFieldDefs: [d], qSortCriterias: [{ qSortByNumeric: 1, qSortByAscii: 1 }] }, qNullSuppression: i === 0 })),
          qMeasures: measures.map((m) => ({ qDef: { qDef: m } })),
          qInterColumnSortOrder: dimensions.map((_, i) => i),
          qMode: 'S',
          qSuppressZero: true,
          qInitialDataFetch: [],
        },
      },
    ]);
    const handle = obj.qReturn.qHandle;
    const rows: number = (await this.call(handle, 'GetLayout')).qLayout.qHyperCube.qSize.qcy;
    const width = dimensions.length + measures.length;
    return { handle, rows, width, pageRows: Math.floor(PAGE_CELLS / width) };
  }

  /** Page `page` (from 0) of a table; a short page throws RetryableError */
  async readPage(table: Table, page: number): Promise<Cell[][]> {
    const top = page * table.pageRows;
    const height = Math.min(table.pageRows, table.rows - top);
    const pages = (await this.call(table.handle, 'GetHyperCubeData', ['/qHyperCubeDef', [{ qTop: top, qLeft: 0, qWidth: table.width, qHeight: height }]])).qDataPages;
    const matrix: Cell[][] = pages[0]?.qMatrix ?? [];
    if (matrix.length !== height) throw new RetryableError(`TÜİK: page ${page + 1} came back with ${matrix.length} of ${height} rows`);
    return matrix;
  }

  /** Every row of a table, read on this session (no carrying on elsewhere if it stalls) */
  async table(doc: number, dimensions: string[], measures: string[]): Promise<Cell[][]> {
    const table = await this.createTable(doc, dimensions, measures);
    const out: Cell[][] = [];
    for (let page = 0; page * table.pageRows < table.rows; page++) out.push(...(await this.readPage(table, page)));
    return out;
  }
}

interface Table {
  handle: number;
  rows: number;
  width: number;
  pageRows: number;
}

/**
 * A new session with the request's month and codes selected and its table built, or null when
 * there's nothing to read. A value that matches nothing is skipped without an error, and a skipped
 * selection widens the table instead of narrowing it, so the selections are read back first (tested Nov 2026):
 * - a month not published yet replaces the year (2026-10 left only AY = 10 selected: every year's October)
 * - codes without trade that month aren't selected; with none, the table was the whole month
 */
async function openTable(query: FetchQuery, signal: AbortSignal): Promise<{ session: QlikSession; doc: number; table: Table } | null> {
  const { year, month } = splitPeriod(query.periods[0]);
  const { session, doc } = await QlikSession.open(signal);
  try {
    await session.select(doc, 'YIL', [year]);
    await session.select(doc, 'AY', [month]);
    await session.select(doc, 'ISTPOZ', query.hsCodes.map(tuikCode));
    const selected = await session.selections(doc);
    const holds = selected.get('YIL')?.text === String(year) && selected.get('AY')?.text === String(month) && selected.get('ISTPOZ')?.count;
    if (!holds) {
      session.close();
      return null;
    }
    const flag = FLOW_FLAG[query.tradeType];
    const table = await session.createTable(doc, DIMENSIONS, MEASURE_FIELDS.map((f) => `Sum({< IHRITH_FLAG = {${flag}} >} ${f})`));
    return { session, doc, table };
  } catch (err) {
    session.close();
    throw err;
  }
}

/**
 * Each lookup's columns by key, for what's selected. A key with several values for a column (a
 * country's economic groups) gets them joined with "; ".
 */
async function readNames(session: QlikSession, doc: number): Promise<Names> {
  const names: Names = new Map();
  for (const { key, columns } of LOOKUPS) {
    const entries = Object.entries(columns);
    const rows = await session.table(doc, [key, ...entries.map(([, field]) => field)], ['Count(1)']);
    const values = new Map<string, Map<string, Set<string>>>();
    for (const [keyCell, ...cells] of rows) {
      const byColumn = values.get(text(keyCell)) ?? new Map(entries.map(([column]) => [column, new Set<string>()]));
      values.set(text(keyCell), byColumn);
      entries.forEach(([column], i) => text(cells[i]) && byColumn.get(column)!.add(text(cells[i])));
    }
    names.set(key, new Map([...values].map(([k, byColumn]) => [k, Object.fromEntries([...byColumn].map(([column, set]) => [column, [...set].join('; ')]))])));
  }
  return names;
}

/** A lookup's columns for a key, empty when it has none */
function namesFor(names: Names, key: string, cell: Cell | string): Record<string, string> {
  const columns = LOOKUPS.find((l) => l.key === key)!.columns;
  return names.get(key)?.get(typeof cell === 'string' ? cell : text(cell)) ?? Object.fromEntries(Object.keys(columns).map((c) => [c, '']));
}

/** A measure cell's number, or its text when it has none */
const value = (cell: Cell) => (typeof cell.qNum === 'number' ? cell.qNum : (cell.qText ?? ''));

/** Requests per flow, month and batch of up to BATCH_SIZE codes */
function splitQueries(hsCodes: string[], periods: Period[], tradeType: TradeFlow): FetchQuery[] {
  const queries: FetchQuery[] = [];
  for (const period of periods) {
    for (let i = 0; i < hsCodes.length; i += BATCH_SIZE) queries.push({ hsCodes: hsCodes.slice(i, i + BATCH_SIZE), periods: [period], tradeType });
  }
  return queries;
}

/** TÜİK foreign trade statistics (general trade system), from its public dashboard */
export const turkey: Country = {
  code: 'TUR',
  name: 'Turkey',
  source: {
    name: 'TÜİK (Turkish Statistical Institute): Foreign Trade by Countries and HS Codes',
    url: 'https://bi.tuik.gov.tr/extensions/tuik-mashup/index.html?report_type=2',
    endpoint: `wss://bi.tuik.gov.tr/app/${APP_ID} (the dashboard's Qlik Sense engine, general trade system)`,
    method:
      'No download API: the service opens an anonymous session on the dashboard’s Qlik engine, as the page does ' +
      '(session cookie, CSRF token, WebSocket), selects the year, month and HS codes, and reads a table in pages. ' +
      `One request per flow, month and batch of up to ${BATCH_SIZE} HS codes.`,
    output:
      'One row per record in TÜİK’s data: 12-digit GTİP code, partner country, province, customs office, transport ' +
      'mode, payment method, nature of transaction and invoice currency, each with its code and name; value in USD, ' +
      'EUR and TRY, quantity 1 (kg), quantity 2 and the unit (e.g. KG/ADET); the Turkish description and the code’s ' +
      'chapter, HS4/6/8, BEC, SITC Rev.4 and ISIC Rev.4 classes; the partner’s region and economic groups; and the ' +
      'month’s release date. Rows without trade are left out.',
  },
  // September 2026 appeared in the app on 3 November 2026
  lagMonths: 2,
  publishDay: 3,
  startPeriod: '2013-01',
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint: 'Turkey uses 12-digit GTİP codes (11 digits are read as 12 with the leading zero Excel drops).',
  // The engine stalls under load; more sessions read fewer rows a second, not more
  concurrency: 2,
  // A stalled engine takes a while to recover, so a failed batch waits 10 s, 20 s, 40 s
  retryDelayMs: 10_000,

  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{11,12}$/.test(digits) ? digits.padStart(12, '0') : null;
  },

  splitQueries,

  /**
   * Reads the table page by page. A page that stalls is read again on a new session, carrying on
   * from that page (the engine's retries would start the batch over); after PAGE_ATTEMPTS tries the
   * request fails and the engine retries it.
   */
  async fetchRecords(query, signal, context) {
    const { periods: [period], tradeType } = query;
    let open = await openTable(query, signal);
    if (!open) return new Map();
    const { rows: total, pageRows } = open.table;
    const pageCount = Math.ceil(total / pageRows);
    const rows: Cell[][] = [];
    let tries = 0;
    let names: Names;
    try {
      names = await readNames(open.session, open.doc);
      while (rows.length < total) {
        const page = rows.length / pageRows;
        try {
          open ??= await openTable(query, signal);
          if (!open) throw new RetryableError('TÜİK: a new session no longer had the month and codes selected');
          if (open.table.rows !== total) throw new RetryableError(`TÜİK: a new session has ${open.table.rows} rows, the first had ${total}`);
          rows.push(...(await open.session.readPage(open.table, page)));
          tries = 0;
        } catch (err: any) {
          if (!(err instanceof RetryableError) || signal.aborted || ++tries >= PAGE_ATTEMPTS) throw err;
          const wait = PAGE_RETRY_MS * tries;
          context.log?.('warn', `page ${page + 1}/${pageCount} again on a new session in ${wait / 1000}s (try ${tries + 1}/${PAGE_ATTEMPTS}): ${err.message}`);
          open?.session.close();
          open = null;
          await sleep(wait, signal);
        }
      }
    } finally {
      open?.session.close();
    }

    const { month } = splitPeriod(period);
    const { published } = namesFor(names, 'AY', String(month));
    const records: TradeRecord[] = rows.map(([code, partner, unit, province, customs, transport, payment, transaction, currency, usd, eur, tl, quantity1, quantity2]) => {
      const { description, ...classes } = namesFor(names, 'ISTPOZ', code);
      return {
        trade_flow: tradeType,
        period,
        hs_code: code12(text(code)),
        description,
        partner_code: text(partner),
        ...namesFor(names, 'ULKE_KODU', partner),
        province_code: text(province),
        ...namesFor(names, 'IL_KODU', province),
        customs_office_code: text(customs),
        ...namesFor(names, 'GUMRUK', customs),
        transport_mode_code: text(transport),
        ...namesFor(names, 'TASIMA_SEKLI', transport),
        payment_method_code: text(payment),
        ...namesFor(names, 'ODEME_SEKLI', payment),
        transaction_nature_code: text(transaction),
        ...namesFor(names, 'SOZLESME_KODU', transaction),
        invoice_currency_code: text(currency),
        ...namesFor(names, 'DOVIZ_KODU', currency),
        value_usd: value(usd),
        value_eur: value(eur),
        value_try: value(tl),
        quantity1_kg: value(quantity1),
        quantity2: value(quantity2),
        unit_code: text(unit),
        ...namesFor(names, 'OLCU_KODU', unit),
        ...classes,
        published,
      };
    });
    return new Map(records.length ? [[period, records]] : []);
  },
};
