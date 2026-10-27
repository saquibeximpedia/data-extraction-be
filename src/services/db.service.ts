import crypto from 'crypto';
import { supabase } from '../config/supabase';
import { ExtractionRun, Period, RunStats, RunStatus, RunTrigger } from '../types';
import { HttpError } from '../utils/errors';
import { isPeriod } from '../utils/period';
import type { ExtractorInfo } from './registry.service';

export const emptyStats = (): RunStats => ({ planned: 0, completed: 0, noData: 0, failed: 0, skipped: 0, records: 0, flags: [], invalidHsCodes: {}, files: [] });

/** Unwraps a Supabase result; a missing table usually means supabase/schema.sql hasn't been run */
async function result<T>(query: PromiseLike<{ data: T; error: { message: string } | null; count?: number | null }>, action: string) {
  const { data, error, count } = await query;
  if (error) throw new HttpError(502, `Database (${action}): ${error.message}`);
  // Without an error, lists are never null; maybeSingle() callers still check for a missing row
  return { data: data as NonNullable<T>, count: count ?? 0 };
}

const toRun = (row: any): ExtractionRun => ({
  id: row.id,
  trigger: row.trigger,
  status: row.status,
  params: row.params,
  stats: { ...emptyStats(), records: undefined, ...row.stats },
  error: row.error ?? undefined,
  startedAt: row.started_at,
  finishedAt: row.finished_at ?? undefined,
});

/**
 * What the extraction service writes to Supabase Postgres (see supabase/schema.sql): its runs,
 * the months it starts extracting, and its extractor list. Reading them back for people is the
 * web app's job.
 */
export const db = {
  /** Fails with a clear message when the tables or columns are missing */
  async check(): Promise<void> {
    await result(supabase.from('runs').select('id').limit(1), 'table runs');
    await result(supabase.from('month_status').select('period').limit(1), 'table month_status');
    await result(supabase.from('country_config').select('code, extractor').limit(1), 'table country_config');
  },

  // ---------------------------------------------------------------- runs

  async createRun(trigger: RunTrigger, params: Record<string, any>): Promise<ExtractionRun> {
    const run: ExtractionRun = { id: crypto.randomUUID(), trigger, status: 'RUNNING', params, stats: emptyStats(), startedAt: new Date().toISOString() };
    await result(supabase.from('runs').insert({ id: run.id, trigger, status: run.status, params, stats: run.stats, started_at: run.startedAt }), 'create run');
    return run;
  },

  async saveRun(id: string, fields: { status?: RunStatus; stats?: RunStats; error?: string; finished?: boolean }): Promise<void> {
    const { status, stats, error, finished } = fields;
    const row = { status, stats, error, finished_at: finished ? new Date().toISOString() : undefined };
    await result(supabase.from('runs').update(row).eq('id', id), 'save run');
  },

  async getRun(id: string): Promise<ExtractionRun | null> {
    const { data } = await result(supabase.from('runs').select('*').eq('id', id).maybeSingle(), 'get run');
    return data ? toRun(data) : null;
  },

  /** At boot: runs still marked running were cut off by a restart */
  async recoverInterrupted(): Promise<number> {
    const query = supabase
      .from('runs')
      .update({ status: 'INTERRUPTED', error: 'Extraction service restarted mid-run', finished_at: new Date().toISOString() }, { count: 'exact' })
      .eq('status', 'RUNNING');
    return (await result(query, 'recover runs')).count;
  },

  // ---------------------------------------------------------------- months

  /** Marks months as extracting when a run starts; completed months are left to people. Returns how many changed. */
  async markExtracting(countryCode: string, periods: Period[], markedBy: string): Promise<number> {
    const { data } = await result(supabase.from('month_status').select('period, status').eq('country_code', countryCode).in('period', periods), 'read months');
    const current = new Map(data.map((r) => [r.period, r.status]));
    const changed = periods.filter((p) => current.get(p) !== 'extracting');
    if (!changed.length) return 0;
    const markedAt = new Date().toISOString();
    const rows = changed.map((period) => ({ country_code: countryCode, period, status: 'extracting', marked_by: markedBy, marked_at: markedAt }));
    await result(supabase.from('month_status').upsert(rows), 'mark months');
    return changed.length;
  },

  // ---------------------------------------------------------------- extractors

  /** The earliest month an admin set for a country in the web app, if any */
  async startPeriodOverride(countryCode: string): Promise<Period | undefined> {
    const { data } = await result(supabase.from('country_config').select('data').eq('code', countryCode).maybeSingle(), 'read country');
    const value = (data as { data?: { startPeriod?: unknown } } | null)?.data?.startPeriod;
    return typeof value === 'string' && isPeriod(value) ? value : undefined;
  },

  /** Upserts only the extractor columns, so admins' edits in `data` are kept */
  async syncExtractors(list: ExtractorInfo[]): Promise<void> {
    const syncedAt = new Date().toISOString();
    const rows = list.map((info) => ({ code: info.code, kind: 'api', extractor: info, extractor_synced_at: syncedAt }));
    await result(supabase.from('country_config').upsert(rows, { onConflict: 'code' }), 'sync extractors');
  },
};
