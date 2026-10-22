import { Country } from './country.types';
import { Period, TradeFlow, TradeRecord } from '../types';
import { TtlCache } from '../utils/cache';
import { Semaphore } from '../utils/concurrency';
import { BROWSER_UA, RetryableError } from '../utils/http';
import { splitPeriod } from '../utils/period';
import { eachSheetRow } from '../utils/xlsx';

const PORTAL_URL = process.env.ZAF_PORTAL_URL || 'https://tools.sars.gov.za/tradestatsportal/data_download.aspx';
const FIELD = 'ctl00$ContentPlaceHolder1$'; // form field names
const ELEMENT = 'ctl00_ContentPlaceHolder1_'; // element ids
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PAGE_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** One chapter's rows for one flow: month → 8-digit tariff → rows */
type ChapterRows = Map<Period, Map<string, TradeRecord[]>>;

// The portal exports a whole chapter for any set of months of one year, so each
// (flow, year, chapter) is downloaded once per run with every month the run needs, and all
// of that chapter's codes and months are answered from it. Runs go code by code, so only
// the current chapter (per flow and year) is in use at a time; the cap bounds memory.
const chapterCache = new TtlCache<ChapterRows>(2 * 60 * 60 * 1000, 8);
// Each download holds a server-side session for 15–60s; keep the load on SARS modest
const portalSlots = new Semaphore(2);

const decodeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * One visitor session on the ASP.NET WebForms download page. Every choice is a full-page
 * postback carrying the page's __VIEWSTATE plus everything selected so far, exactly like
 * the browser form; the file itself is served from Download.aspx once the query is accepted.
 */
class PortalSession {
  private cookies = new Map<string, string>();
  private viewState: Record<string, string> = {};
  private selections: Record<string, string> = {};
  private html = '';

  public async open(): Promise<void> {
    await this.load();
  }

  /** Ticks `selections` and posts back as `target` (a radio button or dropdown) */
  public async postback(target: string, selections: Record<string, string>): Promise<void> {
    Object.assign(this.selections, selections);
    await this.load({ __EVENTTARGET: target });
  }

  /** The `{ index, label }` options of a checkbox list, e.g. "ddlYears" */
  public options(list: string): { index: number; label: string }[] {
    const re = new RegExp(`<label for="${ELEMENT}${list}_(\\d+)">([^<]*)</label>`, 'g');
    return [...this.html.matchAll(re)].map((m) => ({ index: Number(m[1]), label: decodeHtml(m[2]).trim() }));
  }

  /** Form fields ticking every option of a list */
  public all(list: string): Record<string, string> {
    return Object.fromEntries(this.options(list).map((o) => [`${FIELD}${list}$${o.index}`, 'on']));
  }

  /** Submits the query; resolves to the workbook, or null when SARS has no rows for it */
  public async download(selections: Record<string, string>): Promise<Buffer | null> {
    Object.assign(this.selections, selections);
    await this.load({ __EVENTTARGET: '', [`${FIELD}btnDownload`]: 'Download' }, DOWNLOAD_TIMEOUT_MS);

    const link = this.html.match(/window\.open\('([^']*Download\.aspx[^']*)'/)?.[1];
    if (!link) {
      // Server-side messages come as alert('...'); the page's own script only uses double quotes
      const alert = this.html.match(/alert\('([^']*)'\)/)?.[1];
      if (alert && /no data found/i.test(alert)) return null;
      if (alert) throw new Error(`SARS portal rejected the query: ${alert}`);
      throw new RetryableError('SARS portal: the download was not offered');
    }

    const res = await this.send(new URL(link, PORTAL_URL).toString(), undefined, DOWNLOAD_TIMEOUT_MS);
    const file = Buffer.from(await this.read(() => res.arrayBuffer()));
    // Served as Report.xls, but the content is an .xlsx (zip) workbook
    if (file.subarray(0, 2).toString() !== 'PK') throw new RetryableError('SARS portal: the download was not a workbook');
    return file;
  }

  private async load(extra?: Record<string, string>, timeoutMs = PAGE_TIMEOUT_MS): Promise<void> {
    const form = extra && { ...this.viewState, __EVENTARGUMENT: '', ...this.selections, ...extra };
    const res = await this.send(PORTAL_URL, form, timeoutMs);
    this.html = await this.read(() => res.text());
    this.viewState = {};
    for (const [tag] of this.html.matchAll(/<input type="hidden"[^>]*>/g)) {
      const name = tag.match(/name="([^"]*)"/)?.[1];
      if (name) this.viewState[name] = decodeHtml(tag.match(/value="([^"]*)"/)?.[1] ?? '');
    }
    if (!this.viewState.__VIEWSTATE) throw new RetryableError('SARS portal: unexpected page (no form state)');
  }

  private async send(url: string, form: Record<string, string> | undefined, timeoutMs: number): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: form ? 'POST' : 'GET',
        headers: {
          'User-Agent': BROWSER_UA,
          Referer: PORTAL_URL,
          Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          ...(form && { 'Content-Type': 'application/x-www-form-urlencoded' }),
        },
        body: form && new URLSearchParams(form),
        redirect: 'manual', // a redirect means the session was lost; its cookies must not be dropped either
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      throw new RetryableError(`SARS portal: network error (${err.message})`);
    }
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    if (res.status === 429 || res.status >= 500 || (res.status >= 300 && res.status < 400)) {
      throw new RetryableError(`SARS portal: temporary error HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`SARS portal: HTTP ${res.status} ${res.statusText}`);
    return res;
  }

  private async read<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (err: any) {
      throw new RetryableError(`SARS portal: connection dropped (${err.message})`);
    }
  }
}

/**
 * Downloads one chapter for one flow and the given months of a single year (the portal's
 * months apply to every selected year): every tariff line, partner country and port.
 */
async function downloadChapter(tradeType: TradeFlow, periods: Period[], chapter: string): Promise<ChapterRows> {
  const { year } = splitPeriod(periods[0]);
  const session = new PortalSession();
  await session.open();

  const flow = tradeType === 'EXPORT' ? 'rdbExports' : 'rdbImports';
  await session.postback(`${FIELD}${flow}`, { [`${FIELD}tradeType`]: flow });
  await session.postback(`${FIELD}rdbTariffs`, { [`${FIELD}focusArea`]: 'rdbTariffs' });

  // Year must come before months: its postback is what fills the month list
  const yearOption = session.options('ddlYears').find((o) => o.label === String(year));
  if (!yearOption) return new Map();
  await session.postback(`${FIELD}ddlYears`, { [`${FIELD}ddlYears$${yearOption.index}`]: 'on' });

  // The month list runs ahead of publication; unpublished months simply come back empty
  const wanted = new Set(periods.map((p) => MONTHS[splitPeriod(p).month - 1]));
  const monthFields = Object.fromEntries(
    session
      .options('ddlMonths')
      .filter((o) => wanted.has(o.label))
      .map((o) => [`${FIELD}ddlMonths$${o.index}`, 'on'])
  );
  const chapterOption = session.options('ddlChapters').find((o) => o.label.startsWith(`${chapter} `));
  if (!Object.keys(monthFields).length || !chapterOption) return new Map();
  // The tariff list only loads when exactly one chapter is ticked
  await session.postback(`${FIELD}ddlChapters`, { [`${FIELD}ddlChapters$${chapterOption.index}`]: 'on' });

  const tariffs = session.all('ddlTariffs');
  if (!Object.keys(tariffs).length) return new Map();

  const file = await session.download({
    ...monthFields,
    ...session.all('ddlCountries'),
    ...tariffs,
    [`${FIELD}chkAll`]: 'on',
    ...session.all('chkColumns'),
  });
  return file ? parseWorkbook(file, tradeType, new Set(periods)) : new Map();
}

const COLUMNS = [
  'Tariff', 'TariffAndDescription', 'YearMonth', 'StatisticalQuantity', 'StatisticalUnit', 'CustomsValue',
  'CountryOfOrigin', 'CountryOfOriginName', 'CountryOfDestination', 'CountryOfDestinationName',
  'DistrictOfficeCode', 'DistrictOfficeName', 'TransportCodeDescription', 'WorldRegion',
] as const;

const toNumber = (text: string) => {
  const n = parseFloat(text.replace(/,/g, ''));
  return isNaN(n) ? undefined : n;
};

async function parseWorkbook(file: Buffer, tradeType: TradeFlow, periods: Set<Period>): Promise<ChapterRows> {
  const rows: ChapterRows = new Map();
  let at: Map<string, number> | undefined;

  await eachSheetRow(file, (cells) => {
    if (!at) {
      at = new Map(cells.map((name, i) => [name, i]));
      const missing = COLUMNS.filter((c) => !at!.has(c));
      if (missing.length) throw new Error(`SARS workbook is missing column(s): ${missing.join(', ')}`);
      return;
    }
    const get = (c: (typeof COLUMNS)[number]) => cells[at!.get(c)!] ?? '';
    const yearMonth = get('YearMonth');
    const period = `${yearMonth.slice(0, 4)}-${yearMonth.slice(4, 6)}`;
    if (!periods.has(period)) return;
    const tariff = get('Tariff').replace(/\D/g, '').padStart(8, '0');

    const record: TradeRecord = {
      date: `${period}-01`,
      hsCode: tariff,
      productDescription: get('TariffAndDescription').replace(/^\d+\s*-\s*/, ''),
      tradeType,
      // SARS publishes no trader names
      importer: '',
      exporter: '',
      originCountry: get('CountryOfOriginName'),
      destinationCountry: get('CountryOfDestinationName'),
      quantity: toNumber(get('StatisticalQuantity')),
      unit: get('StatisticalUnit'),
      // Customs value in rand; SARS publishes no USD figure
      valueLocal: toNumber(get('CustomsValue')),
      currency: 'ZAR',
      port: get('DistrictOfficeName'),
      declarationNo: '',
      portCode: get('DistrictOfficeCode'),
      originCountryCode: get('CountryOfOrigin'),
      destinationCountryCode: get('CountryOfDestination'),
      transportMode: get('TransportCodeDescription'),
      worldRegion: get('WorldRegion'),
    };
    let month = rows.get(period);
    if (!month) rows.set(period, (month = new Map()));
    const list = month.get(tariff);
    if (list) list.push(record);
    else month.set(tariff, [record]);
  });
  return rows;
}

/** SARS Trade Statistics portal (tariff line × partner country × port × transport mode) */
export const southAfrica: Country = {
  code: 'ZAF',
  name: 'South Africa',
  // A month is released at the end of the following month
  lagMonths: 2,
  publishDay: 1,
  tradeTypes: ['IMPORT', 'EXPORT'],
  // No per-lookup limit: nearly every lookup is answered from a downloaded chapter, and
  // real portal traffic is already capped by portalSlots
  rateLimitPerMinute: 0,

  // 8-digit tariff lines; shorter headings (4–6 digits) return every line under them
  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{4,8}$/.test(digits) ? digits : null;
  },

  async fetchRecords({ hsCode, period, tradeType, runPeriods }) {
    const chapter = hsCode.slice(0, 2);
    // Every month of this run in the same year, so one download serves all of them
    const year = period.slice(0, 4);
    const months = [...new Set([...runPeriods, period])].filter((p) => p.startsWith(year)).sort();
    const chapterRows = await chapterCache.get(`${tradeType}|${chapter}|${months.join(',')}`, () =>
      portalSlots.run(() => downloadChapter(tradeType, months, chapter))
    );
    const rows = chapterRows.get(period);
    if (!rows) return [];
    if (hsCode.length === 8) return rows.get(hsCode) ?? [];
    return [...rows].filter(([tariff]) => tariff.startsWith(hsCode)).flatMap(([, list]) => list);
  },
};
