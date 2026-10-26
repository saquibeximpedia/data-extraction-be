import { Country, FetchQuery, findCountry, isEnabled, missingConfig } from '../countries';
import { env } from '../config/env';
import { ExtractionRun, Period, RunFlag, RunLog, RunStats, RunTrigger, TradeFlow } from '../types';
import { RateLimiter, Semaphore } from '../utils/concurrency';
import { badRequest, conflict, notFound } from '../utils/errors';
import { splitHsInput } from '../utils/hs-codes';
import { withRetry } from '../utils/http';
import { periodRange, toPeriod } from '../utils/period';
import { db } from './db.service';
import { MonthFiles } from './export.service';
import { hsCodesService } from './hs-codes.service';

const MAX_MANUAL_MONTHS = 60;
const MAX_HS_CODES = 1000;
const SAVE_STATS_MS = 5000;

/** What to extract for one country within a run */
export interface CountryPlan {
  countryCode: string;
  periods: Period[];
  hsCodes: string[];
  tradeTypes: TradeFlow[];
  /** Where the HS codes came from, for the run's description */
  hsCodeSource: 'complete' | 'test' | 'custom';
}

export interface ManualRequest {
  countryCode: string;
  startDate: string;
  endDate: string;
  hsCodes?: string | string[];
  tradeType: 'ALL' | TradeFlow;
  mode?: 'complete' | 'test';
}

interface LiveRun {
  run: ExtractionRun;
  controller: AbortController;
  logs: RunLog[];
}

/** Default split: one request per HS code and month */
const perCodeAndMonth = (hsCodes: string[], periods: Period[], tradeType: TradeFlow): FetchQuery[] =>
  hsCodes.flatMap((code) => periods.map((period) => ({ hsCodes: [code], periods: [period], tradeType })));

const describeQuery = (q: FetchQuery) =>
  `${q.tradeType} ${q.periods.length > 1 ? `${q.periods[0]}…${q.periods[q.periods.length - 1]}` : q.periods[0]} ` +
  (q.hsCodes.length > 1 ? `${q.hsCodes.length} HS codes` : `HS ${q.hsCodes[0]}`);

/**
 * Runs extractions in the background. Each country splits a run into requests (an HS code and
 * month, or a whole batch for sources that return many at once); requests run in parallel within
 * the country's concurrency and rate limits, temporary errors are retried, and every month that
 * returned rows gets its CSV written to Storage when the country finishes (also when stopped).
 */
class ExtractionService {
  private globalLimit = new Semaphore(env.MAX_CONCURRENT_EXTRACTIONS);
  private countryLimits = new Map<string, Semaphore>();
  private rateLimits = new Map<string, RateLimiter>();
  private live = new Map<string, LiveRun>();

  public log(runId: string, level: RunLog['level'], message: string): void {
    const logs = this.live.get(runId)?.logs;
    if (logs) {
      logs.push({ timestamp: new Date().toISOString(), level, message });
      if (logs.length > 500) logs.shift();
    }
    const symbol = level === 'success' ? '✅' : level === 'warn' ? '⚠️' : level === 'error' ? '❌' : 'ℹ️';
    console.log(`${symbol} [Run ${runId.slice(0, 8)}] ${message}`);
  }

  /** Logs exist only while a run is live */
  public getLogs(runId: string): RunLog[] {
    return this.live.get(runId)?.logs ?? [];
  }

  /** A running run's stats come from memory (the stored copy is saved every few seconds) */
  public withLiveStats(run: ExtractionRun): ExtractionRun {
    const live = this.live.get(run.id);
    return live ? { ...run, stats: live.run.stats } : run;
  }

  /** Runs in progress on this service, newest first */
  public liveRuns(): ExtractionRun[] {
    return [...this.live.values()].map((l) => l.run).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  public stopRun(runId: string): boolean {
    const live = this.live.get(runId);
    if (!live) return false;
    this.log(runId, 'warn', 'Stopping: requests in flight finish, the rest are skipped.');
    live.controller.abort();
    return true;
  }

  /** Validates a manual request and turns it into a plan */
  public async planManual(req: ManualRequest): Promise<CountryPlan> {
    const code = req.countryCode.toUpperCase();
    const country = findCountry(code);
    if (!country) throw notFound(`This extraction service has no extractor for ${code}. Download-only countries get their files uploaded in the web app.`);
    if (!isEnabled(country)) throw badRequest(`${country.code} is disabled: set ${missingConfig(country).join(', ')} in .env`);
    if (req.tradeType !== 'ALL' && !country.tradeTypes.includes(req.tradeType)) {
      throw badRequest(`${country.code} supports ${country.tradeTypes.join('/')} only`);
    }

    let periods: Period[];
    try {
      periods = periodRange(toPeriod(req.startDate), toPeriod(req.endDate));
    } catch (err: any) {
      throw badRequest(err.message);
    }
    if (periods.length > MAX_MANUAL_MONTHS) throw badRequest(`Range covers ${periods.length} months; the limit is ${MAX_MANUAL_MONTHS}.`);

    const requested = splitHsInput(req.hsCodes);
    const tradeTypes = req.tradeType === 'ALL' ? country.tradeTypes : [req.tradeType];
    if (requested.length) {
      if (requested.length > MAX_HS_CODES) throw badRequest(`Too many HS codes (${requested.length}); the limit is ${MAX_HS_CODES}.`);
      const invalid = requested.filter((c) => !country.normalizeHsCode(c));
      if (invalid.length) {
        const shown = invalid.slice(0, 20).join(', ') + (invalid.length > 20 ? '…' : '');
        throw badRequest(`${invalid.length} HS code${invalid.length === 1 ? ' is' : 's are'} not valid for ${country.code}: ${shown}`, { invalidHsCodes: invalid });
      }
      const hsCodes = [...new Set(requested.map((c) => country.normalizeHsCode(c)!))];
      return { countryCode: country.code, periods, hsCodes, tradeTypes, hsCodeSource: 'custom' };
    }

    const isProd = env.NODE_ENV === 'prod' || env.NODE_ENV === 'production';
    const mode = !isProd && req.mode === 'test' ? 'test' : 'complete';
    const hsCodes = hsCodesService.getSaved(country.code, mode);
    if (!hsCodes.length) throw notFound(`No saved ${mode === 'test' ? 'test ' : ''}HS codes for ${country.code}. Enter codes, or add them to the server's HS code file.`);
    return { countryCode: country.code, periods, hsCodes, tradeTypes, hsCodeSource: mode };
  }

  /** Records the run and starts it in the background. One run per country at a time. */
  public async startRun(trigger: RunTrigger, plans: CountryPlan[], startedBy: string): Promise<{ run: ExtractionRun; done: Promise<void> }> {
    for (const { run } of this.live.values()) {
      const busy = plans.find((p) => run.params.plans?.some((q: CountryPlan) => q.countryCode === p.countryCode));
      if (busy) throw conflict(`${busy.countryCode} is already being extracted. Wait for that extraction or stop it first.`);
    }

    // The stored plan carries a code count; full lists (often thousands) are not repeated
    const described = plans.map(({ hsCodes, ...p }) => ({ ...p, hsCodeCount: hsCodes.length, hsCodes: hsCodes.length <= 20 ? hsCodes : undefined }));
    const run = await db.createRun(trigger, { plans: described, startedBy });
    this.live.set(run.id, { run, controller: new AbortController(), logs: [] });
    this.log(run.id, 'info', `Run started: ${plans.map((p) => `${p.countryCode} [${p.periods.join(', ')}]`).join('; ')}`);
    return { run, done: this.execute(run.id, plans) };
  }

  private async execute(runId: string, plans: CountryPlan[]): Promise<void> {
    const { run, controller } = this.live.get(runId)!;
    const saver = setInterval(() => db.saveRun(runId, { stats: run.stats }).catch(() => {}), SAVE_STATS_MS);
    let status: ExtractionRun['status'] = 'COMPLETED';
    let error: string | undefined;
    try {
      for (const plan of plans) {
        if (controller.signal.aborted) break;
        await this.runCountry(run, plan, controller.signal);
      }
      const s = run.stats;
      if (controller.signal.aborted) {
        status = 'STOPPED';
        error = 'Stopped by user';
        this.log(runId, 'warn', `Extraction stopped. With data ${s.completed}, failed ${s.failed}, skipped ${s.skipped}`);
      } else {
        this.log(runId, 'success', `Extraction completed. With data ${s.completed}, 0 records ${s.noData}, failed ${s.failed}, ${s.records} rows`);
      }
    } catch (err: any) {
      status = 'FAILED';
      error = err.message;
      this.log(runId, 'error', `Aborted: ${err.message}`);
    } finally {
      clearInterval(saver);
      await db.saveRun(runId, { status, stats: run.stats, error, finished: true }).catch((err) => console.error(`❌ Could not save run ${runId}: ${err.message}`));
      this.live.delete(runId);
    }
  }

  private async runCountry(run: ExtractionRun, plan: CountryPlan, signal: AbortSignal): Promise<void> {
    const country = findCountry(plan.countryCode);
    if (!country) throw new Error(`Unknown country ${plan.countryCode}`);
    if (!isEnabled(country)) throw new Error(`${country.code} is disabled: missing ${missingConfig(country).join(', ')}`);

    const stats = run.stats;
    const hsCodes = this.validCodes(country, plan.hsCodes, stats);
    const split = country.splitQueries ?? perCodeAndMonth;
    const queries = plan.tradeTypes.flatMap((flow) => split([...hsCodes].sort(), plan.periods, flow));
    stats.planned += queries.length;
    this.log(run.id, 'info', `${country.name} (${country.code}): ${queries.length} request(s) for ${hsCodes.length} HS code(s)`);

    const files = new MonthFiles(country.code);
    const limit = this.limitFor(country);
    const rateLimit = this.rateLimitFor(country);
    const streak = new EmptyStreak(country.code, env.EMPTY_STREAK_FLAG_AT, stats, (msg) => this.log(run.id, 'warn', msg));
    try {
      await Promise.all(
        queries.map((query) =>
          limit.run(() =>
            this.globalLimit.run(async () => {
              if (signal.aborted) {
                stats.skipped++;
                return;
              }
              const label = `[${country.code}] ${describeQuery(query)}`;
              try {
                const byMonth = await withRetry(
                  async () => {
                    await rateLimit.wait();
                    return country.fetchRecords(query);
                  },
                  env.RETRY_MAX_ATTEMPTS,
                  env.RETRY_DELAY_MS
                );
                const rows = [...byMonth.values()].reduce((n, list) => n + list.length, 0);
                for (const [period, list] of byMonth) await files.add(period, list);
                stats.records = (stats.records ?? 0) + rows;
                if (rows) stats.completed++;
                else stats.noData++;
                streak.record(query, rows === 0);
                this.log(run.id, rows ? 'success' : 'info', `${label}: ${rows ? `${rows} rows` : '0 records'}`);
              } catch (err: any) {
                stats.failed++;
                this.log(run.id, 'error', `${label}: ${err.message}`);
              }
            })
          )
        )
      );
      streak.end();

      // Each month is saved on its own: one that can't be stored doesn't lose the others
      const unsaved: { period: string; reason: string }[] = [];
      for (const period of files.periods) {
        try {
          const file = await files.save(period);
          stats.files.push(...file.paths);
          this.log(run.id, 'success', `Saved ${file.paths.length > 1 ? `${file.paths.length} parts (each under ${env.MAX_UPLOAD_MB} MB): ${file.paths.join(', ')}` : file.paths[0]} (${file.rows} rows)`);
        } catch (err: any) {
          unsaved.push({ period, reason: err.message });
          this.log(run.id, 'error', `${country.code} ${period}: could not save the file: ${err.message}`);
        }
      }
      if (!signal.aborted) {
        for (const period of plan.periods.filter((p) => !files.periods.includes(p))) {
          const message = `${country.code} ${period}: no records came back. Not published yet, or the source returned nothing; check the source.`;
          stats.flags.push({ countryCode: country.code, kind: 'EMPTY_MONTH', message, at: new Date().toISOString() });
          this.log(run.id, 'warn', message);
        }
      }
      // The run's error is kept after it ends (its logs are not), so it carries the reason
      if (unsaved.length) throw new Error(`${country.code} ${unsaved.map((u) => u.period).join(', ')} could not be saved: ${unsaved[0].reason}${files.periods.length > unsaved.length ? ' (the other months were saved)' : ''}`);
    } finally {
      await files.cleanup();
    }
  }

  private validCodes(country: Country, raw: string[], stats: RunStats): string[] {
    const valid = new Set<string>();
    const invalid: string[] = [];
    for (const code of raw) {
      const normalized = country.normalizeHsCode(code);
      if (normalized) valid.add(normalized);
      else invalid.push(code);
    }
    if (invalid.length) stats.invalidHsCodes[country.code] = invalid;
    return [...valid];
  }

  private limitFor(country: Country): Semaphore {
    if (!this.countryLimits.has(country.code)) this.countryLimits.set(country.code, new Semaphore(country.concurrency ?? env.MAX_CONCURRENT_PER_COUNTRY));
    return this.countryLimits.get(country.code)!;
  }

  private rateLimitFor(country: Country): RateLimiter {
    if (!this.rateLimits.has(country.code)) this.rateLimits.set(country.code, new RateLimiter(country.rateLimitPerMinute ?? 60));
    return this.rateLimits.get(country.code)!;
  }
}

export const extractionService = new ExtractionService();

/**
 * Flags a long unbroken stretch of requests returning 0 records: usually no data there, or the
 * source quietly refusing requests. Flagged once per stretch; the run carries on.
 */
class EmptyStreak {
  private count = 0;
  private first = '';
  private last = '';
  private flag: RunFlag | null = null;

  constructor(
    private readonly countryCode: string,
    private readonly threshold: number,
    private readonly stats: RunStats,
    private readonly warn: (message: string) => void
  ) {}

  public record(query: FetchQuery, empty: boolean): void {
    if (!empty) return this.end();
    this.count++;
    this.first ||= describeQuery(query);
    this.last = describeQuery(query);
    if (this.count === this.threshold) {
      this.flag = { countryCode: this.countryCode, kind: 'EMPTY_STREAK', message: this.describe(), at: new Date().toISOString() };
      this.stats.flags.push(this.flag);
      this.warn(this.flag.message);
    } else if (this.flag) {
      this.flag.message = this.describe();
    }
  }

  public end(): void {
    if (this.flag) this.flag.message = this.describe(true);
    this.count = 0;
    this.first = this.last = '';
    this.flag = null;
  }

  private describe(ended = false): string {
    return (
      `${this.countryCode}: ${this.count}${ended ? '' : '+'} requests in a row returned 0 records (${this.first} → ${this.last}). ` +
      'There may be no data here, or the source may be restricting requests; check it. The run moved on.'
    );
  }
}
