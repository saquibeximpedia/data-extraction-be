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

export interface LedgerSummary {
  totalTasks: number;
  byStatus: Record<TaskStatus, number>;
  countriesCount: number;
  latestRun?: { id: string; status: RunStatus; startedAt: string };
}

export function emptyStats(): RunStats {
  return { planned: 0, completed: 0, noData: 0, failed: 0, skipped: 0, unpublishedPeriods: {}, invalidHsCodes: {}, files: [] };
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
`;

/**
 * SQLite-backed ledger (node:sqlite, no extra dependency).
 *
 * - tasks:         one row per (country, HS code, month, flow) with its latest status
 * - runs:          one row per scheduler / API run with live stats
 * - trade_records: normalized rows, replaced whenever a task is re-extracted,
 *                  used to rebuild the per-country-month export files
 */
export class LedgerService {
  private db: DatabaseSync;

  constructor(dbPath: string = env.resolvedDbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
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

  public getTask(id: string): ExtractionTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
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

  public listTasks(
    filter: { countryCode?: string; status?: TaskStatus; period?: Period; hsCode?: string } = {},
    limit = 500
  ): ExtractionTask[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.countryCode) { clauses.push('country_code = ?'); params.push(filter.countryCode.toUpperCase()); }
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    if (filter.period) { clauses.push('period = ?'); params.push(filter.period); }
    if (filter.hsCode) { clauses.push('hs_code = ?'); params.push(filter.hsCode); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit)
      .map(toTask);
  }

  public countCompleted(countryCode: string, period: Period): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE country_code = ? AND period = ? AND status = 'COMPLETED'`)
      .get(countryCode, period) as { n: number };
    return Number(row.n);
  }

  /** COMPLETED task counts per month for exactly these codes and flows */
  public countCompletedByPeriod(countryCode: string, periods: Period[], hsCodes: string[], tradeTypes: string[]): Record<Period, number> {
    if (!periods.length || !hsCodes.length || !tradeTypes.length) return {};
    const marks = (n: number) => Array(n).fill('?').join(',');
    const rows = this.db
      .prepare(
        `SELECT period, COUNT(*) AS n FROM tasks
         WHERE country_code = ? AND status = 'COMPLETED'
           AND period IN (${marks(periods.length)})
           AND hs_code IN (${marks(hsCodes.length)})
           AND trade_type IN (${marks(tradeTypes.length)})
         GROUP BY period`
      )
      .all(countryCode, ...periods, ...hsCodes, ...tradeTypes) as { period: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.period, Number(r.n)]));
  }

  /** Task counts by status for every month a country has been extracted */
  public periodSummary(countryCode: string): Record<Period, { completed: number; noData: number; failed: number }> {
    const rows = this.db
      .prepare(`SELECT period, status, COUNT(*) AS n FROM tasks WHERE country_code = ? GROUP BY period, status`)
      .all(countryCode) as { period: string; status: TaskStatus; n: number }[];
    const out: Record<Period, { completed: number; noData: number; failed: number }> = {};
    for (const r of rows) {
      const entry = (out[r.period] ??= { completed: 0, noData: 0, failed: 0 });
      if (r.status === 'COMPLETED') entry.completed += Number(r.n);
      else if (r.status === 'NO_DATA') entry.noData += Number(r.n);
      else if (r.status === 'FAILED') entry.failed += Number(r.n);
    }
    return out;
  }

  public getRecords(countryCode: string, period: Period): TradeRecord[] {
    return this.db
      .prepare('SELECT record FROM trade_records WHERE country_code = ? AND period = ? ORDER BY trade_type, hs_code, rowid')
      .all(countryCode, period)
      .map((row: any) => JSON.parse(row.record));
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

  public getSummary(): LedgerSummary {
    const byStatus: Record<TaskStatus, number> = { IN_PROGRESS: 0, COMPLETED: 0, NO_DATA: 0, FAILED: 0 };
    let totalTasks = 0;
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as any[]) {
      byStatus[row.status as TaskStatus] = Number(row.n);
      totalTasks += Number(row.n);
    }
    const countries = this.db.prepare('SELECT COUNT(DISTINCT country_code) AS n FROM tasks').get() as { n: number };
    const latest = this.db.prepare('SELECT id, status, started_at FROM runs ORDER BY started_at DESC LIMIT 1').get() as any;

    return {
      totalTasks,
      byStatus,
      countriesCount: Number(countries.n),
      latestRun: latest ? { id: latest.id, status: latest.status, startedAt: latest.started_at } : undefined,
    };
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
