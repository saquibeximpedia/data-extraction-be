import { db } from './db.service';
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
