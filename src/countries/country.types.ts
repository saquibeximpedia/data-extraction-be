import { Period, TradeFlow, TradeRecord } from '../types';

/** One request to a source: some HS codes (normalized) and months for one flow */
export interface FetchQuery {
  hsCodes: string[];
  periods: Period[];
  tradeType: TradeFlow;
}

/** Rows per month; months without rows can be left out */
export type MonthRows = Map<Period, TradeRecord[]>;

/** One flow's years `from`–`to` in one dataset of an open-data portal */
export interface DatasetRef {
  flow: TradeFlow;
  from: number;
  to: number;
  /** The dataset's ID, the last part of its link on the portal */
  id: string;
}

/** What the engine hands each request besides the query */
export interface FetchContext {
  /** A dataset ID chosen on the extract page for this run (one flow), read instead of each year's dataset */
  dataset?: string;
  /** Adds a line to the run's log, e.g. a retry the country handles itself */
  log?(level: 'info' | 'warn', message: string): void;
}

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

/** A page about the source's data, e.g. where its imports are published */
export interface SourceLink {
  label: string;
  url: string;
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
  /** More pages about the data, e.g. the imports and exports pages (shown beside the source) */
  links?: SourceLink[];
}

/** One file of a month and flow, as the source publishes it */
export interface SourceFile {
  /** The file's own name, e.g. "importaciones-septiembre-2026.rar" */
  name: string;
  url: string;
}

/**
 * A source that serves each month as ready-made files (archives, workbooks…) whose links can't be
 * built from a pattern: the service only looks up the month's links, and the user's browser
 * downloads the files straight from the source to their device. Nothing is extracted, stored on
 * the service or saved to the database; that is for API countries only.
 */
export interface SourceFiles {
  /** What the files hold, shown on the extract page */
  description: string;
  /** The month's files for one flow; none when the month isn't published yet */
  list(period: Period, flow: TradeFlow, signal: AbortSignal): Promise<SourceFile[]>;
}

/**
 * One country's data source. To add one, create a file in this folder exporting one of these
 * and list it in countries/index.ts; retries, concurrency, logs and files are handled by the engine.
 * A country is one of three kinds:
 * - extracted: normalizeHsCode and fetchRecords; rows are written as CSVs (split at 9 lakh rows)
 * - source files: sourceFiles; the service finds each month's file links, the browser downloads them to the user's device
 * - download-only: neither; it offers its bulkDownload links and nothing runs
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
  /** Wait before the first retry of a failed request, doubled for each next one (default RETRY_DELAY_MS) */
  retryDelayMs?: number;

  /** Monthly files users can download straight from the source, besides extracting */
  bulkDownload?: BulkDownload;

  /** Each month's file links, downloaded by the user's browser straight from the source (nothing runs or is stored) */
  sourceFiles?: SourceFiles;

  /**
   * Each request returns every HS code the source has (whole months), so no list is needed: a run
   * without codes takes them all, and entered codes only keep those
   */
  allHsCodes?: boolean;

  /**
   * The source's datasets, offered on the extract page to read instead of each year's own (any
   * other ID can be entered there too); fetchRecords reads the choice from `context.dataset`
   */
  datasets?: DatasetRef[];

  /** The code as the source expects it, or null if the source can't use it */
  normalizeHsCode?(raw: string): string | null;

  /** Splits a run into requests (default: one per HS code and month) */
  splitQueries?(hsCodes: string[], periods: Period[], tradeType: TradeFlow): FetchQuery[];

  /**
   * Fetches one request. Unpublished months and months without trade come back empty.
   * Throw RetryableError (or use getJson) for temporary failures so they are retried.
   * `signal` aborts when the run is stopped: pass it to fetch (or getJson) so the request is cancelled.
   */
  fetchRecords?(query: FetchQuery, signal: AbortSignal, context: FetchContext): Promise<MonthRows>;
}

/** A country the engine can extract (not download-only) */
export type ExtractableCountry = Country & Required<Pick<Country, 'normalizeHsCode' | 'fetchRecords'>>;
