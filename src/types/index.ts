export type TradeFlow = 'IMPORT' | 'EXPORT';

/** Calendar month, "YYYY-MM" */
export type Period = string;

/**
 * One row exactly as the source returned it; API sources put the requested HS code and flow in
 * front when the response doesn't carry them. Exports write these fields as columns.
 */
export type TradeRecord = Record<string, unknown>;

export type RunTrigger = 'MANUAL_EXTRACT';
export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'STOPPED';

export interface RunLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

/**
 * Something about a run that needs a person to check it.
 * EMPTY_STREAK - a long unbroken stretch of requests returned 0 records
 * EMPTY_MONTH  - a month returned no records (not published yet, or nothing came back)
 */
export interface RunFlag {
  countryCode: string;
  kind: 'EMPTY_STREAK' | 'EMPTY_MONTH';
  message: string;
  at: string;
}

/** Counts are source requests (an HS code and month, or a whole batch, depending on the country) */
export interface RunStats {
  planned: number;
  completed: number;
  noData: number;
  failed: number;
  skipped: number;
  /** Rows the source returned */
  records?: number;
  flags: RunFlag[];
  /** HS codes the country rejected */
  invalidHsCodes: Record<string, string[]>;
  files: string[];
}

export interface ExtractionRun {
  id: string;
  trigger: RunTrigger;
  status: RunStatus;
  params: Record<string, any>;
  stats: RunStats;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}
