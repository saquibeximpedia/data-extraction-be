import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { env } from '../config/env';

/**
 * Extraction settings admins can change from the web app while the service runs. They start from
 * .env and are kept in settings.json next to it, so a change survives a restart.
 */
export const appSettingsSchema = z.object({
  /** Requests in flight at once across every running extraction */
  maxConcurrentExtractions: z.number().int().min(1).max(50),
  /** Requests in flight at once for one country, unless its extractor sets its own */
  maxConcurrentPerCountry: z.number().int().min(1).max(20),
  /** Times a temporary failure (timeout, 429, 5xx) is retried */
  retryMaxAttempts: z.number().int().min(0).max(10),
  /** Wait before the first retry; doubles on each one */
  retryDelayMs: z.number().int().min(100).max(60_000),
  /** Requests in a row returning 0 records before a run is flagged */
  emptyStreakFlagAt: z.number().int().min(10).max(100_000),
  /** A month's CSV larger than this is split into parts */
  maxUploadMb: z.number().int().min(1).max(500),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const FILE = path.resolve(process.cwd(), 'settings.json');

const fromEnv = (): AppSettings => ({
  maxConcurrentExtractions: env.MAX_CONCURRENT_EXTRACTIONS,
  maxConcurrentPerCountry: env.MAX_CONCURRENT_PER_COUNTRY,
  retryMaxAttempts: env.RETRY_MAX_ATTEMPTS,
  retryDelayMs: env.RETRY_DELAY_MS,
  emptyStreakFlagAt: env.EMPTY_STREAK_FLAG_AT,
  maxUploadMb: env.MAX_UPLOAD_MB,
});

function load(): AppSettings {
  const defaults = fromEnv();
  try {
    const saved = appSettingsSchema.partial().safeParse(JSON.parse(fs.readFileSync(FILE, 'utf8')));
    return saved.success ? { ...defaults, ...saved.data } : defaults;
  } catch {
    return defaults;
  }
}

let current = load();
const listeners: ((s: AppSettings) => void)[] = [];

export const settingsService = {
  get: (): AppSettings => current,

  /** The .env values, for "reset to default" in the web app */
  defaults: fromEnv,

  update(patch: Partial<AppSettings>): AppSettings {
    current = appSettingsSchema.parse({ ...current, ...patch });
    fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
    for (const fn of listeners) fn(current);
    return current;
  },

  onChange(fn: (s: AppSettings) => void): void {
    listeners.push(fn);
  },
};
