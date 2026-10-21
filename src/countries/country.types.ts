import { Period, TradeFlow, TradeRecord } from '../types';

/** One unit of work handed to a country: a single HS code, month and trade flow */
export interface FetchQuery {
  hsCode: string; // already normalized by the country
  period: Period; // "YYYY-MM"
  tradeType: TradeFlow;
}

/**
 * Everything the app needs to know about one country's data source.
 *
 * To add a country, create a file in this folder exporting one of these and add it
 * to the list in countries/index.ts. Retries, rate limiting, scheduling, storage
 * and exports are handled for you.
 */
export interface Country {
  /** ISO 3166 alpha-3, e.g. "THA" */
  code: string;
  name: string;
  /** Months between the end of a month and the source publishing it */
  lagMonths: number;
  /** Day of the month the source usually publishes on (default 1) */
  publishDay?: number;
  /** Flows this source can return */
  tradeTypes: TradeFlow[];
  /** Env vars that must be set; the country stays disabled until they are */
  requiredEnv?: string[];
  /** Max requests per minute to the source (default 60) */
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
