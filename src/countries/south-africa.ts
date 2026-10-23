import { Country } from './country.types';
import { Period, TradeFlow, TradeRecord } from '../types';
import { BROWSER_UA, RetryableError } from '../utils/http';
import { splitPeriod } from '../utils/period';
import { eachSheetRow } from '../utils/xlsx';

const PORTAL_URL = process.env.ZAF_PORTAL_URL || 'https://tools.sars.gov.za/tradestatsportal/data_download.aspx';
const FIELD = 'ctl00$ContentPlaceHolder1$';
const ELEMENT = 'ctl00_ContentPlaceHolder1_';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PAGE_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;

const decodeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * One visitor session on the ASP.NET WebForms download page. Every choice is a postback
 * carrying the page's __VIEWSTATE plus everything selected so far, like the browser form.
 */
class PortalSession {
  private cookies = new Map<string, string>();
  private viewState: Record<string, string> = {};
  private selections: Record<string, string> = {};
  private html = '';

  public open(): Promise<void> {
    return this.load();
  }

  /** Ticks `selections` and posts back as `target` */
  public async postback(target: string, selections: Record<string, string>): Promise<void> {
    Object.assign(this.selections, selections);
    await this.load({ __EVENTTARGET: target });
  }

  /** The `{ index, label }` options of a checkbox list, e.g. "ddlYears" */
  public options(list: string): { index: number; label: string }[] {
    const re = new RegExp(`<label for="${ELEMENT}${list}_(\\d+)">([^<]*)</label>`, 'g');
    return [...this.html.matchAll(re)].map((m) => ({ index: Number(m[1]), label: decodeHtml(m[2]).trim() }));
  }

  /** Form fields ticking the options of a list whose label passes `pick` (all by default) */
  public tick(list: string, pick: (label: string) => boolean = () => true): Record<string, string> {
    return Object.fromEntries(this.options(list).filter((o) => pick(o.label)).map((o) => [`${FIELD}${list}$${o.index}`, 'on']));
  }

  /** Submits the query; resolves to the workbook, or null when SARS has no rows for it */
  public async download(selections: Record<string, string>): Promise<Buffer | null> {
    Object.assign(this.selections, selections);
    await this.load({ __EVENTTARGET: '', [`${FIELD}btnDownload`]: 'Download' }, DOWNLOAD_TIMEOUT_MS);

    const link = this.html.match(/window\.open\('([^']*Download\.aspx[^']*)'/)?.[1];
    if (!link) {
      const alert = this.html.match(/alert\('([^']*)'\)/)?.[1];
      if (alert && /no data found/i.test(alert)) return null;
      if (alert) throw new Error(`SARS portal rejected the query: ${alert}`);
      throw new RetryableError('SARS portal: the download was not offered');
    }

    const res = await this.send(new URL(link, PORTAL_URL).toString(), undefined, DOWNLOAD_TIMEOUT_MS);
    const file = Buffer.from(await this.read(() => res.arrayBuffer()));
    // Served as Report.xls, but it is an .xlsx (zip) workbook
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
        // A redirect means the session was lost
        redirect: 'manual',
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
 * Downloads one month of the given chapters for one flow (every tariff line, partner and port)
 * and keeps the rows whose tariff passes `wanted`, exactly as SARS delivers them.
 */
async function download(tradeType: TradeFlow, period: Period, chapters: string[], wanted: (tariff: string) => boolean): Promise<TradeRecord[]> {
  const { year, month } = splitPeriod(period);
  const session = new PortalSession();
  await session.open();

  const flow = tradeType === 'EXPORT' ? 'rdbExports' : 'rdbImports';
  await session.postback(`${FIELD}${flow}`, { [`${FIELD}tradeType`]: flow });
  await session.postback(`${FIELD}rdbTariffs`, { [`${FIELD}focusArea`]: 'rdbTariffs' });
  // The year comes first: its postback fills the month list
  const yearFields = session.tick('ddlYears', (label) => label === String(year));
  if (!Object.keys(yearFields).length) return [];
  await session.postback(`${FIELD}ddlYears`, yearFields);

  // The month list runs ahead of publication; unpublished months come back empty
  const monthFields = session.tick('ddlMonths', (label) => label === MONTHS[month - 1]);
  const chapterFields = session.tick('ddlChapters', (label) => chapters.includes(label.slice(0, 2)));
  if (!Object.keys(monthFields).length || !Object.keys(chapterFields).length) return [];
  await session.postback(`${FIELD}ddlChapters`, chapterFields);

  // With one chapter the portal wants its tariffs ticked; with several it takes them all
  const tariffFields = Object.keys(chapterFields).length === 1 ? session.tick('ddlTariffs') : {};
  const file = await session.download({
    ...monthFields,
    ...session.tick('ddlCountries'),
    ...tariffFields,
    [`${FIELD}chkAll`]: 'on',
    ...session.tick('chkColumns'),
  });
  return file ? parseWorkbook(file, wanted) : [];
}

async function parseWorkbook(file: Buffer, wanted: (tariff: string) => boolean): Promise<TradeRecord[]> {
  const rows: TradeRecord[] = [];
  let header: string[] | undefined;
  let tariffAt = -1;

  await eachSheetRow(file, (cells) => {
    if (!header) {
      header = cells;
      tariffAt = header.indexOf('Tariff');
      if (tariffAt < 0) throw new Error('SARS workbook has no Tariff column');
      return;
    }
    if (!wanted((cells[tariffAt] ?? '').replace(/D/g, '').padStart(8, '0'))) return;
    const record: TradeRecord = {};
    header.forEach((name, i) => (record[name] = cells[i] ?? ''));
    rows.push(record);
  });
  return rows;
}

/** SARS Trade Statistics portal (tariff line × partner country × port × transport mode) */
export const southAfrica: Country = {
  code: 'ZAF',
  name: 'South Africa',
  source: {
    name: 'SARS Trade Statistics portal',
    url: PORTAL_URL,
    endpoint: `${PORTAL_URL} (Tariffs focus area) → Download.aspx`,
    method: 'Fills in the portal download form over HTTP (no browser). One download per flow and month covers every chapter the HS codes are in.',
    output: 'The SARS file exactly as delivered: all 21 columns (office, origin, destination, tariff, unit, transport, quantity, customs value in rand, region…), unchanged.',
  },
  // A month is released at the end of the following month
  lagMonths: 2,
  publishDay: 1,
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint: 'South Africa uses 8-digit tariff lines; 4 or 6 digits return every line under that heading.',
  rateLimitPerMinute: 0,
  // A whole month of every chapter takes about 40s; several months at once can stall the portal
  concurrency: 2,

  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{4,8}$/.test(digits) ? digits : null;
  },

  splitQueries: (hsCodes, periods, tradeType) => periods.map((period) => ({ hsCodes, periods: [period], tradeType })),

  async fetchRecords({ hsCodes, periods: [period], tradeType }) {
    const chapters = [...new Set(hsCodes.map((c) => c.slice(0, 2)))];
    // 8-digit codes match a tariff exactly; shorter ones match every tariff under them
    const exact = new Set(hsCodes.filter((c) => c.length === 8));
    const prefixes = hsCodes.filter((c) => c.length < 8);
    const rows = await download(tradeType, period, chapters, (t) => exact.has(t) || prefixes.some((p) => t.startsWith(p)));
    return new Map(rows.length ? [[period, rows]] : []);
  },
};
