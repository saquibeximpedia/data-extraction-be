import cron, { ScheduledTask } from 'node-cron';
import { Country, enabledCountries } from '../countries';
import { env } from '../config/env';
import { ExtractionRun, Period, RunTrigger } from '../types';
import { conflict } from '../utils/errors';
import { autoSyncPeriods } from '../utils/period';
import { extractionService } from './extraction.service';

/**
 * Daily due-check.
 *
 * Every tick (SCHEDULER_CRON, daily by default) it re-checks, for each enabled country,
 * the last AUTO_SYNC_LOOKBACK_MONTHS months the source should have published by now
 * (from lagMonths + publishDay). COMPLETED tasks are skipped; NO_DATA and FAILED ones
 * are retried, so late publications and missed days fill in on their own.
 */
class SchedulerService {
  private cronTask: ScheduledTask | null = null;
  private active: Promise<ExtractionRun> | null = null;

  /** The months a daily check covers for a country, oldest first */
  public periodsFor(country: Country, today = new Date()): Period[] {
    return autoSyncPeriods(country.lagMonths, country.publishDay ?? 1, env.AUTO_SYNC_LOOKBACK_MONTHS, today);
  }

  public isBusy(): boolean {
    return this.active !== null;
  }

  /** Starts a daily check over every enabled country. Only one runs at a time. */
  public startDailyCheck(trigger: RunTrigger): ExtractionRun {
    if (this.active) throw conflict('A daily check is already running.');

    const plans = enabledCountries().map((c) => ({ countryCode: c.code, periods: this.periodsFor(c) }));
    const { run, done } = extractionService.startRun(trigger, plans);
    this.active = done.finally(() => {
      this.active = null;
    });
    return run;
  }

  public startCron(): void {
    if (!env.SCHEDULER_ENABLED) {
      console.log('⏸️  Scheduler is disabled (SCHEDULER_ENABLED=false).');
      return;
    }
    this.cronTask?.stop();
    console.log(`⏰ Daily check scheduled with cron "${env.SCHEDULER_CRON}"${env.SCHEDULER_TIMEZONE ? ` (${env.SCHEDULER_TIMEZONE})` : ''}`);
    this.cronTask = cron.schedule(env.SCHEDULER_CRON, () => this.tick(), env.SCHEDULER_TIMEZONE ? { timezone: env.SCHEDULER_TIMEZONE } : undefined);
    if (env.SCHEDULER_RUN_ON_START) this.tick();
  }

  public stopCron(): void {
    this.cronTask?.stop();
    this.cronTask = null;
  }

  private tick(): void {
    if (this.active) {
      console.log('⏭️  [Scheduler] Previous daily check still running, skipping this tick.');
      return;
    }
    console.log('🔔 [Scheduler] Checking for due months...');
    try {
      this.startDailyCheck('SCHEDULED');
    } catch (err: any) {
      console.error('❌ Could not start the daily check:', err.message);
    }
  }
}

export const schedulerService = new SchedulerService();
