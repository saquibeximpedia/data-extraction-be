import { Country } from './country.types';
import { indonesia } from './indonesia';
import { thailand } from './thailand';

export type { Country, FetchQuery } from './country.types';

/** Every supported country. To add one: create its file in this folder and list it here. */
const ALL_COUNTRIES: Country[] = [indonesia, thailand];

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

export function isEnabled(country: Country): boolean {
  return missingConfig(country).length === 0;
}

export function enabledCountries(): Country[] {
  return ALL_COUNTRIES.filter(isEnabled);
}
