import { Country, DatasetRef } from './country.types';
import { chosenDataset, exportRows, noDataset, perMonth, pickDataset, requestMatcher } from './opendatasoft';
import { Period, TradeFlow, TradeRecord } from '../types';
import { getJson } from '../utils/http';
import { splitPeriod } from '../utils/period';

const API_BASE = process.env.BHR_API_BASE || 'https://www.data.gov.bh/api/explore/v2.1';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * iGA foreign trade datasets on the Bahrain Open Data Portal, one per year with no fixed naming.
 * Exports are "Total Exports" (national origin + re-exports). A year not listed is looked up in the
 * catalog by title; another can be chosen or entered on the extract page.
 */
const DATASETS: DatasetRef[] = [
  { flow: 'IMPORT', from: 2021, to: 2021, id: '05-import-2021' },
  { flow: 'IMPORT', from: 2022, to: 2022, id: '04-import-2022' },
  { flow: 'IMPORT', from: 2023, to: 2023, id: '01-import-non-oil-classified-by-commodity-and-country-for-2023' },
  { flow: 'IMPORT', from: 2024, to: 2024, id: 'import-2024' },
  { flow: 'IMPORT', from: 2025, to: 2025, id: 'import-1-2025' },
  { flow: 'IMPORT', from: 2026, to: 2026, id: 'import-2026' },
  { flow: 'EXPORT', from: 2020, to: 2022, id: '03-total-export-2019-2022' },
  { flow: 'EXPORT', from: 2023, to: 2023, id: 'total-exports-2023' },
  { flow: 'EXPORT', from: 2024, to: 2024, id: 'total-export-1-2024' },
  { flow: 'EXPORT', from: 2025, to: 2025, id: 'total-export-1-2025' },
  { flow: 'EXPORT', from: 2026, to: 2026, id: 'total-exports-2026' },
];

/** Catalog titles of each flow's yearly dataset, e.g. "Import 2027", "Total Exports 2027" */
const TITLES: Record<TradeFlow, RegExp> = { IMPORT: /^imports? (\d{4})$/i, EXPORT: /^total exports? (\d{4})$/i };

const discovered = new Map<string, DatasetRef | null>();

/** An iGA dataset titled for the flow and year, when none is listed for it */
async function discover(flow: TradeFlow, year: number, signal: AbortSignal): Promise<DatasetRef | null> {
  const key = `${flow}|${year}`;
  if (!discovered.has(key)) {
    const where = `search("${year}") and publisher = "Information & eGovernment Authority"`;
    const res = await getJson<{ results: { dataset_id: string; metas: { default: { title: string } } }[] }>(
      `${API_BASE}/catalog/datasets?${new URLSearchParams({ where, limit: '100' })}`,
      { source: 'data.gov.bh', signal }
    );
    const hit = res.results.find((r) => Number(r.metas.default.title.trim().match(TITLES[flow])?.[1]) === year);
    discovered.set(key, hit ? { flow, from: year, to: year, id: hit.dataset_id } : null);
  }
  return discovered.get(key) ?? null;
}

/**
 * Field names differ between years (2024 imports use transliterated Arabic names, 2020–2022
 * exports call the partner "country"): each column takes the first name a row has
 */
const ALIASES = {
  value_bd: ['import_value_bd', 'export_value_bd', 'qym_lwrdt_dynr_bhryny', 'qym_lsdrt_dynr_bhryny'],
  value_usd: ['import_value_usa', 'export_value_usa', 'qym_lwrdt_dwlr_mryky', 'qym_lsdrt_dwlr_mryky'],
  weight_kg: ['import_weight_kg', 'export_weight_kg', 'wzn_lwrdt_kjm', 'wzn_lsdrt_kjm'],
  quantity: ['import_quantity', 'export_quantity', 'kmy_lwrdt', 'kmy_lsdrt'],
  unit: ['um', 'whd_lqys'],
  partner_name_en: ['country_name', 'country'],
} as const;

const pick = (row: Record<string, unknown>, names: readonly string[]) => {
  const name = names.find((n) => n in row);
  return name === undefined ? undefined : row[name];
};

/** A dataset row in the same columns for every year */
function toRecord(row: Record<string, unknown>, period: Period, flow: TradeFlow, request: string, datasetId: string): TradeRecord {
  const valueUsd = pick(row, ALIASES.value_usd);
  if (valueUsd === undefined) throw new Error(`data.gov.bh: dataset ${datasetId} has unknown field names (${Object.keys(row).join(', ')}); add them to ALIASES in bahrain.ts`);
  return {
    request_hs_code: request,
    trade_flow: flow,
    period,
    hs_code: String(row.commodity_no ?? ''),
    description_en: row.commodity ?? '',
    description_ar: row.lsl ?? '',
    partner_code: row.un_code ?? '',
    partner_name_en: pick(row, ALIASES.partner_name_en) ?? '',
    partner_name_ar: row.ldwl ?? '',
    value_bd: pick(row, ALIASES.value_bd) ?? '',
    value_usd: valueUsd,
    weight_kg: pick(row, ALIASES.weight_kg) ?? '',
    quantity: pick(row, ALIASES.quantity) ?? '',
    unit: pick(row, ALIASES.unit) ?? '',
  };
}

/** iGA foreign trade statistics on the Bahrain Open Data Portal (data.gov.bh), 8-digit HS by partner country */
export const bahrain: Country = {
  code: 'BHR',
  name: 'Bahrain',
  source: {
    name: 'Bahrain Open Data Portal: foreign trade (Information & eGovernment Authority)',
    url: 'https://www.data.gov.bh/explore/?q=import',
    endpoint: `${API_BASE}/catalog/datasets/{dataset}/exports/json (imports: import-2026, import-1-2025…; exports: total-exports-2026, total-export-1-2025…)`,
    method:
      'Opendatasoft Explore API v2.1, no key. One request per flow and month returns every 8-digit HS code and partner; ' +
      'the year picks the dataset (built in, else found in the catalog by title). Another dataset can be chosen or entered on the extract page.',
    output:
      'One row per 8-digit HS code and partner country: English and Arabic description and partner name, ISO partner code, ' +
      'value in Bahraini dinars and US dollars, weight in kg, quantity and unit. Non-oil trade only; exports are national origin plus re-exports.',
  },
  // September 2026 was published on 20–26 October 2026
  lagMonths: 1,
  publishDay: 27,
  startPeriod: '2020-01',
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint: 'Every 8-digit code comes with each month, so no list is needed. Enter 2 to 8 digits to keep only those codes.',
  rateLimitPerMinute: 30,
  concurrency: 2,
  allHsCodes: true,
  datasets: DATASETS,

  normalizeHsCode: (raw) => {
    const digits = raw.replace(/\D/g, '');
    return /^\d{2,8}$/.test(digits) ? digits : null;
  },

  splitQueries: perMonth,

  async fetchRecords({ hsCodes, periods: [period], tradeType }, signal, { dataset }) {
    const { year, month } = splitPeriod(period);
    const listed = pickDataset(DATASETS, tradeType, year);
    const d = chosenDataset(DATASETS, dataset, tradeType, year, listed) ?? (await discover(tradeType, year, signal));
    if (!d) throw noDataset(API_BASE, tradeType, year, true);

    // Months are written "September" (to 2022), "09 September" or "09-September" (2024 imports)
    const mm = String(month).padStart(2, '0');
    const monthCondition = `(month = "${MONTHS[month - 1]}" or startswith(month, "${mm}"))`;
    const where = d.from === d.to ? monthCondition : `year = date'${year}' and ${monthCondition}`;
    const rows = await exportRows(API_BASE, d.id, where, signal);

    const requestOf = requestMatcher(hsCodes);
    const records: TradeRecord[] = [];
    for (const row of rows) {
      // A chosen dataset of another year would file its rows under this month: rows carry their year (2024 imports don't)
      if (row.year !== undefined && row.year !== null && Number(String(row.year).slice(0, 4)) !== year) continue;
      const request = requestOf(String(row.commodity_no ?? ''));
      if (request) records.push(toRecord(row, period, tradeType, request, d.id));
    }
    return new Map(records.length ? [[period, records]] : []);
  },
};
