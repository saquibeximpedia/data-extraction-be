import { Country, SourceFile } from './country.types';
import { Period, TradeFlow } from '../types';
import { BROWSER_UA, getJson, withRetry } from '../utils/http';


const PORTAL = 'https://portal.kgd.gov.kz';
const PAGE_URL = `${PORTAL}/en/pages/statistika/stats-external`;
/** The open API behind the page's document table (no sign-in) */
const INDEX = `${PORTAL}/services/isnaportal/open-api/international-trade-index`;
const DOWNLOAD = `${INDEX}/download/`;
/** The API can't filter and returns at most 1,000 documents a page (38,211 in Nov 2026, so 39 pages) */
const PAGE_SIZE = 1000;
const PARALLEL_PAGES = 5;
/** The document list is read once per this long */
const CATALOG_MS = 30 * 60 * 1000;

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/**
 * The national HS10 product × partner file for a single month, e.g.
 * 'Экспорт и импорт Республики Казахстан в разрезе "товар-страна" по 10 знакам ТН ВЭД за сентябрь 2026 год'.
 * Cumulative files ("за январь-сентябрь 2026 год") have a hyphen between months, so they don't match.
 */
const MONTH_FILE = /Республики Казахстан в разрезе .товар-страна. по 10 знакам ТН ВЭД за ([а-яё]+) (\d{4}) год/i;

interface Doc {
  id: number;
  nameRu: string;
  metaDocument: { fileUid: string; fileName: string } | null;
}

interface IndexPage {
  content: Doc[];
  totalPages: number;
}

let catalog: { at: number; files: Promise<Map<Period, SourceFile>> } | null = null;

const page = (n: number, signal: AbortSignal) =>
  withRetry(
    () =>
      getJson<IndexPage>(`${INDEX}?page=${n}&size=${PAGE_SIZE}&sort=id,asc`, {
        source: 'portal.kgd.gov.kz',
        headers: { 'User-Agent': BROWSER_UA },
        signal,
        timeoutMs: 60_000,
      }),
    3,
    2000,
    signal
  );

/** Every month's file, read from the whole document list (each page sorted by id, so pages don't overlap) */
async function readCatalog(signal: AbortSignal): Promise<Map<Period, SourceFile>> {
  const first = await page(0, signal);
  const docs = [...first.content];
  const rest = Array.from({ length: first.totalPages - 1 }, (_, i) => i + 1);
  for (let i = 0; i < rest.length; i += PARALLEL_PAGES) {
    const pages = await Promise.all(rest.slice(i, i + PARALLEL_PAGES).map((n) => page(n, signal)));
    for (const p of pages) docs.push(...p.content);
  }
  const files = new Map<Period, SourceFile>();
  // Oldest first, so a file published again later (a higher id) replaces the earlier one
  for (const doc of docs.sort((a, b) => a.id - b.id)) {
    const match = MONTH_FILE.exec(doc.nameRu);
    const month = match ? MONTHS.indexOf(match[1].toLowerCase()) + 1 : 0;
    if (!month || !doc.metaDocument?.fileUid) continue;
    const period = `${match![2]}-${String(month).padStart(2, '0')}` as Period;
    // File names are case-sensitive (ts_10z_01_04.zip, TS_10z_09_26.zip), so the link uses fileUid as listed
    files.set(period, { name: doc.metaDocument.fileName || doc.metaDocument.fileUid, url: DOWNLOAD + encodeURIComponent(doc.metaDocument.fileUid) });
  }
  return files;
}

function monthFiles(signal: AbortSignal): Promise<Map<Period, SourceFile>> {
  if (!catalog || Date.now() - catalog.at > CATALOG_MS) {
    const files = readCatalog(signal);
    catalog = { at: Date.now(), files };
    // A failed read is tried again by the next request, not kept
    files.catch(() => (catalog = null));
  }
  return catalog.files;
}

/**
 * The month's file. One file holds both exports and imports, so both flows list the same file.
 */
async function list(period: Period, _flow: TradeFlow, signal: AbortSignal): Promise<SourceFile[]> {
  const file = (await monthFiles(signal)).get(period);
  return file ? [file] : [];
}

/** State Revenue Committee (KGD), Ministry of Finance: customs foreign-trade statistics, one HS10 × partner workbook per month, downloaded by the user's browser */
export const kazakhstan: Country = {
  code: 'KAZ',
  name: 'Kazakhstan',
  source: {
    name: 'State Revenue Committee (KGD), Ministry of Finance of Kazakhstan · Foreign trade statistics',
    url: PAGE_URL,
    endpoint: `${INDEX}?page&size=1000&sort=id,asc → the month's “товар-страна по 10 знакам” document → ${DOWNLOAD}{fileUid}`,
    method:
      'Direct download: the service only looks up the month’s file in KGD’s document list; your browser downloads it straight from portal.kgd.gov.kz to your device, ' +
      'as published (a ZIP holding one Excel workbook). Nothing is extracted, saved on the server or stored in the database.',
    output:
      'One workbook per month: exports and imports of the Republic of Kazakhstan by 10-digit EAEU TN VED code and partner country (“товар-страна”). Columns: code, ' +
      'description, supplementary unit, then for exports and for imports, the same month of last year and of this year: weight (tonnes), quantity in the supplementary unit, ' +
      'value (thousand US$) and value (thousand tenge). Each code row is followed by group rows (CIS / rest of the world) and country rows in Russian. ' +
      'Older files (2004–2015 at least) are SAP exports whose data is on the PRINT sheet: this month only, weight (tonnes), quantity and value (thousand US$), no tenge.',
    links: [
      { label: 'Foreign trade statistics (all KGD files)', url: PAGE_URL },
    ],
  },
  sourceFiles: {
    description:
      'KGD’s own file for the month: a ZIP (about 7 MB) of one Excel workbook with both exports and imports by 10-digit TN VED code and partner country. ' +
      'One file covers both flows, so it is listed under each and downloaded once.',
    list,
  },
  // September 2026 was published on 22 October 2026, August on 28 September (admins can change it)
  lagMonths: 1,
  publishDay: 28,
  startPeriod: '2004-01',
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint: 'Not needed: the file holds every 10-digit TN VED code.',
};
