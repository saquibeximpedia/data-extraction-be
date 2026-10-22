import { Country, findCountry, isEnabled, missingConfig } from '../countries';
import { env } from '../config/env';
import { ExtractionRun, Period, RunFlag, RunLog, RunStats, RunTrigger, TaskKey, TradeFlow } from '../types';
import { RateLimiter, Semaphore } from '../utils/concurrency';
import { badRequest, notFound } from '../utils/errors';
import { splitHsInput } from '../utils/hs-codes';
import { withRetry } from '../utils/http';
import { periodRange, toPeriod } from '../utils/period';
import { exportService } from './export.service';
import { countryService } from './country.service';
import { hsCodesService } from './hs-codes.service';
import { ledgerService } from './ledger.service';

const MAX_MANUAL_MONTHS = 60;
const MAX_HS_CODES = 1000;

/** What to extract for one country within a run */
export interface CountryPlan {
  countryCode: string;
  periods: Period[];
  hsCodes?: string[]; // defaults to the country's saved list
  tradeTypes?: TradeFlow[]; // defaults to every flow the country supports
  /** Where the HS codes came from, for the run's description */
  hsCodeSource?: 'complete' | 'test' | 'custom';
}

export interface ManualRequest {
  countryCode: string;
  startDate: string; // "YYYY-MM" (or a full date; the day is ignored)
  endDate: string;
  hsCodes?: string | string[]; // blank = saved list
  tradeType: 'ALL' | TradeFlow;
  mode?: 'complete' | 'test';
}

const taskId = (k: TaskKey) => `${k.countryCode}|${k.hsCode}|${k.period}|${k.tradeType}`;

/**
 * Runs extraction tasks (one country + HS code + month + flow each).
 *
 * - Countries run in parallel, capped per country (MAX_CONCURRENT_PER_COUNTRY),
 *   overall (MAX_CONCURRENT_EXTRACTIONS) and by each country's rate limit.
 * - Temporary source errors are retried with backoff.
 * - A task that is already running is skipped, never duplicated.
 * - Each touched country-month CSV is rebuilt from the ledger when a country finishes.
 * - Supports graceful cancellation in between without killing the server.
 */
class ExtractionService {
  private globalLimit = new Semaphore(env.MAX_CONCURRENT_EXTRACTIONS);
  private countryLimits = new Map<string, Semaphore>();
  private rateLimits = new Map<string, RateLimiter>();
  private inFlight = new Set<string>();
  private abortControllers = new Map<string, AbortController>();
  private runLogs = new Map<string, RunLog[]>();

  public log(runId: string, level: 'info' | 'warn' | 'error' | 'success', message: string): void {
    const logs = this.runLogs.get(runId) || [];
    const entry: RunLog = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    logs.push(entry);
    if (logs.length > 500) logs.shift();
    this.runLogs.set(runId, logs);
    const symbol = level === 'success' ? '✅' : level === 'warn' ? '⚠️' : level === 'error' ? '❌' : 'ℹ️';
    console.log(`${symbol} [Run ${runId.slice(0, 8)}] ${message}`);
  }

  public getLogs(runId: string): RunLog[] {
    return this.runLogs.get(runId) || [];
  }

  public stopRun(runId: string): boolean {
    const controller = this.abortControllers.get(runId);
    this.log(runId, 'warn', 'Stopping extraction by user request...');
    if (controller) {
      controller.abort();
    }
    const run = ledgerService.getRun(runId);
    if (run && run.status === 'RUNNING') {
      ledgerService.finishRun(runId, 'STOPPED', run.stats, 'Stopped by user');
      return true;
    }
    return Boolean(controller);
  }

  // ------------------------------------------------------------------ manual requests

  /** Validates a manual request and turns it into a plan. Throws HttpError on bad input. */
  public planManual(req: ManualRequest): { country: Country; plan: CountryPlan & { hsCodes: string[]; tradeTypes: TradeFlow[] } } {
    const country = findCountry(req.countryCode);
    if (!country) {
      // Admin-added countries publish files that users download themselves
      const known = countryService.list().some((c) => c.code === req.countryCode.toUpperCase());
      if (known) throw badRequest(`${req.countryCode.toUpperCase()} is download-only: get its files from the source website and upload them.`);
      throw notFound(`Unknown country ${req.countryCode.toUpperCase()}`);
    }
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
    let hsCodes: string[];
    let source: CountryPlan['hsCodeSource'];
    if (requested.length) {
      if (requested.length > MAX_HS_CODES) throw badRequest(`Too many HS codes (${requested.length}); the limit is ${MAX_HS_CODES}.`);
      const invalid = requested.filter((c) => !country.normalizeHsCode(c));
      if (invalid.length) {
        const shown = invalid.slice(0, 20).join(', ') + (invalid.length > 20 ? '…' : '');
        throw badRequest(`${invalid.length} HS code${invalid.length === 1 ? ' is' : 's are'} not valid for ${country.code}: ${shown}`, { invalidHsCodes: invalid });
      }
      hsCodes = [...new Set(requested.map((c) => country.normalizeHsCode(c)!))];
      source = 'custom';
    } else {
      const isProd = env.NODE_ENV === 'prod' || env.NODE_ENV === 'production';
      const mode = isProd ? 'complete' : (req.mode === 'test' ? 'test' : 'complete');
      hsCodes = hsCodesService.getSaved(country.code, mode);
      source = mode;
      if (!hsCodes.length) throw notFound(`No saved ${mode === 'test' ? 'test ' : ''}HS codes for ${country.code}. Enter codes, or add them to the server's HS code file.`);
    }

    const tradeTypes = req.tradeType === 'ALL' ? country.tradeTypes : [req.tradeType];
    return { country, plan: { countryCode: country.code, periods, hsCodes, tradeTypes, hsCodeSource: source } };
  }

  // ------------------------------------------------------------------ runs

  /**
   * Creates the run record and starts it in the background. Every planned task is extracted,
   * also ones extracted before (a task already running in another run is skipped).
   */
  public startRun(trigger: RunTrigger, plans: CountryPlan[], startedBy: string): { run: ExtractionRun; done: Promise<ExtractionRun> } {
    // The run record describes the plan; full code lists (often thousands) are not repeated in it
    const described = plans.map(({ hsCodes, ...p }) => ({
      ...p,
      hsCodeCount: hsCodes?.length,
      hsCodes: hsCodes && hsCodes.length <= 20 ? hsCodes : undefined,
    }));
    const run = ledgerService.createRun(trigger, { plans: described, startedBy });
    const controller = new AbortController();
    this.abortControllers.set(run.id, controller);
    this.runLogs.set(run.id, []);
    this.log(run.id, 'info', `Run started (${trigger}): ${plans.map((p) => `${p.countryCode} [${p.periods.join(', ')}]`).join('; ')}`);
    const done = this.execute(run, plans, controller.signal).finally(() => {
      this.abortControllers.delete(run.id);
    });
    return { run, done };
  }

  private async execute(run: ExtractionRun, plans: CountryPlan[], signal: AbortSignal): Promise<ExtractionRun> {
    const tag = `[Run ${run.id.slice(0, 8)}]`;
    try {
      for (const plan of plans) {
        if (signal.aborted) break;
        await this.runCountry(run, plan, signal);
      }
      if (signal.aborted) {
        const runRec = ledgerService.getRun(run.id);
        if (!runRec || runRec.status === 'RUNNING') {
          ledgerService.finishRun(run.id, 'STOPPED', run.stats, 'Extraction stopped by user');
        }
        this.log(run.id, 'warn', `Extraction stopped. Completed ${run.stats.completed}, failed ${run.stats.failed}, skipped ${run.stats.skipped}`);
      } else {
        ledgerService.finishRun(run.id, 'COMPLETED', run.stats);
        const s = run.stats;
        this.log(run.id, 'success', `Extraction completed. With data ${s.completed}, 0 records ${s.noData}, failed ${s.failed}, skipped ${s.skipped}, flags ${s.flags.length}`);
      }
    } catch (err: any) {
      console.error(`❌ ${tag} Aborted: ${err.message}`);
      this.log(run.id, 'error', `Aborted: ${err.message}`);
      ledgerService.finishRun(run.id, 'FAILED', run.stats, err.message);
    }
    return ledgerService.getRun(run.id)!;
  }

  private async runCountry(run: ExtractionRun, plan: CountryPlan, signal: AbortSignal): Promise<void> {
    const country = findCountry(plan.countryCode);
    if (!country) throw new Error(`Unknown country ${plan.countryCode}`);
    if (!isEnabled(country)) throw new Error(`${country.code} is disabled: missing ${missingConfig(country).join(', ')}`);

    const stats = run.stats;
    const hsCodes = this.validCodes(country, plan.hsCodes ?? hsCodesService.getSaved(country.code), stats);
    const flows = plan.tradeTypes ?? country.tradeTypes;

    // Every combination, minus what doesn't need doing. Grouped by code (sorted, so related codes
    // sit together) rather than by month, so sources that return many months or codes per request
    // answer a whole group from one download while it is still cached.
    const tasks: TaskKey[] = [];
    for (const hsCode of [...hsCodes].sort()) {
      for (const period of plan.periods) {
        for (const tradeType of flows) {
          const key: TaskKey = { countryCode: country.code, hsCode, period, tradeType };
          if (this.inFlight.has(taskId(key))) stats.skipped++;
          else tasks.push(key);
        }
      }
    }
    stats.planned += plan.periods.length * hsCodes.length * flows.length;
    ledgerService.saveRunStats(run.id, stats);
    this.log(run.id, 'info', `Processing ${country.name} (${country.code}): ${tasks.length} task(s) to fetch`);

    const touched = new Set<Period>();
    const limit = this.limitFor(country.code);
    const streak = new EmptyStreak(country.code, env.EMPTY_STREAK_FLAG_AT, stats, (msg) => this.log(run.id, 'warn', msg));

    await Promise.all(
      tasks.map(async (key) => {
        if (signal.aborted) {
          stats.skipped++;
          return;
        }
        return limit.run(() =>
          this.globalLimit.run(async () => {
            if (signal.aborted) {
              stats.skipped++;
              return;
            }
            const outcome = await this.runTask(country, key, plan.periods, run.id, signal);
            if (outcome === 'COMPLETED') stats.completed++;
            else if (outcome === 'NO_DATA') stats.noData++;
            else if (outcome === 'FAILED') stats.failed++;
            else stats.skipped++;

            if (outcome === 'COMPLETED' || outcome === 'NO_DATA') {
              touched.add(key.period);
              streak.record(key, outcome === 'NO_DATA');
            }
            ledgerService.saveRunStats(run.id, stats);
          })
        );
      })
    );
    streak.end();

    // Files are written for every month this run touched, also when it was stopped part-way
    for (const period of [...touched].sort()) {
      if (ledgerService.countRecords(country.code, period) === 0) continue;
      const file = await exportService.writeCountryPeriod(country.code, period, () => ledgerService.iterateRecords(country.code, period));
      stats.files.push(file.path);
      this.log(run.id, 'success', `Saved CSV file: ${file.path} (${file.rows} rows)`);
    }

    // A month where nothing has ever come back: not published yet, or the source returned nothing
    for (const period of [...touched].sort()) {
      if (ledgerService.countCompleted(country.code, period) > 0) continue;
      const message = `${country.code} ${period}: every HS code returned 0 records. Not published yet, or the source returned nothing; check the source.`;
      stats.flags.push({ countryCode: country.code, kind: 'EMPTY_MONTH', message, at: new Date().toISOString() });
      this.log(run.id, 'warn', message);
    }
    ledgerService.saveRunStats(run.id, stats);
  }

  private async runTask(
    country: Country,
    key: TaskKey,
    runPeriods: Period[],
    runId: string,
    signal: AbortSignal
  ): Promise<'COMPLETED' | 'NO_DATA' | 'FAILED' | 'SKIPPED'> {
    if (signal.aborted) return 'SKIPPED';
    const id = taskId(key);
    if (this.inFlight.has(id)) return 'SKIPPED'; // another run claimed it while this one waited
    this.inFlight.add(id);

    const task = ledgerService.startTask(key, runId);
    const label = `[${key.countryCode}] ${key.period} HS ${key.hsCode} ${key.tradeType}`;
    try {
      if (signal.aborted) return 'SKIPPED';
      const rateLimit = this.rateLimitFor(country);
      const records = await withRetry(
        async () => {
          if (signal.aborted) throw new Error('Aborted');
          await rateLimit.wait();
          return country.fetchRecords({ hsCode: key.hsCode, period: key.period, tradeType: key.tradeType, runPeriods });
        },
        env.RETRY_MAX_ATTEMPTS,
        env.RETRY_DELAY_MS
      );
      if (signal.aborted) return 'SKIPPED';
      const status = ledgerService.completeTask(task, records);
      if (status === 'COMPLETED') {
        this.log(runId, 'success', `[${key.countryCode}] ${key.period} HS ${key.hsCode} ${key.tradeType}: ${records.length} rows`);
      } else {
        this.log(runId, 'info', `[${key.countryCode}] ${key.period} HS ${key.hsCode} ${key.tradeType}: 0 records`);
      }
      return status === 'COMPLETED' ? 'COMPLETED' : 'NO_DATA';
    } catch (err: any) {
      if (signal.aborted) return 'SKIPPED';
      this.log(runId, 'error', `[${key.countryCode}] ${key.period} HS ${key.hsCode} ${key.tradeType}: ${err.message}`);
      ledgerService.failTask(task, err.message);
      return 'FAILED';
    } finally {
      this.inFlight.delete(id);
    }
  }

  // ------------------------------------------------------------------ helpers

  private validCodes(country: Country, raw: string[], stats: RunStats): string[] {
    const valid = new Set<string>();
    const invalid: string[] = [];
    for (const code of raw) {
      const normalized = country.normalizeHsCode(code);
      if (normalized) valid.add(normalized);
      else invalid.push(code);
    }
    if (invalid.length) {
      stats.invalidHsCodes[country.code] = invalid;
      console.warn(`⚠️  [${country.code}] Skipping ${invalid.length} invalid HS code(s): ${invalid.join(', ')}`);
    }
    return [...valid];
  }

  private limitFor(code: string): Semaphore {
    if (!this.countryLimits.has(code)) this.countryLimits.set(code, new Semaphore(env.MAX_CONCURRENT_PER_COUNTRY));
    return this.countryLimits.get(code)!;
  }

  private rateLimitFor(country: Country): RateLimiter {
    if (!this.rateLimits.has(country.code)) this.rateLimits.set(country.code, new RateLimiter(country.rateLimitPerMinute ?? 60));
    return this.rateLimits.get(country.code)!;
  }
}

export const extractionService = new ExtractionService();

/**
 * Watches for a long unbroken stretch of tasks returning 0 records. Some empties are normal
 * (no trade for a code that month), but a long stretch usually means the source has no data
 * there or is quietly refusing requests. The run is flagged once per stretch and carries on.
 */
class EmptyStreak {
  private count = 0;
  private first: TaskKey | null = null;
  private last: TaskKey | null = null;
  private flag: RunFlag | null = null;

  constructor(
    private readonly countryCode: string,
    private readonly threshold: number,
    private readonly stats: RunStats,
    private readonly warn: (message: string) => void
  ) {}

  public record(key: TaskKey, empty: boolean): void {
    if (!empty) return this.end();
    this.count++;
    this.first ??= key;
    this.last = key;
    if (this.count === this.threshold) {
      this.flag = { countryCode: this.countryCode, kind: 'EMPTY_STREAK', message: this.describe(), at: new Date().toISOString() };
      this.stats.flags.push(this.flag);
      this.warn(this.flag.message);
    } else if (this.flag) {
      this.flag.message = this.describe();
    }
  }

  /** Closes the current stretch, settling its flag's final size */
  public end(): void {
    if (this.flag) this.flag.message = this.describe(true);
    this.count = 0;
    this.first = this.last = null;
    this.flag = null;
  }

  private describe(ended = false): string {
    const at = (k: TaskKey | null) => (k ? `HS ${k.hsCode} ${k.period}` : '');
    return (
      `${this.countryCode}: ${this.count}${ended ? '' : '+'} tasks in a row returned 0 records (${at(this.first)} → ${at(this.last)}). ` +
      'There may be no data here, or the source may be restricting requests; check it. The run moved on.'
    );
  }
}
