import { BulkDownload, Country, CountrySource, DatasetRef, ExtractionMethod, isEnabled, isExtractable, listCountries, missingConfig, splitQueriesOf } from '../countries';
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
  /** Files the web app links to directly (nothing is fetched by the service), or null */
  bulkDownload: BulkDownload | null;
  /** False when nothing runs: download-only countries (bulkDownload links) and source-files countries */
  extractable: boolean;
  /**
   * Set for source-files countries: the web app asks for each month's file links
   * (GET /api/countries/:code/source-files) and downloads them straight from the source to the
   * user's device; nothing is stored on the service or in the database. Null otherwise.
   */
  sourceFiles: { description: string } | null;
  lagMonths: number;
  publishDay: number;
  /** Earliest month with data, or null when the source has no limit */
  startPeriod: string | null;
  tradeTypes: TradeFlow[];
  hsCodeHint: string;
  hsCodeCount: number;
  testHsCodeCount: number;
  /** Requests return every HS code: a run needs no saved list */
  allHsCodes: boolean;
  /** Datasets offered on the extract page to read instead of each year's own (none: the source has no datasets) */
  datasets: DatasetRef[];
  /**
   * Extraction methods offered on the extract page, the first being the default; the chosen id is
   * sent as `method` with POST /api/extractions. Empty: the country has one way, no picker.
   */
  methods: ExtractionMethod[];
  /** The source's own limits (null: the service's setting applies) */
  concurrency: number | null;
  rateLimitPerMinute: number;
  retryDelayMs: number | null;
  /**
   * Requests one flow takes for one month and for a whole calendar year, with the saved codes of
   * each data set (null: nothing is extracted). A year costing less than 12 months means the source
   * returns several months per request, so whole years are the cheapest range to ask for.
   */
  requests: { complete: RequestCost; test: RequestCost } | null;
}

export interface RequestCost {
  month: number;
  year: number;
}

const SAMPLE_YEAR = Array.from({ length: 12 }, (_, i) => `2020-${String(i + 1).padStart(2, '0')}`);

/** Requests for one month and for a year of `codes`, split as a run would split them */
function requestCost(country: Country, codes: string[]): RequestCost {
  const valid = [...new Set(codes.map((c) => country.normalizeHsCode?.(c)).filter((c): c is string => Boolean(c)))].sort();
  const split = splitQueriesOf(country);
  const flow = country.tradeTypes[0];
  return { month: split(valid, SAMPLE_YEAR.slice(0, 1), flow).length, year: split(valid, SAMPLE_YEAR, flow).length };
}

function describe(country: Country): ExtractorInfo {
  return {
    code: country.code,
    name: country.name,
    enabled: isEnabled(country),
    missingConfig: missingConfig(country),
    source: country.source,
    bulkDownload: country.bulkDownload ?? null,
    extractable: isExtractable(country),
    sourceFiles: country.sourceFiles ? { description: country.sourceFiles.description } : null,
    lagMonths: country.lagMonths,
    publishDay: country.publishDay ?? 1,
    startPeriod: country.startPeriod ?? null,
    tradeTypes: country.tradeTypes,
    hsCodeHint: country.hsCodeHint,
    hsCodeCount: hsCodesService.getSaved(country.code, 'complete').length,
    testHsCodeCount: hsCodesService.hasTestFile(country.code) ? hsCodesService.getSaved(country.code, 'test').length : 0,
    allHsCodes: Boolean(country.allHsCodes),
    datasets: country.datasets ?? [],
    methods: country.methods ?? [],
    concurrency: country.concurrency ?? null,
    rateLimitPerMinute: country.rateLimitPerMinute ?? 60,
    retryDelayMs: country.retryDelayMs ?? null,
    requests: isExtractable(country)
      ? {
          complete: requestCost(country, hsCodesService.getSaved(country.code, 'complete')),
          test: requestCost(country, hsCodesService.hasTestFile(country.code) ? hsCodesService.getSaved(country.code, 'test') : []),
        }
      : null,
  };
}

export const registryService = {
  list: (): ExtractorInfo[] => listCountries().map(describe),

  /** Publishes the extractors to the database for the web app */
  sync: (): Promise<void> => db.syncExtractors(registryService.list()),
};
