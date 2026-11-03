import { DatasetRef, FetchQuery } from './country.types';
import { Period, TradeFlow } from '../types';
import { getJson } from '../utils/http';

/** A dataset's fields as the portal describes them (name and type: text, int, double, date…) */
export type DatasetFields = { name: string; type: string }[];

/** A wrong dataset ID fails with a message naming it */
const explain404 = (apiBase: string, id: string) => (err: Error) => {
  throw /HTTP 404/.test(err.message) ? new Error(`Dataset "${id}" is not on ${new URL(apiBase).host}; check the ID (the last part of the dataset's link)`) : err;
};

/** A year no dataset covers fails the request, so it isn't mistaken for a month without trade */
export const noDataset = (apiBase: string, flow: TradeFlow, year: number, alsoTitle = false) =>
  new Error(
    `No ${flow} dataset for ${year} on ${new URL(apiBase).host}${alsoTitle ? ' (none titled for that year either)' : ''}; ` +
      'pick or enter its dataset under Dataset on the extract page'
  );

/** The built-in dataset holding a flow's year */
export const pickDataset = (builtIn: DatasetRef[], flow: TradeFlow, year: number): DatasetRef | undefined =>
  builtIn.find((d) => d.flow === flow && year >= d.from && year <= d.to);

const fieldsCache = new Map<string, Promise<DatasetFields>>();

/** A dataset's fields, read once per dataset */
export function datasetFields(apiBase: string, id: string, signal?: AbortSignal): Promise<DatasetFields> {
  const key = `${apiBase}/${id}`;
  let found = fieldsCache.get(key);
  if (!found) {
    found = getJson<{ fields: DatasetFields }>(`${apiBase}/catalog/datasets/${encodeURIComponent(id)}`, { source: new URL(apiBase).host, signal })
      .then((d) => d.fields.map(({ name, type }) => ({ name, type })))
      .catch(explain404(apiBase, id));
    found.catch(() => fieldsCache.delete(key));
    fieldsCache.set(key, found);
  }
  return found;
}

/**
 * Every row of a dataset matching `where`, in one request. The export endpoint has no row limit;
 * the records endpoint stops at 100 rows a page and 10,000 in all, too few for a month.
 */
export function exportRows(apiBase: string, id: string, where: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const url = `${apiBase}/catalog/datasets/${encodeURIComponent(id)}/exports/json?${new URLSearchParams({ where })}`;
  return getJson<Record<string, unknown>[]>(url, { source: new URL(apiBase).host, signal, timeoutMs: 180_000 })
    .catch(explain404(apiBase, id))
    .catch(async (err: Error) => {
      // A filter the portal can't run (e.g. a field the dataset lacks): its own message says why
      if (!/HTTP 400/.test(err.message)) throw err;
      const body = await fetch(url, { signal }).then((r) => r.json() as Promise<{ message?: string }>, () => ({}) as { message?: string });
      throw new Error(`${new URL(apiBase).host} refused the filter on ${id}: ${body.message ?? err.message} (filter: ${where})`);
    });
}

/** One request per flow and month; the HS codes ride along to keep only those rows (none = every code) */
export const perMonth = (hsCodes: string[], periods: Period[], tradeType: TradeFlow): FetchQuery[] =>
  periods.map((period) => ({ hsCodes, periods: [period], tradeType }));

/**
 * For each row's code, the requested code it falls under (the longest that matches), or the row's
 * own code when none were requested; undefined drops the row
 */
export function requestMatcher(hsCodes: string[]): (code: string) => string | undefined {
  if (!hsCodes.length) return (code) => code;
  const longestFirst = [...hsCodes].sort((a, b) => b.length - a.length);
  return (code) => longestFirst.find((c) => code.startsWith(c));
}

/**
 * The dataset a request reads: the one chosen on the extract page (a listed one keeps its years, so
 * a several-year dataset is still filtered by year), else `fallback` (the year's own)
 */
export function chosenDataset(listed: DatasetRef[], chosen: string | undefined, flow: TradeFlow, year: number, fallback: DatasetRef | undefined): DatasetRef | undefined {
  if (!chosen) return fallback;
  return listed.find((d) => d.id === chosen) ?? { flow, from: year, to: year, id: chosen };
}
