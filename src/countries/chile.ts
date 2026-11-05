import { Country, SourceFile } from './country.types';
import { Period, TradeFlow } from '../types';
import { getJson } from '../utils/http';
import { splitPeriod } from '../utils/period';

const PORTAL = 'https://datos.gob.cl';
const ORGANIZATION = 'servicio_nacional_de_aduanas';
const API = `${PORTAL}/api/3/action/package_search?fq=organization:${ORGANIZATION}&rows=1000`;
/** The portal's dataset list is read once per this long */
const CATALOG_MS = 30 * 60 * 1000;

/**
 * A year's datasets are named inconsistently (registro-de-importacion-2026, registros-de-importacion-2019,
 * registro-de-importaciones-2003, registro-de-exportaciones-2024…), and some years have two
 */
const DATASET_NAME: Record<TradeFlow, RegExp> = {
  IMPORT: /^registros?-de-importacion(es)?-(\d{4})$/,
  EXPORT: /^registros?-de-exportacion(es)?-(\d{4})$/,
};

/**
 * Months as resources name them: in full ("Importaciones - septiembre 2026") or abbreviated
 * ("2011 SEP EXPO", file ene-2012-importaciones.part01.rar)
 */
const MONTHS = [
  ['enero', 'ene'],
  ['febrero', 'feb'],
  ['marzo', 'mar'],
  ['abril', 'abr'],
  ['mayo', 'may'],
  ['junio', 'jun'],
  ['julio', 'jul'],
  ['agosto', 'ago'],
  ['septiembre', 'setiembre', 'sep', 'sept', 'set'],
  ['octubre', 'oct'],
  ['noviembre', 'nov'],
  ['diciembre', 'dic'],
];

interface Resource {
  name?: string;
  url: string;
}

interface Dataset {
  name: string;
  metadata_modified: string;
  resources: Resource[];
}

let catalog: { at: number; datasets: Promise<Dataset[]> } | null = null;

/** Every Aduanas dataset with its resources (51 in Nov 2026, one call) */
function datasets(signal: AbortSignal): Promise<Dataset[]> {
  if (!catalog || Date.now() - catalog.at > CATALOG_MS) {
    const datasets = getJson<{ result: { results: Dataset[] } }>(API, { source: 'datos.gob.cl', signal, timeoutMs: 60_000 }).then((r) => r.result.results);
    catalog = { at: Date.now(), datasets };
    // A failed read is tried again by the next request, not kept
    datasets.catch(() => (catalog = null));
  }
  return catalog.datasets;
}

const words = (text: string) => decodeURIComponent(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/);
const fileName = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');

/** The month a resource is for (1–12), from its name, else its file name; 0 for metadata and the like */
function monthOf(resource: Resource): number {
  for (const text of [resource.name ?? '', fileName(resource.url)]) {
    const found = words(text);
    const month = MONTHS.findIndex((names) => names.some((n) => found.includes(n)));
    if (month >= 0) return month + 1;
  }
  return 0;
}

/**
 * The month's files for a flow. A year with two datasets (e.g. 2007, published again in 2026)
 * reads the most recently updated one that has the month.
 */
async function monthFiles(period: Period, flow: TradeFlow, signal: AbortSignal): Promise<SourceFile[]> {
  const { year, month } = splitPeriod(period);
  const candidates = (await datasets(signal))
    .filter((d) => DATASET_NAME[flow].exec(d.name)?.[2] === String(year))
    .sort((a, b) => b.metadata_modified.localeCompare(a.metadata_modified));
  for (const dataset of candidates) {
    const files = dataset.resources.filter((r) => r.url && monthOf(r) === month).map((r) => ({ name: fileName(r.url), url: r.url }));
    if (files.length) return files;
  }
  return [];
}


/** Servicio Nacional de Aduanas on datos.gob.cl: every import (DIN) and export (DUS) declaration line, one archive per month, downloaded by the user's browser */
export const chile: Country = {
  code: 'CHL',
  name: 'Chile',
  source: {
    name: 'Servicio Nacional de Aduanas · open data on datos.gob.cl',
    url: `${PORTAL}/organization/${ORGANIZATION}`,
    endpoint: `${PORTAL}/api/3/action/package_search?fq=organization:${ORGANIZATION} → the month's resources in registro-de-{importacion|exportacion}-{YYYY}`,
    method:
      'Direct download: the service only looks up the month’s files in each year’s dataset; your browser downloads them straight from datos.gob.cl to your device, as published ' +
      '(RAR or ZIP archives; some import years in several .partNN.rar volumes). Nothing is extracted, saved on the server or stored in the database.',
    output:
      'Imports: every line of every import declaration (DIN), 178 columns separated by “;”, no header row, decimal comma: 8-digit tariff code (ARANC_NAC), ' +
      'country of origin and purchase (Aduanas codes), FOB, freight and CIF in US$, quantity and unit, weight, ports, duties (about 430,000 lines a month). ' +
      'Exports: every line of every export declaration (DUS), with its packages (Bultos) and transport documents files. Column names are in each year’s Metadata workbook.',
    links: [
      // A year's dataset name isn't predictable (registro-de-exportaciones-2024…): update these each January
      { label: 'Imports 2026 (DIN)', url: `${PORTAL}/dataset/registro-de-importacion-2026` },
      { label: 'Exports 2026 (DUS)', url: `${PORTAL}/dataset/registro-de-exportacion-2026` },
      { label: 'Every year’s datasets', url: `${PORTAL}/organization/${ORGANIZATION}` },
      { label: 'Aduanas imports by country and product (summary workbooks)', url: 'https://www.aduana.cl/importaciones-por-pais-y-producto/aduana/2020-05-15/100754.html' },
    ],
  },
  sourceFiles: {
    description:
      'Aduanas’ own files from datos.gob.cl: the month’s archive of every declaration line (imports ~25–30 MB, exports ~5 MB plus their Bultos and ' +
      'Documentos de Transporte files). Unpack them with 7-Zip or WinRAR.',
    list: monthFiles,
  },
  // September 2026 was up on 30 October 2026 (admins can change it)
  lagMonths: 1,
  publishDay: 30,
  startPeriod: '2003-01',
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint: 'Not needed: the files hold every 8-digit tariff code.',
};
