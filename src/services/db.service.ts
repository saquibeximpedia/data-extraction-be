import crypto from 'crypto';
import { supabase } from '../config/supabase';
import { ExtractionRun, Period, RunStats, RunStatus, RunTrigger } from '../types';
import { HttpError } from '../utils/errors';

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

/** 'extracting' once an extraction starts for the month; users mark it 'completed' */
export type MonthStatus = 'extracting' | 'completed';

export interface MonthMark {
  period: Period;
  status: MonthStatus;
  markedBy: string;
  markedAt: string;
}

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

const toConfig = (row: any): CountryConfig => ({ ...row.data, code: row.code, kind: row.kind, updatedAt: row.updated_at, updatedBy: row.updated_by ?? undefined });

/** Runs, country details and month status, in Supabase Postgres (see supabase/schema.sql) */
export const db = {
  /** Fails with a clear message when the tables are missing */
  async check(): Promise<void> {
    for (const table of ['runs', 'country_config', 'month_status']) {
      // Not a head request: those report a missing table as success
      await result(supabase.from(table).select('*').limit(1), `table ${table}`);
    }
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

  async listRuns(limit: number): Promise<ExtractionRun[]> {
    const { data } = await result(supabase.from('runs').select('*').order('started_at', { ascending: false }).limit(limit), 'list runs');
    return data.map(toRun);
  },

  /** At boot: runs still marked running were cut off by a restart */
  async recoverInterrupted(): Promise<number> {
    const query = supabase
      .from('runs')
      .update({ status: 'INTERRUPTED', error: 'Server restarted mid-run', finished_at: new Date().toISOString() }, { count: 'exact' })
      .eq('status', 'RUNNING');
    return (await result(query, 'recover runs')).count;
  },

  /** When each country was last extracted */
  async lastExtractionByCountry(): Promise<Map<string, string>> {
    const { data } = await result(supabase.from('runs').select('params, started_at').order('started_at', { ascending: false }).limit(500), 'last runs');
    const out = new Map<string, string>();
    for (const row of data) {
      for (const plan of row.params?.plans ?? []) if (plan.countryCode && !out.has(plan.countryCode)) out.set(plan.countryCode, row.started_at);
    }
    return out;
  },

  // ---------------------------------------------------------------- countries

  async listCountryConfigs(): Promise<CountryConfig[]> {
    return (await result(supabase.from('country_config').select('*'), 'list countries')).data.map(toConfig);
  },

  async getCountryConfig(code: string): Promise<CountryConfig | null> {
    const { data } = await result(supabase.from('country_config').select('*').eq('code', code).maybeSingle(), 'get country');
    return data ? toConfig(data) : null;
  },

  async saveCountryConfig(config: CountryConfig, updatedBy: string): Promise<void> {
    const { code, kind, updatedAt: _a, updatedBy: _b, ...data } = config;
    const row = { code, kind, data, updated_at: new Date().toISOString(), updated_by: updatedBy };
    await result(supabase.from('country_config').upsert(row), 'save country');
  },

  /** Deletes a country's details and month status (download-only countries) */
  async deleteCountryConfig(code: string): Promise<void> {
    await result(supabase.from('month_status').delete().eq('country_code', code), 'delete months');
    await result(supabase.from('country_config').delete().eq('code', code), 'delete country');
  },

  // ---------------------------------------------------------------- months

  /** Every marked month, per country, oldest first */
  async listMonths(): Promise<Map<string, MonthMark[]>> {
    const { data } = await result(supabase.from('month_status').select('*').order('period'), 'list months');
    const out = new Map<string, MonthMark[]>();
    for (const row of data) {
      const list = out.get(row.country_code) ?? [];
      list.push({ period: row.period, status: row.status, markedBy: row.marked_by, markedAt: row.marked_at });
      out.set(row.country_code, list);
    }
    return out;
  },

  /** Sets the months' status; months already in it keep who marked them. Returns how many changed. */
  async markMonths(countryCode: string, periods: Period[], markedBy: string, status: MonthStatus = 'completed'): Promise<number> {
    const { data } = await result(supabase.from('month_status').select('period, status').eq('country_code', countryCode).in('period', periods), 'read months');
    const current = new Map(data.map((r) => [r.period, r.status]));
    const changed = periods.filter((p) => current.get(p) !== status);
    if (!changed.length) return 0;
    const markedAt = new Date().toISOString();
    const rows = changed.map((period) => ({ country_code: countryCode, period, status, marked_by: markedBy, marked_at: markedAt }));
    await result(supabase.from('month_status').upsert(rows), 'mark months');
    return changed.length;
  },

  /** Clears the months' status (files are kept). Returns how many were removed. */
  async unmarkMonths(countryCode: string, periods: Period[]): Promise<number> {
    const query = supabase.from('month_status').delete({ count: 'exact' }).eq('country_code', countryCode).in('period', periods);
    return (await result(query, 'remove months')).count;
  },
};
