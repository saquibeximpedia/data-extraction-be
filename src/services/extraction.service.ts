import { ExtractableCountry, FetchContext, FetchQuery, findCountry, isEnabled, isExtractable, missingConfig } from '../countries';
import { env } from '../config/env';
import { ExtractionRun, Period, RunFlag, RunLog, RunStats, RunTrigger, TradeFlow } from '../types';
import { RateLimiter, Semaphore } from '../utils/concurrency';
import { badRequest, conflict, notFound } from '../utils/errors';
import { splitHsInput } from '../utils/hs-codes';
import { RetryableError, withRetry } from '../utils/http';
import { periodOfDate, periodRange, toPeriod } from '../utils/period';
import { db } from './db.service';
import { MonthFiles, RunDestination } from './export.service';
import { hsCodesService } from './hs-codes.service';
import { settingsService } from './settings.service';

const MAX_MANUAL_MONTHS = 60;
const MAX_HS_CODES = 1000;
const SAVE_STATS_MS = 5000;
/** Log lines kept per run (a full Thailand run logs ~86,000); past this the oldest info lines go first, warnings and errors stay */
const MAX_LOG_LINES = 5000;
/** The run's first lines (what it extracts, its limits) are always kept */
const KEEP_FIRST_LINES = 10;
/** Lines served to the live view, the newest */
const LIVE_LOG_LINES = 500;

/** What to extract for one country within a run */
export interface CountryPlan {
  countryCode: string;
  periods: Period[];
  hsCodes: string[];
  tradeTypes: TradeFlow[];
  /** Where the HS codes came from, for the run's description; 'all': none, the source returns every code */
  hsCodeSource: 'complete' | 'test' | 'custom' | 'all';
  /** A dataset ID chosen on the extract page, read instead of each year's dataset */
  dataset?: string;
}

/** Per-run tuning from the web app's extract form; anything left out uses the settings or the country's own limits */
export interface RunOptions {
  concurrency?: number;
  rateLimitPerMinute?: number;
  retryMaxAttempts?: number;
  retryDelayMs?: number;
  /** 'device': files are held on the service for the web app to save into the user's folder, not stored */
  destination?: RunDestination;
}

export interface ManualRequest {
  countryCode: string;
  startDate: string;
  endDate: string;
  hsCodes?: string | string[];
  tradeType: 'ALL' | TradeFlow;
  mode?: 'complete' | 'test';
  options?: RunOptions;
  /** A dataset ID to read instead of each year's dataset (sources with datasets; one flow only) */
  dataset?: string;
}

interface LiveRun {
  run: ExtractionRun;
  controller: AbortController;
  logs: RunLog[];
  /** Lines added since the logs were last saved */
  logsChanged: boolean;
}

/** Default split: one request per HS code and month */
const perCodeAndMonth = (hsCodes: string[], periods: Period[], tradeType: TradeFlow): FetchQuery[] =>
  hsCodes.flatMap((code) => periods.map((period) => ({ hsCodes: [code], periods: [period], tradeType })));

const describeCodes = (codes: string[]) => (codes.length > 1 ? `${codes.length} HS codes` : codes.length ? `HS ${codes[0]}` : 'every HS code');

/** A batch names its first and last code (codes are sorted), so a failed one can be run again on its own */
const describeQuery = (q: FetchQuery) =>
  `${q.tradeType} ${q.periods.length > 1 ? `${q.periods[0]}…${q.periods[q.periods.length - 1]}` : q.periods[0]} ${describeCodes(q.hsCodes)}` +
  (q.hsCodes.length > 1 ? ` ${q.hsCodes[0]}…${q.hsCodes[q.hsCodes.length - 1]}` : '');

/**
 * Runs extractions in the background. Each country splits a run into requests (an HS code and
 * month, or a whole batch for sources that return many at once); requests run in parallel within
 * the country's concurrency and rate limits, temporary errors are retried, and every month that
 * returned rows gets its CSV written to Storage when the country finishes (also when stopped).
 */
class ExtractionService {
  private globalLimit = new Semaphore(settingsService.get().maxConcurrentExtractions);
  private live = new Map<string, LiveRun>();

  constructor() {
    settingsService.onChange((s) => this.globalLimit.setMax(s.maxConcurrentExtractions));
  }

  public log(runId: string, level: RunLog['level'], message: string): void {
    const live = this.live.get(runId);
    if (live) {
      const logs = live.logs;
      logs.push({ timestamp: new Date().toISOString(), level, message });
      if (logs.length > MAX_LOG_LINES) {
        const oldestInfo = logs.findIndex((l, i) => i >= KEEP_FIRST_LINES && (l.level === 'info' || l.level === 'success'));
        logs.splice(oldestInfo === -1 ? KEEP_FIRST_LINES : oldestInfo, 1);
      }
      live.logsChanged = true;
    }
    const symbol = level === 'success' ? '✅' : level === 'warn' ? '⚠️' : level === 'error' ? '❌' : 'ℹ️';
    console.log(`${symbol} [Run ${runId.slice(0, 8)}] ${message}`);
  }

  /** The newest lines of a live run; a finished run's logs are read from the database by the web app */
  public getLogs(runId: string): RunLog[] {
    return this.live.get(runId)?.logs.slice(-LIVE_LOG_LINES) ?? [];
  }

  /** Saves a run's log lines if any were added; a failure is reported but doesn't stop the run */
  private async saveLogs(runId: string): Promise<void> {
    const live = this.live.get(runId);
    if (!live?.logsChanged) return;
    live.logsChanged = false;
    try {
      await db.saveLogs(runId, live.logs);
    } catch (err: any) {
      live.logsChanged = true;
      console.error(`❌ Could not save the logs of run ${runId}: ${err.message}`);
    }
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
    this.log(runId, 'warn', 'Stopping: requests in flight are cancelled and the rest skipped; the rows fetched so far are saved.');
    live.controller.abort();
    return true;
  }

  /** Validates a manual request and turns it into a plan */
  public async planManual(req: ManualRequest): Promise<CountryPlan> {
    const code = req.countryCode.toUpperCase();
    const country = findCountry(code);
    if (!country) throw notFound(`This extraction service has no extractor for ${code}. Download-only countries get their files uploaded in the web app.`);
    if (!isExtractable(country)) throw badRequest(`${country.name} is download-only: use its bulk file links.`);
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
    // A month that hasn't started can't have data, and would show as extracting on the web app
    if (periods[periods.length - 1] > periodOfDate(new Date())) throw badRequest(`${periods[periods.length - 1]} is in the future; pick months up to this one.`);
    const startPeriod = (await db.startPeriodOverride(country.code)) ?? country.startPeriod;
    if (startPeriod && periods[0] < startPeriod) throw badRequest(`${country.name} has data from ${startPeriod} onwards; pick months from then.`);

    const requested = splitHsInput(req.hsCodes);
    const tradeTypes = req.tradeType === 'ALL' ? country.tradeTypes : [req.tradeType];
    // A dataset holds one flow, so a chosen one needs Import or Export picked
    const dataset = req.dataset?.trim() || undefined;
    if (dataset && !country.datasets) throw badRequest(`${country.code} does not read datasets`);
    if (dataset && tradeTypes.length !== 1) throw badRequest(`A dataset holds one flow: pick Import or Export to read ${dataset}`);
    const custom = dataset ? { dataset } : {};
    if (requested.length) {
      if (requested.length > MAX_HS_CODES) throw badRequest(`Too many HS codes (${requested.length}); the limit is ${MAX_HS_CODES}.`);
      const invalid = requested.filter((c) => !country.normalizeHsCode(c));
      if (invalid.length) {
        const shown = invalid.slice(0, 20).join(', ') + (invalid.length > 20 ? '…' : '');
        throw badRequest(`${invalid.length} HS code${invalid.length === 1 ? ' is' : 's are'} not valid for ${country.code}: ${shown}`, { invalidHsCodes: invalid });
      }
      const hsCodes = [...new Set(requested.map((c) => country.normalizeHsCode(c)!))];
      return { countryCode: country.code, periods, hsCodes, tradeTypes, hsCodeSource: 'custom', ...custom };
    }

    const isProd = env.NODE_ENV === 'prod' || env.NODE_ENV === 'production';
    const mode = !isProd && req.mode === 'test' ? 'test' : 'complete';
    // Requests return every code, so a complete run needs no list (a saved one would only narrow it)
    if (country.allHsCodes && mode === 'complete') return { countryCode: country.code, periods, hsCodes: [], tradeTypes, hsCodeSource: 'all', ...custom };
    const hsCodes = hsCodesService.getSaved(country.code, mode);
    if (!hsCodes.length) throw notFound(`No saved ${mode === 'test' ? 'test ' : ''}HS codes for ${country.code}. Enter codes, or add them to the server's HS code file.`);
    return { countryCode: country.code, periods, hsCodes, tradeTypes, hsCodeSource: mode, ...custom };
  }

  /** Records the run and starts it in the background. One run per country at a time. */
  public async startRun(trigger: RunTrigger, plans: CountryPlan[], startedBy: string, options: RunOptions = {}): Promise<{ run: ExtractionRun; done: Promise<void> }> {
    for (const { run } of this.live.values()) {
      const busy = plans.find((p) => run.params.plans?.some((q: CountryPlan) => q.countryCode === p.countryCode));
      if (busy) throw conflict(`${busy.countryCode} is already being extracted. Wait for that extraction or stop it first.`);
    }

    // The stored plan carries a code count; full lists (often thousands) are not repeated
    const described = plans.map(({ hsCodes, ...p }) => ({ ...p, hsCodeCount: hsCodes.length, hsCodes: hsCodes.length <= 20 ? hsCodes : undefined }));
    const hasOptions = Object.values(options).some((v) => v !== undefined);
    const run = await db.createRun(trigger, { plans: described, startedBy, ...(hasOptions ? { options } : {}) });
    this.live.set(run.id, { run, controller: new AbortController(), logs: [], logsChanged: false });
    this.log(run.id, 'info', `Run started: ${plans.map((p) => `${p.countryCode} [${p.periods.join(', ')}]`).join('; ')}`);
    return { run, done: this.execute(run.id, plans, options) };
  }

  private async execute(runId: string, plans: CountryPlan[], options: RunOptions): Promise<void> {
    const { run, controller } = this.live.get(runId)!;
    const saver = setInterval(() => {
      db.saveRun(runId, { stats: run.stats }).catch(() => {});
      void this.saveLogs(runId);
    }, SAVE_STATS_MS);
    let status: ExtractionRun['status'] = 'COMPLETED';
    let error: string | undefined;
    try {
      for (const plan of plans) {
        if (controller.signal.aborted) break;
        await this.runCountry(run, plan, controller.signal, options);
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
      // Logs first: the web app reloads the page once the run is saved as ended
      await this.saveLogs(runId);
      await db.saveRun(runId, { status, stats: run.stats, error, finished: true }).catch((err) => console.error(`❌ Could not save run ${runId}: ${err.message}`));
      this.live.delete(runId);
    }
  }

  private async runCountry(run: ExtractionRun, plan: CountryPlan, signal: AbortSignal, options: RunOptions): Promise<void> {
    const country = findCountry(plan.countryCode);
    if (!country) throw new Error(`Unknown country ${plan.countryCode}`);
    if (!isExtractable(country)) throw new Error(`${country.code} is download-only`);
    if (!isEnabled(country)) throw new Error(`${country.code} is disabled: missing ${missingConfig(country).join(', ')}`);

    const stats = run.stats;
    const hsCodes = this.validCodes(country, plan.hsCodes, stats);
    const split = country.splitQueries ?? perCodeAndMonth;
    const queries = plan.tradeTypes.flatMap((flow) => split([...hsCodes].sort(), plan.periods, flow));
    stats.planned += queries.length;
    this.log(run.id, 'info', `${country.name} (${country.code}): ${queries.length} request(s) for ${describeCodes(hsCodes)}`);
    const context: FetchContext = { dataset: plan.dataset };
    if (plan.dataset) this.log(run.id, 'info', `${country.code}: reading dataset ${plan.dataset} for every month (chosen on the extract page)`);

    // One run per country at a time, so the limits belong to this run
    const settings = settingsService.get();
    const concurrency = options.concurrency ?? country.concurrency ?? settings.maxConcurrentPerCountry;
    const perMinute = options.rateLimitPerMinute ?? country.rateLimitPerMinute ?? 60;
    const retries = options.retryMaxAttempts ?? settings.retryMaxAttempts;
    const retryDelay = options.retryDelayMs ?? country.retryDelayMs ?? settings.retryDelayMs;
    this.log(run.id, 'info', `${country.code}: ${concurrency} at a time, up to ${perMinute}/min, ${retries} retries from ${retryDelay / 1000}s`);

    const files = new MonthFiles(country.code, run.id, plan.hsCodeSource === 'test', options.destination);
    if (options.destination === 'device') this.log(run.id, 'info', 'Files are held on the service until the web app saves them to your folder; they are not stored.');
    const limit = new Semaphore(concurrency);
    const rateLimit = new RateLimiter(perMinute);
    const streak = new EmptyStreak(country.code, settings.emptyStreakFlagAt, stats, (msg) => this.log(run.id, 'warn', msg));
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
              const requestContext: FetchContext = { ...context, log: (level, message) => this.log(run.id, level, `${label}: ${message}`) };
              try {
                const byMonth = await withRetry(
                  async () => {
                    await rateLimit.wait();
                    signal.throwIfAborted();
                    try {
                      return await country.fetchRecords(query, signal, requestContext);
                    } catch (err) {
                      // The source is struggling (429, 5xx, timeout): hold the country's other requests too, not just this retry
                      if (err instanceof RetryableError) rateLimit.pause(retryDelay);
                      throw err;
                    }
                  },
                  retries,
                  retryDelay,
                  signal,
                  (attempt, delay, err: any) => this.log(run.id, 'warn', `${label}: retry ${attempt}/${retries} in ${Math.round(delay / 1000)}s: ${err.message}`)
                );
                const rows = [...byMonth.values()].reduce((n, list) => n + list.length, 0);
                // Imports and exports go to files of their own; the request says which (not every source's rows do)
                for (const [period, list] of byMonth) await files.add(period, query.tradeType, list);
                stats.records = (stats.records ?? 0) + rows;
                if (rows) stats.completed++;
                else stats.noData++;
                streak.record(query, rows === 0);
                this.log(run.id, rows ? 'success' : 'info', `${label}: ${rows ? `${rows} rows` : '0 records'}`);
              } catch (err: any) {
                // Cancelled by a stop: skipped, not failed
                if (signal.aborted) {
                  stats.skipped++;
                  return;
                }
                stats.failed++;
                this.log(run.id, 'error', `${label}: ${err.message}`);
              }
            })
          )
        )
      );
      streak.end();

      // Each month and flow is saved on its own: one that can't be stored doesn't lose the others
      const unsaved: { label: string; reason: string }[] = [];
      const saved = files.months;
      for (const { period, flow } of saved) {
        try {
          const file = await files.save(period, flow);
          stats.files.push(...file.paths);
          this.log(run.id, 'success', `${options.destination === 'device' ? 'Ready for your folder' : 'Saved'} ${file.paths.length > 1 ? `${file.paths.length} parts: ${file.paths.join(', ')}` : file.paths[0]} (${file.rows} rows)`);
          for (const s of file.stored.filter((s) => s.onServer)) this.log(run.id, 'warn', `${s.path} is kept on the server, not in the cloud: ${s.reason}. It is in Files (marked On server) until deleted there.`);
        } catch (err: any) {
          unsaved.push({ label: `${period} ${flow}`, reason: err.message });
          this.log(run.id, 'error', `${country.code} ${period} ${flow}: could not save the file: ${err.message}`);
        }
      }
      if (!signal.aborted) {
        for (const period of plan.periods) {
          for (const flow of plan.tradeTypes.filter((f) => !saved.some((m) => m.period === period && m.flow === f))) {
            const message = `${country.code} ${period} ${flow}: no records came back. Not published yet, or the source returned nothing; check the source.`;
            stats.flags.push({ countryCode: country.code, kind: 'EMPTY_MONTH', message, at: new Date().toISOString() });
            this.log(run.id, 'warn', message);
          }
        }
      }
      // The run's error is kept after it ends (its logs are not), so it carries the reason
      if (unsaved.length) throw new Error(`${country.code} ${unsaved.map((u) => u.label).join(', ')} could not be saved: ${unsaved[0].reason}${saved.length > unsaved.length ? ' (the others were saved)' : ''}`);
    } finally {
      await files.cleanup();
    }
  }

  private validCodes(country: ExtractableCountry, raw: string[], stats: RunStats): string[] {
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
