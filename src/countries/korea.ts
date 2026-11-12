import { Country, FetchQuery } from './country.types';
import { Period, TradeFlow, TradeRecord } from '../types';
import { BROWSER_UA, getJson } from '../utils/http';
import { splitPeriod } from '../utils/period';

const SITE = process.env.KOR_SITE || 'https://tradedata.go.kr';
const ENDPOINT = `${SITE}/cts/hmpg/retrieveTrade.do`;
/** The 수출입 실적 screen's "품목별 국가별" (item by country) table */
const TRADE_KIND = 'ETS_MNK_1020000E';
/** Rows per page; the site serves up to 100,000 but a page that size takes minutes */
const PAGE_SIZE = 20_000;
/** HS codes per request by code length: a chapter-year alone can be ~190,000 rows */
const BATCH_SIZE: Record<number, number> = { 2: 1, 4: 5, 6: 20, 10: 50 };
const FIELDS: Record<TradeFlow, { weight: string; value: string }> = {
  IMPORT: { weight: 'impTtwg', value: 'impUsdAmt' },
  EXPORT: { weight: 'expTtwg', value: 'expUsdAmt' },
};

interface Row {
  priodTitle: string;
  hsSgn: string;
  cntyCd: string;
  cntyNm: string;
  /** Filled only when 10-digit codes are requested (hsSgnWhrCol HS10_SGN) */
  korePrlstNm?: string;
  [field: string]: unknown;
}

/** "  11,913,616" → "11913616" */
const number = (v: unknown) => String(v ?? '').replace(/[,\s]/g, '');

/** Requests per year and batch of codes of one length (the site filters on one HS level at a time) */
function splitQueries(hsCodes: string[], periods: Period[], tradeType: TradeFlow): FetchQuery[] {
  const batches: string[][] = [];
  for (const length of [2, 4, 6, 10]) {
    const codes = hsCodes.filter((c) => c.length === length);
    for (let i = 0; i < codes.length; i += BATCH_SIZE[length]) batches.push(codes.slice(i, i + BATCH_SIZE[length]));
  }
  const years = new Map<number, Period[]>();
  for (const p of periods) years.set(splitPeriod(p).year, [...(years.get(splitPeriod(p).year) ?? []), p]);
  return [...years.values()].flatMap((yearPeriods) => batches.map((codes) => ({ hsCodes: codes, periods: yearPeriods, tradeType })));
}

/** One page of the table, as the site's own search sends it */
async function readPage(hsCodes: string[], from: Period, to: Period, page: number, signal: AbortSignal) {
  const level = `HS${hsCodes[0].length}_SGN`;
  const body = await getJson<{ count?: number; searchresult?: string; items?: Row[]; message?: string }>(ENDPOINT, {
    source: 'KCS tradedata',
    signal,
    timeoutMs: 300_000,
    headers: { 'User-Agent': BROWSER_UA, 'X-Requested-With': 'XMLHttpRequest', Referer: `${SITE}/cts/index.do` },
    form: {
      tradeKind: TRADE_KIND,
      priodKind: 'MON',
      priodFr: from.replace('-', ''),
      priodTo: to.replace('-', ''),
      // Acceptance date (the site's default); weights in kg rather than tonnes
      statsBase: 'acptDd',
      ttwgTpcd: '1',
      selectPaging: String(page),
      showPagingLine: String(PAGE_SIZE),
      sortColumn: '',
      sortOrder: '',
      // Every partner country
      cntyNm: '',
      hsSgn: hsCodes.join(','),
      hsSgnWhrCol: level,
      // Rows at 10 digits, whatever level was asked for
      hsSgnGrpCol: 'HS10_SGN',
      subHsSgn: 'Y',
    },
  });
  if (body.searchresult !== 'OK') throw new Error(`KCS tradedata: ${body.message ?? 'unexpected response'}`);
  return { count: body.count ?? 0, items: body.items ?? [] };
}

/** Korea Customs Service trade statistics site (tradedata.go.kr), 수출입 실적 → 품목별 국가별 */
export const korea: Country = {
  code: 'KOR',
  name: 'South Korea',
  source: {
    name: 'Korea Customs Service trade statistics (tradedata.go.kr)',
    url: `${SITE}/cts/index.do`,
    endpoint: `${ENDPOINT} (수출입 실적 → 품목별 국가별)`,
    method:
      'The site’s own table search, no key needed. One request per flow, year and batch of HS codes of one length ' +
      `returns every partner country and month, read in pages of ${PAGE_SIZE.toLocaleString('en')} rows.`,
    output:
      'One row per 10-digit HS code, partner country and month: net weight in kg and value in thousand USD ' +
      '(imports CIF, exports FOB, as the site rounds them), with the partner’s ISO code and Korean name. The Korean item name is only given when 10-digit codes are requested. ' +
      'Rows without trade in the flow are left out.',
  },
  lagMonths: 1,
  publishDay: 15,
  startPeriod: '1995-01',
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint:
    'HS codes of 2, 4, 6 or 10 digits (HSK); every 10-digit code under them is returned, and 9 digits are read as 10 with the leading zero Excel drops. Data from January 1995.',
  rateLimitPerMinute: 30,
  concurrency: 2,

  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    // An odd length is a code whose leading zero Excel dropped (chapters 01–09): 9 digits → 10
    const code = digits.length % 2 ? `0${digits}` : digits;
    return code.length in BATCH_SIZE ? code : null;
  },

  splitQueries,

  async fetchRecords({ hsCodes, periods, tradeType }, signal, context) {
    const { weight, value } = FIELDS[tradeType];
    const sorted = [...periods].sort();
    const rows: Row[] = [];
    for (let page = 1; ; page++) {
      const { count, items } = await readPage(hsCodes, sorted[0], sorted[sorted.length - 1], page, signal);
      rows.push(...items);
      if (rows.length >= count || items.length < PAGE_SIZE) break;
      context.log?.('info', `page ${page + 1} of ${Math.ceil(count / PAGE_SIZE)}`);
    }

    const out = new Map<Period, TradeRecord[]>();
    for (const row of rows) {
      // "2025.12"; the first page also has a "총계" (total) row
      const m = row.priodTitle?.trim().match(/^(\d{4})\.(\d{2})$/);
      if (!m) continue;
      const period = `${m[1]}-${m[2]}`;
      const kg = number(row[weight]);
      const usd = number(row[value]);
      if (!periods.includes(period) || (!(Number(kg) > 0) && !(Number(usd) > 0))) continue;
      const list = out.get(period) ?? [];
      out.set(period, list);
      list.push({
        trade_flow: tradeType,
        hs_code: row.hsSgn.trim(),
        description_kor: row.korePrlstNm?.trim() ?? '',
        country_code: row.cntyCd?.trim() ?? '',
        country_name_kor: row.cntyNm?.trim() ?? '',
        year: Number(m[1]),
        month: Number(m[2]),
        net_weight_kg: kg,
        value_1000_usd: usd,
      });
    }
    for (const list of out.values()) list.sort((a, b) => String(a.hs_code).localeCompare(String(b.hs_code)) || String(a.country_code).localeCompare(String(b.country_code)));
    return out;
  },
};
