import { Country, ExtractableCountry } from './country.types';
import { bahrain } from './bahrain';
import { eu } from './eu';
import { indonesia } from './indonesia';
import { japan } from './japan';
import { philippines } from './philippines';
import { qatar } from './qatar';
import { southAfrica } from './south-africa';
import { thailand } from './thailand';
import { turkey } from './turkey';

export type { BulkDownload, Country, CountrySource, DatasetRef, ExtractableCountry, FetchContext, FetchQuery, MonthRows, YearFile } from './country.types';

/** Every supported country. To add one: create its file in this folder and list it here. */
const ALL_COUNTRIES: Country[] = [bahrain, eu, indonesia, japan, philippines, qatar, thailand, southAfrica, turkey];

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

/** False for download-only countries (bulk download links, nothing to extract) */
export function isExtractable(country: Country): country is ExtractableCountry {
  return Boolean(country.normalizeHsCode && country.fetchRecords);
}

export function isEnabled(country: Country): boolean {
  return missingConfig(country).length === 0;
}

