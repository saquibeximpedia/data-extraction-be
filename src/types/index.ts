export type TradeFlow = 'IMPORT' | 'EXPORT';

/** Calendar month in "YYYY-MM" form */
export type Period = string;

/**
 * One row exactly as the source returned it. API sources add the request's context
 * (HS code, flow) in front when the response doesn't carry it. Nothing is renamed or
 * filtered: exports write these fields as columns, and filtering happens downstream.
 */
export type TradeRecord = Record<string, unknown>;

/** One unit of work: a single HS code, month and trade flow for one country */
export interface TaskKey {
  countryCode: string;
  hsCode: string;
  period: Period;
  tradeType: TradeFlow;
}

/**
 * COMPLETED - source returned rows
 * NO_DATA   - source returned 0 rows; final (it is not retried unless forced)
 * FAILED    - request errored; retried by the next run
 */
export type TaskStatus = 'IN_PROGRESS' | 'COMPLETED' | 'NO_DATA' | 'FAILED';

export interface ExtractionTask extends TaskKey {
  id: string;
  status: TaskStatus;
  attempts: number;
  recordsExtracted: number;
  error?: string;
  lastRunId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** SCHEDULED and AUTO_SYNC_API only appear on runs recorded before the scheduler was removed */
export type RunTrigger = 'SCHEDULED' | 'AUTO_SYNC_API' | 'MANUAL_EXTRACT';
export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'STOPPED';

export interface RunLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

/**
 * Something about a run that needs a person to check it.
 * EMPTY_STREAK - a long unbroken stretch of tasks returned 0 records
 * EMPTY_MONTH  - a whole month returned 0 records (not published yet, or nothing came back)
 */
export interface RunFlag {
  countryCode: string;
  kind: 'EMPTY_STREAK' | 'EMPTY_MONTH';
  message: string;
  at: string;
}

export interface RunStats {
  /** Every task the run covers (including skipped), for progress */
  planned: number;
  completed: number;
  noData: number;
  failed: number;
  skipped: number;
  flags: RunFlag[];
  /** Kept for runs recorded before flags existed */
  unpublishedPeriods: Record<string, Period[]>;
  /** HS codes the country's adapter rejected, per country */
  invalidHsCodes: Record<string, string[]>;
  files: string[];
}

export interface ExtractionRun {
  id: string;
  trigger: RunTrigger;
  status: RunStatus;
  params: Record<string, any>;
  stats: RunStats;
  logs?: RunLog[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}
