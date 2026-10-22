import { Period, TradeFlow, TradeRecord } from '../types';

/** One unit of work handed to a country: a single HS code, month and trade flow */
export interface FetchQuery {
  hsCode: string; // already normalized by the country
  period: Period; // "YYYY-MM"
  tradeType: TradeFlow;
  /** Every month this run asks of the country (ascending), so batch sources can fetch them together */
  runPeriods: Period[];
}

/**
 * Everything the app needs to know about one country's data source.
 *
 * To add a country, create a file in this folder exporting one of these and add it
 * to the list in countries/index.ts. Retries, rate limiting, scheduling, storage
 * and exports are handled for you.
 */
/** Where a country's data comes from, shown to users before they extract */
export interface CountrySource {
  /** e.g. "SARS Trade Statistics portal" */
  name: string;
  /** Page a person can open to see the source */
  url: string;
  /** What is requested, e.g. the endpoint or form */
  endpoint: string;
  /** How data is fetched and what one request returns */
  method: string;
  /** What the saved files contain */
  output: string;
}

export interface Country {
  /** ISO 3166 alpha-3, e.g. "THA" */
  code: string;
  name: string;
  source: CountrySource;
  /** Default months between the end of a month and the source publishing it (editable in Properties) */
  lagMonths: number;
  /** Day of the month the source usually publishes on (default 1) */
  publishDay?: number;
  /** Flows this source can return */
  tradeTypes: TradeFlow[];
  /** One line on which HS codes the source accepts, shown under the code box */
  hsCodeHint: string;
  /** Env vars that must be set; the country stays disabled until they are */
  requiredEnv?: string[];
  /** Max fetchRecords calls per minute (default 60; 0 = no limit, for sources that throttle themselves) */
  rateLimitPerMinute?: number;

  /** Returns the code as the source expects it, or null if the source can't use it */
  normalizeHsCode(raw: string): string | null;

  /**
   * Fetches one HS code / month / flow and returns normalized records.
   * Return [] when the month isn't published yet or there was no trade.
   * Throw RetryableError (or use getJson) for temporary failures so they are retried.
   */
  fetchRecords(query: FetchQuery): Promise<TradeRecord[]>;
}
