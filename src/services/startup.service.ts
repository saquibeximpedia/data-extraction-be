import { db } from './db.service';
import { MonthFiles } from './export.service';
import { registryService } from './registry.service';

const RETRY_MS = 60_000;

/** Whether the database is set up and the extractor list is published; reported by GET /api/health */
export const databaseStatus: { ok: boolean; error: string; checkedAt: string | null } = {
  ok: false,
  error: 'Connecting to the database…',
  checkedAt: null,
};

let recovered = false;

/**
 * Saves the rows a run had fetched before the service died (crash, out of memory, restart), as
 * a stopped run's are: each month that has rows goes to Storage, marked incomplete on the run.
 * The rows wait on disk until this succeeds, so a failed attempt is tried again at the next start.
 */
async function saveLeftovers(): Promise<void> {
  for (const runId of MonthFiles.leftoverRuns()) {
    const run = await db.getRun(runId);
    // Not a run (e.g. a folder from before runs had their own): left for a person to look at
    if (!run) continue;
    const saved: string[] = [];
    let failed = false;
    const plans: { countryCode: string; hsCodeSource?: string }[] = run.params.plans ?? [];
    const isTest = (code: string) => plans.some((p) => p.countryCode === code && p.hsCodeSource === 'test');
    for (const files of MonthFiles.leftovers(runId, isTest)) {
      for (const period of files.periods) {
        try {
          const file = await files.save(period);
          run.stats.files.push(...file.paths.filter((p) => !run.stats.files.includes(p)));
          saved.push(`${files.country} ${period} (${file.rows} rows)`);
          console.log(`♻️  Run ${runId.slice(0, 8)}: saved the ${file.rows} rows fetched for ${files.country} ${period} before the service stopped`);
        } catch (err: any) {
          failed = true;
          console.error(`❌ Run ${runId.slice(0, 8)}: could not save ${files.country} ${period}: ${err.message}`);
        }
      }
      if (!failed) await files.cleanup();
    }
    if (saved.length) {
      const error = `${run.error ?? 'Extraction service stopped mid-run'}. The rows fetched before that were saved (incomplete): ${saved.join(', ')}`;
      await db.saveRun(runId, { stats: run.stats, error });
    }
  }
}

/**
 * Checks the tables, marks runs cut off by a restart as interrupted (once), and publishes the
 * extractor list. On failure it tries again every minute, so running supabase/schema.sql while the
 * service runs is enough: no restart needed.
 */
export async function connectDatabase(): Promise<void> {
  try {
    await db.check();
    if (!recovered) {
      const n = await db.recoverInterrupted();
      if (n) console.warn(`♻️  Marked ${n} run(s) INTERRUPTED after an unclean shutdown.`);
      recovered = true;
      // In the background: a big month takes a while to upload
      saveLeftovers().catch((err) => console.error(`❌ Could not save rows left by cut-off runs: ${err.message}`));
    }
    await registryService.sync();
    Object.assign(databaseStatus, { ok: true, error: '', checkedAt: new Date().toISOString() });
    console.log('📇 Extractor list published to the database');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const first = databaseStatus.error !== message;
    Object.assign(databaseStatus, { ok: false, error: message, checkedAt: new Date().toISOString() });
    if (first) console.error(`❌ ${message}. Run supabase/schema.sql in the Supabase SQL editor; retrying every minute.`);
    setTimeout(connectDatabase, RETRY_MS).unref();
  }
}
