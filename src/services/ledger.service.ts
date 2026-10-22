import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  ExtractionRun,
  ExtractionTask,
  Period,
  RunStats,
  RunStatus,
  RunTrigger,
  TaskKey,
  TaskStatus,
  TradeRecord,
} from '../types';
import { env } from '../config/env';

export function emptyStats(): RunStats {
  return { planned: 0, completed: 0, noData: 0, failed: 0, skipped: 0, flags: [], unpublishedPeriods: {}, invalidHsCodes: {}, files: [] };
}

/** Admin-edited details of a country: overrides for a built-in source, or a whole download-only country */
export interface CountryConfig {
  code: string;
  kind: 'api' | 'manual';
  name?: string;
  sourceName?: string;
  sourceUrl?: string;
  endpoint?: string;
  method?: string;
  output?: string;
  /** Instructions shown to users, e.g. where on the site the files are */
  notes?: string;
  lagMonths?: number;
  publishDay?: number;
  updatedAt?: string;
  updatedBy?: string;
}

/** A month a user marked as completed for a country */
export interface CompletedMonth {
  period: Period;
  markedBy: string;
  markedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  params TEXT NOT NULL,
  stats TEXT NOT NULL,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  hs_code TEXT NOT NULL,
  period TEXT NOT NULL,
  trade_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  records_extracted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  last_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (country_code, hs_code, period, trade_type)
);
CREATE INDEX IF NOT EXISTS idx_tasks_country_period ON tasks (country_code, period);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);

CREATE TABLE IF NOT EXISTS trade_records (
  country_code TEXT NOT NULL,
  hs_code TEXT NOT NULL,
  period TEXT NOT NULL,
  trade_type TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_task ON trade_records (country_code, hs_code, period, trade_type);
CREATE INDEX IF NOT EXISTS idx_records_country_period ON trade_records (country_code, period);

-- Country details edited by admins (overrides for built-in sources, or download-only countries)
CREATE TABLE IF NOT EXISTS country_config (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- Months users marked as completed; extraction results never mark a month on their own
CREATE TABLE IF NOT EXISTS completed_months (
  country_code TEXT NOT NULL,
  period TEXT NOT NULL,
  marked_by TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (country_code, period)
);
`;

/**
 * SQLite-backed ledger (node:sqlite, no extra dependency).
 *
 * - tasks:         one row per (country, HS code, month, flow) with its latest status
 * - runs:          one row per extraction run with live stats
 * - trade_records:    source rows, replaced whenever a task is re-extracted,
 *                     used to rebuild the per-country-month export files
 * - country_config:   admin-edited country details
 * - completed_months: months users marked as completed
 */
export class LedgerService {
  private db: DatabaseSync;

  constructor(dbPath: string = env.resolvedDbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Carries settings over from the previous registry tables (lag overrides, hand-added months), then drops them */
  private migrate(): void {
    const has = (table: string) => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    if (has('months')) {
      this.db.exec(`INSERT OR IGNORE INTO completed_months (country_code, period, marked_by, marked_at)
        SELECT country_code, period, 'earlier version', added_at FROM months WHERE origin = 'manual'`);
      this.db.exec('DROP TABLE months');
    }
    if (has('country_settings')) {
      for (const row of this.db.prepare('SELECT country_code, lag_months FROM country_settings WHERE lag_months IS NOT NULL').all() as any[]) {
        if (!this.getCountryConfig(row.country_code)) {
          this.saveCountryConfig({ code: row.country_code, kind: 'api', lagMonths: Number(row.lag_months) }, 'earlier version');
        }
      }
      this.db.exec('DROP TABLE country_settings');
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Called once at boot: anything still marked running was cut off by a restart.
   */
  public recoverInterrupted(): { runs: number; tasks: number } {
    const now = new Date().toISOString();
    const runs = this.db
      .prepare(`UPDATE runs SET status = 'INTERRUPTED', finished_at = ?, error = COALESCE(error, 'Server restarted mid-run') WHERE status = 'RUNNING'`)
      .run(now);
    const tasks = this.db
      .prepare(`UPDATE tasks SET status = 'FAILED', error = 'Interrupted by server restart', updated_at = ? WHERE status = 'IN_PROGRESS'`)
      .run(now);
    return { runs: Number(runs.changes), tasks: Number(tasks.changes) };
  }

  // ---------------------------------------------------------------- tasks

  public findTask(key: TaskKey): ExtractionTask | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE country_code = ? AND hs_code = ? AND period = ? AND trade_type = ?')
      .get(key.countryCode, key.hsCode, key.period, key.tradeType);
    return row ? toTask(row) : null;
  }

  /** Marks a task IN_PROGRESS (creating it if new) and bumps its attempt count */
  public startTask(key: TaskKey, runId: string): ExtractionTask {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tasks (id, country_code, hs_code, period, trade_type, status, attempts, last_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS', 1, ?, ?, ?)
         ON CONFLICT (country_code, hs_code, period, trade_type) DO UPDATE SET
           status = 'IN_PROGRESS', attempts = attempts + 1, error = NULL, last_run_id = excluded.last_run_id, updated_at = excluded.updated_at`
      )
      .run(crypto.randomUUID(), key.countryCode, key.hsCode, key.period, key.tradeType, runId, now, now);
    return this.findTask(key)!;
  }

  /** Replaces the task's stored records and marks it COMPLETED, or NO_DATA when empty */
  public completeTask(task: ExtractionTask, records: TradeRecord[]): TaskStatus {
    const status: TaskStatus = records.length > 0 ? 'COMPLETED' : 'NO_DATA';
    const now = new Date().toISOString();

    this.transaction(() => {
      this.db
        .prepare('DELETE FROM trade_records WHERE country_code = ? AND hs_code = ? AND period = ? AND trade_type = ?')
        .run(task.countryCode, task.hsCode, task.period, task.tradeType);

      const insert = this.db.prepare(
        'INSERT INTO trade_records (country_code, hs_code, period, trade_type, record) VALUES (?, ?, ?, ?, ?)'
      );
      for (const record of records) {
        insert.run(task.countryCode, task.hsCode, task.period, task.tradeType, JSON.stringify(record));
      }

      this.db
        .prepare(
          `UPDATE tasks SET status = ?, records_extracted = ?, error = NULL, updated_at = ?,
             completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE completed_at END,
             attempts = 0 -- attempts counts consecutive failures only
           WHERE id = ?`
        )
        .run(status, records.length, now, status, now, task.id);
    });

    return status;
  }

  public failTask(task: ExtractionTask, error: string): void {
    this.db
      .prepare(`UPDATE tasks SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?`)
      .run(error, new Date().toISOString(), task.id);
  }

  public countCompleted(countryCode: string, period: Period): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE country_code = ? AND period = ? AND status = 'COMPLETED'`)
      .get(countryCode, period) as { n: number };
    return Number(row.n);
  }

  public countRecords(countryCode: string, period: Period): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM trade_records WHERE country_code = ? AND period = ?')
      .get(countryCode, period) as { n: number };
    return Number(row.n);
  }

  /**
   * Streams a country-month's rows, by flow then HS code. A row stored under two requested
   * codes (e.g. a heading and one of its tariff lines) comes back once.
   */
  public *iterateRecords(countryCode: string, period: Period): Generator<TradeRecord> {
    const rows = this.db
      .prepare(
        `SELECT record FROM trade_records WHERE country_code = ? AND period = ?
         GROUP BY record ORDER BY MIN(trade_type), MIN(hs_code), MIN(rowid)`
      )
      .iterate(countryCode, period) as Iterable<{ record: string }>;
    for (const row of rows) yield JSON.parse(row.record);
  }

  // ----------------------------------------------------------------- countries & months

  public getCountryConfig(code: string): CountryConfig | null {
    const row = this.db.prepare('SELECT * FROM country_config WHERE code = ?').get(code) as any;
    return row ? toConfig(row) : null;
  }

  public listCountryConfigs(): CountryConfig[] {
    return (this.db.prepare('SELECT * FROM country_config ORDER BY code').all() as any[]).map(toConfig);
  }

  public saveCountryConfig(config: CountryConfig, updatedBy: string): void {
    const { code, kind, updatedAt: _a, updatedBy: _b, ...data } = config;
    this.db
      .prepare(
        `INSERT INTO country_config (code, kind, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (code) DO UPDATE SET kind = excluded.kind, data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      )
      .run(code, kind, JSON.stringify(data), new Date().toISOString(), updatedBy);
  }

  /** Deletes a country's config and its completed months (used for download-only countries) */
  public deleteCountryConfig(code: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM country_config WHERE code = ?').run(code);
      this.db.prepare('DELETE FROM completed_months WHERE country_code = ?').run(code);
    });
  }

  /** Months marked completed, per country, oldest first */
  public listCompletedMonths(): Map<string, CompletedMonth[]> {
    const out = new Map<string, CompletedMonth[]>();
    for (const row of this.db.prepare('SELECT * FROM completed_months ORDER BY period').all() as any[]) {
      const list = out.get(row.country_code) ?? [];
      list.push({ period: row.period, markedBy: row.marked_by, markedAt: row.marked_at });
      out.set(row.country_code, list);
    }
    return out;
  }

  /** Marks months completed; months already marked keep who marked them first. Returns how many were new. */
  public markMonths(countryCode: string, periods: Period[], markedBy: string): number {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO completed_months (country_code, period, marked_by, marked_at) VALUES (?, ?, ?, ?)'
    );
    const now = new Date().toISOString();
    return this.transaction(() => periods.reduce((n, p) => n + Number(insert.run(countryCode, p, markedBy, now).changes), 0));
  }

  /** Unmarks months. Stored rows and files are not touched. Returns how many were removed. */
  public unmarkMonths(countryCode: string, periods: Period[]): number {
    const remove = this.db.prepare('DELETE FROM completed_months WHERE country_code = ? AND period = ?');
    return this.transaction(() => periods.reduce((n, p) => n + Number(remove.run(countryCode, p).changes), 0));
  }

  /** When each country was last extracted (latest run that included it) */
  public lastExtractionByCountry(): Map<string, string> {
    const out = new Map<string, string>();
    for (const row of this.db.prepare('SELECT params, started_at FROM runs ORDER BY started_at DESC LIMIT 500').all() as any[]) {
      for (const plan of JSON.parse(row.params).plans ?? []) {
        if (plan.countryCode && !out.has(plan.countryCode)) out.set(plan.countryCode, row.started_at);
      }
    }
    return out;
  }

  // ----------------------------------------------------------------- runs

  public createRun(trigger: RunTrigger, params: Record<string, any>): ExtractionRun {
    const run: ExtractionRun = {
      id: crypto.randomUUID(),
      trigger,
      status: 'RUNNING',
      params,
      stats: emptyStats(),
      startedAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO runs (id, trigger, status, params, stats, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(run.id, run.trigger, run.status, JSON.stringify(params), JSON.stringify(run.stats), run.startedAt);
    return run;
  }

  public saveRunStats(runId: string, stats: RunStats): void {
    this.db.prepare('UPDATE runs SET stats = ? WHERE id = ?').run(JSON.stringify(stats), runId);
  }

  public finishRun(runId: string, status: RunStatus, stats: RunStats, error?: string): void {
    this.db
      .prepare('UPDATE runs SET status = ?, stats = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, JSON.stringify(stats), error ?? null, new Date().toISOString(), runId);
  }

  public getRun(id: string): ExtractionRun | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? toRun(row) : null;
  }

  public listRuns(limit = 25): ExtractionRun[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit).map(toRun);
  }

  public close(): void {
    this.db.close();
  }
}

function toTask(row: any): ExtractionTask {
  return {
    id: row.id,
    countryCode: row.country_code,
    hsCode: row.hs_code,
    period: row.period,
    tradeType: row.trade_type,
    status: row.status,
    attempts: Number(row.attempts),
    recordsExtracted: Number(row.records_extracted),
    error: row.error ?? undefined,
    lastRunId: row.last_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function toRun(row: any): ExtractionRun {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    params: JSON.parse(row.params),
    stats: { ...emptyStats(), ...JSON.parse(row.stats) },
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

export const ledgerService = new LedgerService();

function toConfig(row: any): CountryConfig {
  return { ...JSON.parse(row.data), code: row.code, kind: row.kind, updatedAt: row.updated_at, updatedBy: row.updated_by ?? undefined };
}
