import { Country, CountrySource, isEnabled, listCountries, missingConfig } from '../countries';
import { TradeFlow } from '../types';
import { db } from './db.service';
import { hsCodesService } from './hs-codes.service';

/**
 * What this service can extract for one country. Stored in country_config.extractor on start-up
 * so the web app can show it while the service is offline; admins' edits stay in country_config.data.
 */
export interface ExtractorInfo {
  code: string;
  name: string;
  enabled: boolean;
  missingConfig: string[];
  source: CountrySource;
  lagMonths: number;
  publishDay: number;
  /** Earliest month with data, or null when the source has no limit */
  startPeriod: string | null;
  tradeTypes: TradeFlow[];
  hsCodeHint: string;
  hsCodeCount: number;
  testHsCodeCount: number;
}

function describe(country: Country): ExtractorInfo {
  return {
    code: country.code,
    name: country.name,
    enabled: isEnabled(country),
    missingConfig: missingConfig(country),
    source: country.source,
    lagMonths: country.lagMonths,
    publishDay: country.publishDay ?? 1,
    startPeriod: country.startPeriod ?? null,
    tradeTypes: country.tradeTypes,
    hsCodeHint: country.hsCodeHint,
    hsCodeCount: hsCodesService.getSaved(country.code, 'complete').length,
    testHsCodeCount: hsCodesService.hasTestFile(country.code) ? hsCodesService.getSaved(country.code, 'test').length : 0,
  };
}

export const registryService = {
  list: (): ExtractorInfo[] => listCountries().map(describe),

  /** Publishes the extractors to the database for the web app */
  sync: (): Promise<void> => db.syncExtractors(registryService.list()),
};
