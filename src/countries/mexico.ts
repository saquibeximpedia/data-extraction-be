import { Country } from './country.types';
import { ISO3_BY_COUNTRY } from './mexico-countries';
import { countryKey, INEGI_FROM, INEGI_START_PAGE, InegiMonth, inegiMonth } from './mexico-inegi';
import { perMonth, requestMatcher } from './opendatasoft';
import { Period, TradeFlow, TradeRecord } from '../types';
import { BROWSER_UA, RetryableError } from '../utils/http';
import { splitPeriod } from '../utils/period';

const SITE = 'https://www.banxico.org.mx/CuboComercioExterior';
/** Banxico's Pyramid Analytics server behind the cube pages; every call is a POST of {service, method, arguments} */
const ENTRY_POINT = 'https://tablero.banxico.org.mx/infraEntryPoint';
/** The server only answers calls that come from Banxico's pages */
const ORIGIN = 'https://www.banxico.org.mx';
/** A session (token and query template) is read again after this long */
const SESSION_MS = 30 * 60 * 1000;
/** One query returns a whole month (3–4 MB, 5–20 s) */
const QUERY_TIMEOUT_MS = 180_000;

/** The two cubes: value in US dollars and volume (quantity in the tariff's unit), each a page with its own dashboard */
type Cube = 'ValorDolares' | 'Volumen';

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const FLOW: Record<TradeFlow, string> = { EXPORT: 'Exportación', IMPORT: 'Importación' };

const PRODUCTS = '[Productos].[TIGIE]';
const REGIONS = '[Localización].[Regiones]';
const ISO_CODES = '[Localización].[Mapa]';
const WORLD = `${REGIONS}.[Todas las regiones]`;

/** Banxico's marker for a withheld (confidential) cell: "NA es información testada" */
const WITHHELD = 'NA';

/** Extraction methods offered on the extract page (the first is the default) */
const METHOD_WITH_INEGI = 'banxico-inegi';
const METHOD_BANXICO = 'banxico';
const METHOD_INEGI = 'inegi';

interface Template {
  qom: any;
  qsm: any;
  modelConnection: any;
}

interface Session {
  token: string;
  template: Template;
}

const sessions = new Map<Cube, { at: number; session: Promise<Session> }>();

function failed(err: any, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason;
  if (err instanceof RetryableError) return err;
  if (err?.name === 'TimeoutError') return new RetryableError(`Banxico: no response within ${QUERY_TIMEOUT_MS / 1000}s`);
  return new RetryableError(`Banxico: network error (${err?.message})`);
}

/** POSTs one call to the Pyramid server as the cube page does */
async function call(token: string, service: string, method: string, args: unknown[], signal: AbortSignal): Promise<any> {
  const body = { query: { service, method, arguments: args, callPosition: '1' }, requestShellOrigin: 7, type: 3, rId: crypto.randomUUID(), benchmarkNeeded: false };
  let text: string;
  try {
    const res = await fetch(ENTRY_POINT, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', PyramidEmbeddedAuth: token, Origin: ORIGIN, Referer: `${ORIGIN}/`, 'User-Agent': BROWSER_UA },
      signal: AbortSignal.any([signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]),
    });
    text = await res.text();
    // An expired token or a refused call: a new session is read for the retry
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) throw new RetryableError(`Banxico: temporary error HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Banxico: HTTP ${res.status} ${text.slice(0, 200)}`);
  } catch (err) {
    throw failed(err, signal);
  }
  const result = JSON.parse(text);
  if (result?.inheritanceType !== 'ApplicationResult') throw new RetryableError(`Banxico: unexpected answer to ${service}.${method}: ${text.slice(0, 300)}`);
  return result.data;
}

/**
 * Opens the cube page for its anonymous token (the PyramidEmbeddedAuth cookie) and its dashboard's id,
 * then reads the dashboard to get the query its table runs, which is the template for ours
 */
async function openSession(cube: Cube, signal: AbortSignal): Promise<Session> {
  let html: string;
  let token: string | undefined;
  try {
    const res = await fetch(`${SITE}/${cube}/matrizprodregion`, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`Banxico: temporary error HTTP ${res.status} opening the ${cube} cube`);
    html = await res.text();
    token = res.headers.getSetCookie().map((c) => /^PyramidEmbeddedAuth=([^;]+)/.exec(c)?.[1]).find(Boolean);
  } catch (err) {
    throw failed(err, signal);
  }
  const dashboard = /id="frameContent"[^>]*data-id="([0-9a-f-]+)"/.exec(html)?.[1];
  if (!token || !dashboard) throw new RetryableError(`Banxico: the ${cube} cube page gave no ${token ? 'dashboard id' : 'access token'}`);
  const pkg = await call(token, 'ItemService', 'getPackageById', [{ id: dashboard, deviceType: 1, clientUiLanguage: 'es-ES', handlePredefinedProms: true }], signal);
  // The product × region table, wherever the dashboard keeps it (the value cube's first document, the volume cube's second)
  const queries = (pkg?.itemContentPackage?.containerDataPackages ?? []).flatMap((c: any) => (c.documents ?? []).flatMap((d: any) => (d.queries ?? []).map((q: any) => q.query)));
  const query = queries.find((q: any) => {
    const columns: string[] = q?.qom?.columns?.attributes?.map((a: any) => a.modelAttribute?.column) ?? [];
    return columns.includes(PRODUCTS) && columns.includes(REGIONS) && q.qsm && q.modelConnection;
  });
  if (!query) throw new Error(`Banxico: the ${cube} dashboard no longer holds a product × region table query`);
  return { token, template: { qom: query.qom, qsm: query.qsm, modelConnection: query.modelConnection } };
}

function session(cube: Cube, signal: AbortSignal): Promise<Session> {
  const cached = sessions.get(cube);
  if (cached && Date.now() - cached.at < SESSION_MS) return cached.session;
  const fresh = openSession(cube, signal);
  sessions.set(cube, { at: Date.now(), session: fresh });
  // A failed session is opened again by the next request, not kept
  fresh.catch(() => sessions.delete(cube));
  return fresh;
}

/** Every member of a level, e.g. every fracción */
const level = (hierarchy: string, name: string) => ({
  inheritanceType: 'ElementSelection',
  elementSelectionType: 1,
  value: null,
  deselect: false,
  elementFunction: { elementFunctionType: 2, arguments: [`${hierarchy}.[${name}]`] },
});
const member = (uniqueName: string) => ({ inheritanceType: 'ElementSelection', elementSelectionType: 0, value: uniqueName, deselect: false });

/** One cell of a query: its members' captions and unique names by hierarchy, and the value (a number or "NA") */
interface Cell {
  members: Map<string, { caption: string; uniqueName: string }>;
  value: number | string | null;
}

/**
 * Runs the table's own query for a month and flow, with the products at fracción level crossed with
 * `places` (each a hierarchy and the selection on it)
 */
async function runQuery(cube: Cube, period: Period, flow: TradeFlow, places: [string, object][], signal: AbortSignal): Promise<Cell[]> {
  const { token, template } = await session(cube, signal);
  const qom = structuredClone(template.qom);
  const qsm = structuredClone(template.qsm);
  const products = qom.columns.attributes.find((a: any) => a.modelAttribute.column === PRODUCTS);
  const regions = qom.columns.attributes.find((a: any) => a.modelAttribute.column === REGIONS);
  if (!products || !regions) throw new Error('Banxico: the table query no longer has products and regions');
  products.elementSelectionList = [level(PRODUCTS, 'Fracción')];
  qom.columns.attributes = [
    products,
    ...places.map(([hierarchy, selection]) => ({ ...structuredClone(regions), modelAttribute: { ...regions.modelAttribute, column: hierarchy }, elementSelectionList: [selection] })),
  ];
  const { year, month } = splitPeriod(period);
  for (const prompts of [qom.promSelections, qsm.promSelections]) {
    for (const [key, prompt] of Object.entries<any>(prompts)) {
      if (key.startsWith('[Fecha]')) prompt.elements[0].value = `${key}.[${MONTHS[month - 1]} ${year}]`;
      if (key.startsWith('[Tipo Operación]')) prompt.elements[0].value = `${key}.[${FLOW[flow]}]`;
    }
  }
  const data = await call(token, 'IQueryService', 'runQuery', [{ qom, qsm, modelConnection: template.modelConnection }], signal);
  if (typeof data !== 'string') throw new RetryableError(`Banxico: the ${cube} query returned no table`);
  const table = JSON.parse(data);
  // Members are listed once, fields separated by ␞◙ (3 = caption, 8 = unique name); cells point at them by position
  const members: string[][] = table.serializedMemberMap.memberMapSerialized.split('␞☻').map((m: string) => m.split('␞◙'));
  const axes: number[][] = table.rawResults.slice(0, -1);
  const values: (number | string | null)[] = table.rawResults.at(-1) ?? [];
  const columns: string[] = table.columnMap.map((c: any) => c.column);
  return values.map((value, i) => ({
    value,
    members: new Map(axes.map((axis, a) => [columns[a], { caption: members[axis[i]][3], uniqueName: members[axis[i]][8] }])),
  }));
}

const number = (value: Cell['value']) => (typeof value === 'number' ? value : null);
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * "0201209100 --- Los demás cortes…" → code and description (older tariffs have shorter codes). Banxico's
 * statistical fracciones start with a Q ("Q290531010 --- Fracción Q290531010"); the Q stays in the code.
 */
function splitProduct(caption: string): { code: string; description: string } {
  const match = /^([A-Z]?\d+)\s*-*\s*(.*)$/.exec(caption.trim());
  return match ? { code: match[1], description: match[2] } : { code: caption.trim(), description: '' };
}

/** What INEGI added to a month */
interface InegiFill {
  /** Banxico-withheld cells INEGI publishes */
  filled: number;
  /** Cells INEGI publishes that Banxico doesn't list at all */
  added: number;
  value: number;
  /** Fracciones whose countries now add up to more than Banxico's world total (revisions); no remainder row */
  overTotal: number;
}

/**
 * The month's rows for a flow: each fracción by partner country with value and quantity, one row per
 * withheld country cell, and the fracción's undisclosed remainder (its world total less the published
 * countries). Cells Banxico withholds but INEGI publishes (`inegiData`, read alongside Banxico) are
 * filled from INEGI (row_type COUNTRY_INEGI) before the remainder is worked out.
 */
async function monthRows(period: Period, flow: TradeFlow, signal: AbortSignal, inegiData: Promise<InegiMonth | null>): Promise<{ rows: TradeRecord[]; fill: InegiFill }> {
  const byCountry: [string, object][] = [
    [REGIONS, level(REGIONS, 'País')],
    [ISO_CODES, level(ISO_CODES, 'Código')],
  ];
  const world: [string, object][] = [[REGIONS, member(WORLD)]];
  const [valueCells, valueWorld, quantityCells, quantityWorld, inegi] = await Promise.all([
    runQuery('ValorDolares', period, flow, byCountry, signal),
    runQuery('ValorDolares', period, flow, world, signal),
    runQuery('Volumen', period, flow, [[REGIONS, level(REGIONS, 'País')]], signal),
    runQuery('Volumen', period, flow, world, signal),
    inegiData,
  ]);

  const product = (c: Cell) => c.members.get(PRODUCTS)!;
  const country = (c: Cell) => c.members.get(REGIONS)!;
  const quantity = new Map(quantityCells.map((c) => [`${product(c).uniqueName}|${country(c).uniqueName}`, c.value]));
  const worldValue = new Map(valueWorld.map((c) => [product(c).uniqueName, c.value]));
  const worldQuantity = new Map(quantityWorld.map((c) => [product(c).uniqueName, c.value]));

  const rows: TradeRecord[] = [];
  const fill: InegiFill = { filled: 0, added: 0, value: 0, overTotal: 0 };
  // By fracción code: its countries' sums so far, how many came from INEGI, and its unique name for the world total
  const published = new Map<string, { value: number; quantity: number; description: string; uniqueName?: string; fromInegi: number }>();
  const add = (code: string, description: string, value: number | null, qty: number | null, uniqueName?: string, fromInegi = false) => {
    const sum = published.get(code) ?? { value: 0, quantity: 0, description, fromInegi: 0 };
    sum.value += value ?? 0;
    sum.quantity += qty ?? 0;
    sum.uniqueName ??= uniqueName;
    if (fromInegi) sum.fromInegi++;
    published.set(code, sum);
  };
  // Every fracción × country Banxico lists, and each country's ISO code, for INEGI's extra cells
  const listed = new Set<string>();
  const iso = new Map<string, { name: string; iso3: string }>();

  for (const cell of valueCells) {
    const p = product(cell);
    const { code, description } = splitProduct(p.caption);
    const partner = country(cell).caption;
    const key = countryKey(partner);
    const iso3 = cell.members.get(ISO_CODES)?.caption ?? '';
    listed.add(`${code}|${key}`);
    if (!iso.has(key)) iso.set(key, { name: partner, iso3 });
    const row = { hs_code: code, hs_description: description, partner_iso3: iso3, partner_name: partner };

    const inegiCell = cell.value === WITHHELD ? inegi?.cells.get(code)?.get(key) : undefined;
    if (inegiCell && !inegiCell.withheld) {
      rows.push({ ...row, row_type: 'COUNTRY_INEGI', value_usd: inegiCell.value, quantity: inegiCell.quantity });
      add(code, description, inegiCell.value, inegiCell.quantity, p.uniqueName, true);
      fill.filled++;
      fill.value += inegiCell.value ?? 0;
      continue;
    }
    const value = number(cell.value);
    const qty = number(quantity.get(`${p.uniqueName}|${country(cell).uniqueName}`) ?? null);
    rows.push({ ...row, row_type: cell.value === WITHHELD ? 'COUNTRY_NA' : 'COUNTRY', value_usd: value, quantity: qty });
    add(code, description, value, qty, p.uniqueName);
  }

  // Cells INEGI publishes that Banxico doesn't list at all
  for (const [code, cells] of inegi?.cells ?? []) {
    for (const [key, c] of cells) {
      if (c.withheld || listed.has(`${code}|${key}`)) continue;
      const known = iso.get(key);
      const description = published.get(code)?.description ?? c.description;
      rows.push({
        hs_code: code,
        hs_description: description,
        partner_iso3: known?.iso3 || ISO3_BY_COUNTRY[key] || '',
        partner_name: known?.name ?? c.country,
        row_type: 'COUNTRY_INEGI',
        value_usd: c.value,
        quantity: c.quantity,
      });
      add(code, description, c.value, c.quantity, undefined, true);
      fill.added++;
      fill.value += c.value ?? 0;
    }
  }

  // What is still withheld by country but published for the fracción as a whole. INEGI rounds to
  // whole dollars and units, so each INEGI cell can leave up to 0.5 of rounding in the remainder.
  for (const [code, sum] of published) {
    if (!sum.uniqueName) continue;
    const total = number(worldValue.get(sum.uniqueName) ?? null);
    const totalQuantity = number(worldQuantity.get(sum.uniqueName) ?? null);
    const value = total === null ? null : round(total - sum.value, 2);
    const qty = totalQuantity === null ? null : round(totalQuantity - sum.quantity, 3);
    const valueSlack = 0.5 + 0.5 * sum.fromInegi;
    const quantitySlack = 0.001 + 0.5 * sum.fromInegi;
    if ((value ?? 0) < -valueSlack || (qty ?? 0) < -quantitySlack) {
      fill.overTotal++;
      continue;
    }
    if ((value ?? 0) < valueSlack && (qty ?? 0) < quantitySlack) continue;
    const clamp = (n: number | null) => (n === null ? null : Math.max(0, n));
    rows.push({ hs_code: code, hs_description: sum.description, partner_iso3: '', partner_name: 'Undisclosed partners', row_type: 'UNDISCLOSED_PARTNERS', value_usd: clamp(value), quantity: clamp(qty) });
  }
  return { rows, fill };
}

/**
 * A month and flow from INEGI alone: each fracción × country as INEGI publishes it (COUNTRY, or
 * COUNTRY_NA where it shows "C"), with the quantity's unit, and the fracción's undisclosed remainder
 * (its world total less the published countries)
 */
function inegiOnlyRows(month: InegiMonth): TradeRecord[] {
  const rows: TradeRecord[] = [];
  for (const code of new Set([...month.cells.keys(), ...month.totals.keys()])) {
    let value = 0;
    let qty = 0;
    let known = 0;
    for (const [key, c] of month.cells.get(code) ?? []) {
      rows.push({
        hs_code: code,
        hs_description: c.description,
        partner_iso3: ISO3_BY_COUNTRY[key] ?? '',
        partner_name: c.country,
        row_type: c.withheld ? 'COUNTRY_NA' : 'COUNTRY',
        value_usd: c.value,
        quantity: c.quantity,
        quantity_unit: c.unit,
      });
      if (c.withheld) continue;
      value += c.value ?? 0;
      qty += c.quantity ?? 0;
      known++;
    }
    // Every INEGI figure is rounded to a whole dollar and unit, the total too
    const total = month.totals.get(code);
    if (!total || total.withheld) continue;
    const slack = 0.5 * (known + 1);
    const restValue = total.value === null ? null : round(total.value - value, 2);
    const restQty = total.quantity === null ? null : round(total.quantity - qty, 3);
    if ((restValue ?? 0) <= slack && (restQty ?? 0) <= slack) continue;
    const clamp = (n: number | null) => (n === null ? null : Math.max(0, n));
    rows.push({
      hs_code: code,
      hs_description: total.description,
      partner_iso3: '',
      partner_name: 'Undisclosed partners',
      row_type: 'UNDISCLOSED_PARTNERS',
      value_usd: clamp(restValue),
      quantity: clamp(restQty),
      quantity_unit: total.unit,
    });
  }
  return rows;
}

/** Banxico's foreign trade cubes (value in dollars and volume), every fracción by partner country */
export const mexico: Country = {
  code: 'MEX',
  name: 'Mexico',
  source: {
    name:
      'Banco de México: Cubo de Información de Comercio Exterior (value in dollars and volume), with withheld cells filled from INEGI: Balanza Comercial de ' +
      'Mercancías de México (2023 onwards)',
    url: `${SITE}/ValorDolares/matrizprodregion`,
    endpoint:
      `${ENTRY_POINT} (IQueryService.runQuery on models CE PUBLICO and CE PUBLICO VOLUMEN), with the token from ${SITE}/{ValorDolares|Volumen}/matrizprodregion; ` +
      `and INEGI's export of the cube on ${INEGI_START_PAGE}`,
    method:
      'The cube pages are a Pyramid Analytics dashboard; the service talks to it the way the pages do. It opens each page for its anonymous token, reads the ' +
      'dashboard’s table query, and runs it with products at fracción level. One request per flow and month makes four queries: value and quantity, each by ' +
      'partner country and for the world. Every code comes with the month. From January 2023, the same month and flow is also exported from INEGI’s cube ' +
      '(every fracción × country, one CSV), which publishes many of the cells Banxico withholds. INEGI refuses some networks, so it is reached directly ' +
      'when possible, else through INEGI_PROXY or free public proxies (TLS end to end). If INEGI can’t be reached or hasn’t published the month yet, the ' +
      'month is Banxico only and the run log says so.',
    output:
      'One row per 10-digit fracción (8-digit tariff code + NICO) and partner: hs_code, hs_description (cut at about 50 characters by Banxico), partner_iso3, ' +
      'partner_name, row_type, value_usd and quantity (in the fracción’s TIGIE unit, not given by the source). row_type COUNTRY is published by Banxico; ' +
      'COUNTRY_INEGI is a cell Banxico withholds that INEGI publishes (INEGI rounds to whole dollars and units; the two agree wherever both publish); ' +
      'COUNTRY_NA is withheld by both (“información testada” / “confidencial”: value and quantity empty); UNDISCLOSED_PARTNERS is the fracción’s world total ' +
      'less its known countries, so a fracción’s rows add up to its world total. Fracciones withheld even for the world have only COUNTRY_NA rows ' +
      '(plus any INEGI cells).',
    links: [
      { label: 'Value in dollars cube', url: `${SITE}/ValorDolares/matrizprodregion` },
      { label: 'Volume cube', url: `${SITE}/Volumen/matrizprodregion` },
      { label: 'About the cubes (value vs volume)', url: `${SITE}/` },
      { label: 'INEGI: Balanza Comercial de Mercancías de México (monthly cube)', url: INEGI_START_PAGE },
    ],
  },
  // September 2026 was in the cube on 9 November 2026 (admins can change it)
  lagMonths: 2,
  publishDay: 10,
  startPeriod: '1993-01',
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint:
    'Not needed: every 10-digit fracción (8-digit tariff code + 2-digit NICO) comes with each month. Enter 2–10 digits to keep only those codes ' +
    '(Banxico’s statistical codes start with Q, e.g. Q290531010).',
  // Each request is four whole-month queries on Banxico's server
  concurrency: 1,
  rateLimitPerMinute: 6,
  retryDelayMs: 15_000,
  allHsCodes: true,

  // Digits, or Banxico's statistical Q fracciones (Q290531010)
  normalizeHsCode: (raw) => {
    const code = raw.toUpperCase().replace(/[^Q\d]/g, '');
    return /^Q?\d{2,10}$/.test(code) ? code : null;
  },

  splitQueries: perMonth,

  methods: [
    {
      id: METHOD_WITH_INEGI,
      label: 'Banxico + INEGI',
      description:
        'Banxico for every month, with the cells Banxico withholds filled from INEGI where INEGI publishes them (from January 2023; row_type ' +
        'COUNTRY_INEGI). Assigns most of the “Undisclosed partners” value to real countries. Slower (INEGI’s whole-month export, 20–60 s per month and ' +
        'flow), and INEGI is reached through proxies when this server can’t reach it directly. The newest month is Banxico only until INEGI publishes it, ' +
        'about a month later; the run log says when a month is Banxico only.',
    },
    {
      id: METHOD_BANXICO,
      label: 'Banxico only',
      description:
        'Banxico’s cubes alone: faster, no proxies, from 1993 and the newest month first. Cells Banxico withholds stay COUNTRY_NA and their value is ' +
        'in UNDISCLOSED_PARTNERS.',
    },
    {
      id: METHOD_INEGI,
      label: 'INEGI only',
      description:
        'INEGI’s monthly trade balance cube alone (January 2023 onwards; about a month behind Banxico). Values in whole dollars, a quantity_unit ' +
        'column (Kg, Pza…), full product descriptions. Cells INEGI withholds (“C”) are COUNTRY_NA, and UNDISCLOSED_PARTNERS is its world total less ' +
        'the published countries. Reached through proxies when this server can’t reach INEGI directly; a month INEGI can’t be reached for fails and is retried.',
      startPeriod: INEGI_FROM,
    },
  ],

  async fetchRecords({ hsCodes, periods: [period], tradeType }, signal, context) {
    const log = context.log;
    const label = `${period} ${tradeType.toLowerCase()}s`;
    const method = context.method ?? METHOD_WITH_INEGI;
    let rows: TradeRecord[];

    if (method === METHOD_INEGI) {
      // Unlike the combined method, there is nothing to fall back on: a failure fails the request (and is retried)
      const month = await inegiMonth(period, tradeType, signal, log);
      if (!month?.cells.size) {
        log?.('info', `${label}: INEGI hasn't published this month yet`);
        return new Map();
      }
      rows = inegiOnlyRows(month);
    } else {
      // INEGI is read alongside Banxico; when it can't be reached the month is Banxico only
      const inegi = (method === METHOD_WITH_INEGI ? inegiMonth(period, tradeType, signal, log) : Promise.resolve(null)).then(
        (month) => {
          if (month && !month.cells.size) log?.('info', `${label}: INEGI hasn't published this month yet; Banxico only`);
          return month?.cells.size ? month : null;
        },
        (err) => {
          if (signal.aborted) throw err;
          log?.('warn', `${label}: INEGI not used (${err.message}); Banxico only, its withheld cells stay COUNTRY_NA`);
          return null;
        }
      );
      const merged = await monthRows(period, tradeType, signal, inegi);
      rows = merged.rows;
      const { fill } = merged;
      if (fill.filled || fill.added) {
        log?.(
          'info',
          `${label}: INEGI filled ${fill.filled} cells Banxico withholds and added ${fill.added} it doesn't list ($${(fill.value / 1e6).toFixed(1)} M)` +
            (fill.overTotal ? `; ${fill.overTotal} fracciones' countries exceed Banxico's world total (revisions), no remainder row for them` : '')
        );
      }
    }

    const request = requestMatcher(hsCodes);
    const records: TradeRecord[] = [];
    for (const row of rows) {
      const code = request(String(row.hs_code));
      if (code) records.push({ trade_flow: tradeType, request_hs_code: code, period, ...row });
    }
    return new Map<Period, TradeRecord[]>(records.length ? [[period, records]] : []);
  },
};
