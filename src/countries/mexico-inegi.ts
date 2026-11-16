import { fetch } from 'undici';
import { env } from '../config/env';
import { Period, TradeFlow } from '../types';
import { BROWSER_UA, RetryableError } from '../utils/http';
import { splitPeriod } from '../utils/period';
import { ProxyPool, Route } from '../utils/proxy-pool';

/**
 * INEGI's monthly merchandise trade balance cube (Balanza Comercial de Mercancías de México), read
 * to fill the fracción × country cells Banxico withholds: INEGI publishes many of them. INEGI refuses
 * connections from some networks, so requests go through a ProxyPool (direct when that works).
 */
const SITE = 'https://www.inegi.org.mx';
/** The dataset's start page: holds the cube's server, database and name */
export const INEGI_START_PAGE = `${SITE}/sistemas/Olap/Proyectos/bd/continuas/comex/comex_bcmm_mensual2023.asp?`;
/** The page's Export button: runs an MDX query and returns every row as one CSV (no paging) */
const EXPORT_URL = `${SITE}/sistemas/olap/exporta/exporta.aspx`;
/** The monthly cube starts here; earlier months are Banxico only */
export const INEGI_FROM: Period = '2023-01';
/** The cube's names are read again after this long */
const CUBE_MS = 6 * 60 * 60 * 1000;
/** A whole month and flow is 5–15 MB and takes 20–60 s */
const EXPORT_TIMEOUT_MS = 300_000;
/** Routes (proxies) tried for one request before it fails; each is checked just before use, so dead ones cost seconds */
const ROUTE_ATTEMPTS = 8;

const FLOW: Record<TradeFlow, string> = { EXPORT: 'Exportaciones', IMPORT: 'Importaciones' };
const PRODUCTS = '[Total Fracción Arancelaria y NICO].[Total Fracción Arancelaria y NICO]';

const pool = new ProxyPool({
  name: 'INEGI',
  testUrl: INEGI_START_PAGE,
  testMarker: 'COMEX_BCMM',
  fixed: env.inegiProxies,
  fixedEnv: 'INEGI_PROXY',
  useFree: env.INEGI_FREE_PROXIES,
});

/** One fracción × country cell; value and quantity are null when INEGI withholds it ("C") */
export interface InegiCell {
  country: string;
  description: string;
  /** The quantity's unit, e.g. "Kg", "Pza" */
  unit: string;
  value: number | null;
  quantity: number | null;
  withheld: boolean;
}

/** A month and flow */
export interface InegiMonth {
  /** Country cells by 10-digit fracción, then by countryKey */
  cells: Map<string, Map<string, InegiCell>>;
  /** Each fracción's world total (its "Total" row) */
  totals: Map<string, InegiCell>;
}

/** INEGI's world row for a fracción */
const WORLD = 'Total';

interface Cube {
  server: string;
  database: string;
  cube: string;
}
let cubeCache: { at: number; cube: Promise<Cube> } | undefined;

type Log = (level: 'info' | 'warn', message: string) => void;

/** Runs `request` on a route, moving to another route when it fails */
async function viaRoutes<T>(what: string, request: (route: Route) => Promise<T>, signal: AbortSignal, log?: Log): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= ROUTE_ATTEMPTS; attempt++) {
    const route = await pool.route(signal);
    try {
      const result = await request(route);
      pool.succeeded(route);
      return result;
    } catch (err: any) {
      if (signal.aborted) throw signal.reason;
      last = err;
      pool.failed(route);
      log?.('warn', `INEGI: ${what} failed via ${route.label} (${err?.cause?.code ?? err?.message}); trying another route`);
    }
  }
  throw new RetryableError(`INEGI: ${what} failed on ${ROUTE_ATTEMPTS} routes (${(last as any)?.message})`);
}

async function readCube(signal: AbortSignal, log?: Log): Promise<Cube> {
  const html = await viaRoutes(
    'opening the dataset',
    async (route) => {
      const res = await fetch(INEGI_START_PAGE, {
        dispatcher: route.dispatcher,
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new TextDecoder('windows-1252').decode(await res.arrayBuffer());
    },
    signal,
    log
  );
  const field = (name: string) => new RegExp(`name="${name}"\\s+value="([^"]+)"`).exec(html)?.[1];
  const cube = { server: field('server'), database: field('database'), cube: field('cube') };
  if (!cube.server || !cube.database || !cube.cube) throw new Error("INEGI: the dataset's start page no longer names its cube");
  return cube as Cube;
}

function cubeInfo(signal: AbortSignal, log?: Log): Promise<Cube> {
  if (cubeCache && Date.now() - cubeCache.at < CUBE_MS) return cubeCache.cube;
  const fresh = readCube(signal, log);
  cubeCache = { at: Date.now(), cube: fresh };
  fresh.catch(() => (cubeCache = undefined));
  return fresh;
}

/** The server reads the form as Latin-1 (ñ = %F1), like the page's own form */
const latin1 = (s: string) =>
  [...Buffer.from(s, 'latin1')]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9*\-._]/.test(c)) return c;
      return b === 32 ? '+' : '%' + b.toString(16).toUpperCase().padStart(2, '0');
    })
    .join('');

/** The Export form as the page sends it, with our query: every fracción × country of a month and flow */
function exportForm(cube: Cube, period: Period, flow: TradeFlow): string {
  const { year, month } = splitPeriod(period);
  const flows = `Filter([Tipo operación].[Tipo operación].[Total].Children, [Tipo operación].[Tipo operación].CurrentMember.Name = "${FLOW[flow]}")`;
  const rows = `crossjoin(crossjoin(${flows}, Descendants(${PRODUCTS}.[Total],,LEAVES)), {[País].[País].[Total], [País].[País].[Pais].members})`;
  const where = `([Año].[ID FECHA REGISTRO].&[${year}],[Mes].[Mes].[DES MES].&[${month}],[Tipo moneda].[ID TIPO MONEDA].&[1])`;
  const mdx = `select NON EMPTY {[Measures].levels(0).allmembers} on columns, NON EMPTY ${rows} on rows from [${cube.cube}] where ${where}`;
  // The titles only head the file, but the server answers an HTML page instead of the CSV when they are empty
  const title = 'Balanza Comercial de Mercancías de México Mensual';
  const fields: [string, string][] = [
    ['nomdimfila', 'Tipo operación|Total Fracción Arancelaria y NICO|País'],
    ['to_display', ''],
    ['cube', cube.cube],
    ['cubeName', cube.cube],
    ['nomdimColumna', 'Measures'],
    ['Lc_tituloFiltro', `Consulta de: ${title}   Por: Tipo operación, Total Fracción Arancelaria y NICO y País   Según: Dato`],
    ['Lc_encabeza', '\\\\Valor Total\\Cantidad total\\'],
    ['Lc_unidadmedida', 'Dolares'],
    ['Lc_sql', mdx],
    ['Lc_conexion', `provider=MSOLAP.8;MDX Compatibility=2;data source=${cube.server};Connect timeout=120;Initial catalog=${cube.database}`],
    ['Lc_titulo', `${title}|Año : ${year}|Mes : ${month}|Tipo moneda : US Dólares|`],
    ['Lc_piepagina', 'Nota: "C" refiere a información Confidencial. Fuente: SAT, SE, BANXICO, INEGI. Balanza Comercial de Mercancías de México.'],
    ['Lc_salida', '0'],
    ['Lc_StrConexion', '1'],
    ['Lc_sql_allmembers', mdx],
    ['Lc_ValidaDimGeo', '0'],
    ['completo', 'completo'],
    ['Cant_Col', '2'],
    ['Cant_Fil', '0'],
    ['Lc_formato', 'Texto separado por comas(.csv)'],
  ];
  return fields.map(([k, v]) => `${latin1(k)}=${latin1(v)}`).join('&');
}

/** Splits a CSV line, honouring quotes (INEGI leaves some descriptions with commas unquoted) */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') (cur += '"'), i++;
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) out.push(cur), (cur = '');
    else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

const amount = (s: string) => (s === 'C' || s === '' ? null : Number(s.replace(/,/g, '')));

/**
 * Parses the export: a title block, a header " , , , Valor Total, Cantidad total", then one line per
 * cell "Exportaciones, 4011.10.10.07  (Pza) Description, Country, value, quantity". The description
 * may hold unquoted commas, so the country and amounts are read from the end of the line.
 */
function parseExport(text: string, flow: TradeFlow): InegiMonth {
  const lines = text.replace(/\r/g, '').split('\n');
  const header = lines.findIndex((l) => /Valor Total\s*,\s*Cantidad total/.test(l));
  if (header < 0) throw new Error(`not an INEGI export: ${text.slice(0, 150).replace(/\s+/g, ' ')}`);
  const month: InegiMonth = { cells: new Map(), totals: new Map() };
  for (const line of lines.slice(header + 1)) {
    const fields = splitCsv(line);
    if (fields.length < 5 || fields[0] !== FLOW[flow]) continue;
    const product = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d{2})\s*\(([^)]*)\)\s*(.*)$/.exec(fields.slice(1, -3).join(', '));
    if (!product) continue;
    const code = product.slice(1, 5).join('');
    const [country, value, quantity] = fields.slice(-3);
    const cell: InegiCell = { country, unit: product[5], description: product[6], value: amount(value), quantity: amount(quantity), withheld: value === 'C' };
    if (country === WORLD) {
      month.totals.set(code, cell);
      continue;
    }
    const cells = month.cells.get(code) ?? new Map<string, InegiCell>();
    cells.set(countryKey(country), cell);
    month.cells.set(code, cells);
  }
  return month;
}

/**
 * Every fracción × country of a month and flow, with each fracción's world total, or null before
 * INEGI_FROM. No cells means INEGI hasn't published the month yet.
 */
export async function inegiMonth(period: Period, flow: TradeFlow, signal: AbortSignal, log?: Log): Promise<InegiMonth | null> {
  if (period < INEGI_FROM) return null;
  // A retried request (Banxico failed) reuses the month instead of exporting it again
  const key = `${period}|${flow}`;
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < RECENT_MS) return hit.month;
  const month = await exportMonth(period, flow, signal, log);
  recent.set(key, { at: Date.now(), month });
  while (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
  return month;
}

/** The last few months read, briefly */
const recent = new Map<string, { at: number; month: InegiMonth }>();
const RECENT_MS = 20 * 60 * 1000;
const RECENT_MAX = 2;

async function exportMonth(period: Period, flow: TradeFlow, signal: AbortSignal, log?: Log): Promise<InegiMonth> {
  const cube = await cubeInfo(signal, log);
  const body = exportForm(cube, period, flow);
  return viaRoutes(
    `${period} ${flow.toLowerCase()} export`,
    async (route) => {
      const res = await fetch(EXPORT_URL, {
        method: 'POST',
        body,
        dispatcher: route.dispatcher,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': BROWSER_UA,
          Origin: SITE,
          Referer: `${SITE}/sistemas/olap/consulta/general_ver4/MDXQueryDatos.asp`,
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(EXPORT_TIMEOUT_MS)]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseExport(new TextDecoder('windows-1252').decode(await res.arrayBuffer()), flow);
    },
    signal,
    log
  );
}

/** INEGI's country names that Banxico spells differently, as countryKey gives them */
const ALIASES: Record<string, string> = {
  azerbaijan: 'azerbaiyan',
  botswana: 'botsuana',
  djibouti: 'yibuti',
  eslovaquia: 'republica eslovaca',
  'estado de micronesia': 'estado micronesia',
  fidji: 'fiyi',
  'hong kong (region administrativa especial de la republica de china)': 'hong kong',
  'isla montserrat': 'montserrat',
  'isla nive': 'niue',
  'isla norfolk': 'norfolk',
  'isla reunion': 'reunion',
  'islas cocos': 'cocos',
  'islas navidad': 'navidad',
  'islas pitcairns': 'islas pitcairn',
  'islas turcas y caicos': 'turcas y caicos',
  'islas virgenes (eu)': 'islas virgenes usa',
  'islas virgenes (reino unido)': 'islas virgenes britanicas',
  kyrgyzstan: 'kirguizistan',
  lesotho: 'lesoto',
  'nueva zelanda': 'nueva zelandia',
  'otros paises no declarados de la ue': 'no identificados de la u.e.',
  'paises no identificados': 'no identificados',
  swazilandia: 'suazilandia',
  tadjikistan: 'tayikistan',
  'taiwan (republica de china)': 'taiwan',
  'territorios del reino unido del oceano indico': 'territorios britanicos del oceano indico',
  yemen: 'republica de yemen',
  zimbabwe: 'zimbabue',
  'zona canal de panama': 'zona canal panama',
};

/** A country name as both sources can be matched on: no accents or case, INEGI's spellings mapped to Banxico's */
export function countryKey(name: string): string {
  const key = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return ALIASES[key] ?? key;
}
