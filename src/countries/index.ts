import { Country, ExtractableCountry, FetchQuery } from './country.types';
import { Period, TradeFlow } from '../types';
import { bahrain } from './bahrain';
import { brazil } from './brazil';
import { chile } from './chile';
import { eu } from './eu';
import { indonesia } from './indonesia';
import { japan } from './japan';
import { kazakhstan } from './kazakhstan';
import { korea } from './korea';
import { mexico } from './mexico';
import { morocco } from './morocco';
import { philippines } from './philippines';
import { qatar } from './qatar';
import { southAfrica } from './south-africa';
import { thailand } from './thailand';
import { turkey } from './turkey';

export type { BulkDownload, Country, CountrySource, DatasetRef, ExtractableCountry, ExtractionMethod, FetchContext, FetchQuery, MonthRows, SourceFile, SourceFiles, SourceLink, YearFile } from './country.types';

/** Every supported country. To add one: create its file in this folder and list it here. */
const ALL_COUNTRIES: Country[] = [bahrain, brazil, chile, eu, indonesia, japan, kazakhstan, korea, mexico, morocco, philippines, qatar, thailand, southAfrica, turkey];

const byCode = new Map(ALL_COUNTRIES.map((c) => [c.code, c]));

export function listCountries(): Country[] {
  return ALL_COUNTRIES;
}

export function findCountry(code: string): Country | undefined {
  return byCode.get(code.toUpperCase());
}

/** Env vars a country still needs before it can run */
export function missingConfig(country: Country): string[] {
  return (country.requiredEnv ?? []).filter((key) => !process.env[key]);
}

/** Rows are extracted into CSVs and stored (not a source-files or download-only country) */
export function isExtractable(country: Country): country is ExtractableCountry {
  return Boolean(country.normalizeHsCode && country.fetchRecords);
}

/** The service looks up each month's files; the user's browser downloads them straight from the source */
export function hasSourceFiles(country: Country): country is Country & Required<Pick<Country, 'sourceFiles'>> {
  return Boolean(country.sourceFiles);
}

/** Default split: one request per HS code and month */
const perCodeAndMonth = (hsCodes: string[], periods: Period[], tradeType: TradeFlow): FetchQuery[] =>
  hsCodes.flatMap((code) => periods.map((period) => ({ hsCodes: [code], periods: [period], tradeType })));

/** How a run's codes and months become requests for this country */
export const splitQueriesOf = (country: Country) => country.splitQueries ?? perCodeAndMonth;

export function isEnabled(country: Country): boolean {
  return missingConfig(country).length === 0;
}

