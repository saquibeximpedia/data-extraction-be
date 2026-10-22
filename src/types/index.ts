export type TradeFlow = 'IMPORT' | 'EXPORT';

/** Calendar month in "YYYY-MM" form */
export type Period = string;

export interface TradeRecord {
  date: string; // YYYY-MM-DD
  hsCode: string;
  productDescription: string;
  tradeType: TradeFlow | 'UNKNOWN';
  importer?: string;
  exporter?: string;
  originCountry?: string;
  destinationCountry?: string;
  quantity?: number;
  unit?: string;
  valueUsd?: number;
  valueLocal?: number;
  currency?: string;
  port?: string;
  transportMode?: string;
  worldRegion?: string;
  declarationNo?: string;
  [customField: string]: any;
}

/** One unit of work: a single HS code, month and trade flow for one country */
export interface TaskKey {
  countryCode: string;
  hsCode: string;
  period: Period;
  tradeType: TradeFlow;
}

/**
 * COMPLETED - source returned rows
 * NO_DATA   - source returned nothing (not published yet, or no trade); retried by auto sync
 * FAILED    - request errored; retried until MAX_TASK_ATTEMPTS
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

export type RunTrigger = 'SCHEDULED' | 'AUTO_SYNC_API' | 'MANUAL_EXTRACT';
export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'STOPPED';

export interface RunLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface RunStats {
  /** Every task the run covers (including skipped), for progress */
  planned: number;
  completed: number;
  noData: number;
  failed: number;
  skipped: number;
  /** Periods where every attempted task came back empty, per country */
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
