import { Period, TradeFlow, TradeRecord } from '../types';

/** One request to a source: some HS codes (normalized) and months for one flow */
export interface FetchQuery {
  hsCodes: string[];
  periods: Period[];
  tradeType: TradeFlow;
}

/** Rows per month; months without rows can be left out */
export type MonthRows = Map<Period, TradeRecord[]>;

/** One kind of yearly file (e.g. exports as CSV), for sources publishing a file per year */
export interface YearFile {
  /** Shown on the link, e.g. "Exports · CSV" */
  label: string;
  /** A finished year's file, with {YYYY} for the year */
  yearTemplate: string;
  /**
   * The current year's file, which covers January to its latest month and is renamed as months are
   * added: {YYYY} for the year and {MONTH} for that month in capitals, e.g. "SEPTEMBER"
   */
  partialTemplate: string;
}

/**
 * Files the source publishes for download, offered in the web app as direct links instead of
 * being extracted (nothing is fetched by the service): one per month (urlTemplate) or, with
 * per: 'year', one per year and kind (files)
 */
export interface BulkDownload {
  /** What the files hold, shown beside the links */
  description: string;
  /** 'month' (default): one file per month from urlTemplate; 'year': one file per year for each of `files` */
  per?: 'month' | 'year';
  /** A month's file, with {YYYYMM} for the month, e.g. ".../full_v2_{YYYYMM}.7z" */
  urlTemplate?: string;
  /** The files offered for each year (per: 'year') */
  files?: YearFile[];
  /** Where every published file is listed */
  listingUrl: string;
  source: CountrySource;
}

/** Where a country's data comes from, shown to users before they extract */
export interface CountrySource {
  name: string;
  url: string;
  /** What is requested, e.g. the endpoint or form */
  endpoint: string;
  /** How data is fetched */
  method: string;
  /** What the saved files contain */
  output: string;
}

/**
 * One country's data source. To add one, create a file in this folder exporting one of these
 * and list it in countries/index.ts; retries, concurrency, logs and files are handled by the engine.
 * A country without normalizeHsCode and fetchRecords is download-only: it offers its bulkDownload
 * links and can't be extracted.
 */
export interface Country {
  /** ISO 3166 alpha-3, e.g. "THA" */
  code: string;
  name: string;
  source: CountrySource;
  /** Default months between the end of a month and its publication (admins can change it) */
  lagMonths: number;
  /** Day of the month the source usually publishes on (default 1) */
  publishDay?: number;
  /** Earliest month ("YYYY-MM") the source has data for; earlier months are refused (admins can change it) */
  startPeriod?: Period;
  tradeTypes: TradeFlow[];
  /** Which HS codes the source accepts, shown under the code box */
  hsCodeHint: string;
  /** Env vars that must be set; the country stays disabled until they are */
  requiredEnv?: string[];
  /** Max requests per minute (default 60; 0 = no limit) */
  rateLimitPerMinute?: number;
  /** Max requests in flight at once (default MAX_CONCURRENT_PER_COUNTRY) */
  concurrency?: number;

  /** Monthly files users can download straight from the source, besides extracting */
  bulkDownload?: BulkDownload;

  /** The code as the source expects it, or null if the source can't use it */
  normalizeHsCode?(raw: string): string | null;

  /** Splits a run into requests (default: one per HS code and month) */
  splitQueries?(hsCodes: string[], periods: Period[], tradeType: TradeFlow): FetchQuery[];

  /**
   * Fetches one request. Unpublished months and months without trade come back empty.
   * Throw RetryableError (or use getJson) for temporary failures so they are retried.
   * `signal` aborts when the run is stopped: pass it to fetch (or getJson) so the request is cancelled.
   */
  fetchRecords?(query: FetchQuery, signal: AbortSignal): Promise<MonthRows>;
}

/** A country the engine can extract (not download-only) */
export type ExtractableCountry = Country & Required<Pick<Country, 'normalizeHsCode' | 'fetchRecords'>>;
