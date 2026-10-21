import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

dotenv.config();

const positiveInt = (fallback: string) =>
  z.string().default(fallback).transform(Number).pipe(z.number().int().positive());

const envSchema = z.object({
  PORT: positiveInt('3000'),
  NODE_ENV: z.enum(['dev', 'development', 'prod', 'production', 'test']).default('dev'),
  LOCAL_STORAGE_PATH: z.string().default('./storage/exports'),
  DB_PATH: z.string().default('./storage/ledger.db'),

  // Runs daily; each tick works out which months are due per country
  SCHEDULER_CRON: z.string().default('0 3 * * *'),
  SCHEDULER_TIMEZONE: z.string().optional(),
  SCHEDULER_ENABLED: z.string().default('true').transform((val) => val === 'true'),
  SCHEDULER_RUN_ON_START: z.string().default('false').transform((val) => val === 'true'),
  // How many published months auto sync keeps re-checking (fills gaps after downtime)
  AUTO_SYNC_LOOKBACK_MONTHS: positiveInt('3'),
  // FAILED tasks stop being retried by auto sync after this many attempts
  MAX_TASK_ATTEMPTS: positiveInt('5'),

  MAX_CONCURRENT_EXTRACTIONS: positiveInt('4'),
  MAX_CONCURRENT_PER_COUNTRY: positiveInt('2'),
  RETRY_MAX_ATTEMPTS: positiveInt('3'),
  RETRY_DELAY_MS: positiveInt('2000'),

  API_PASSWORD: z.string().min(1, 'API_PASSWORD must not be empty'),
  ALLOWED_IPS: z.string().default(''),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  TOKEN_EXPIRY: z.string().default('24h'),

  // Country API credentials
  BPS_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', z.treeifyError(parsed.error));
  process.exit(1);
}

const allowedIpList = parsed.data.ALLOWED_IPS
  ? parsed.data.ALLOWED_IPS.split(',').map((ip) => ip.trim().toLowerCase()).filter(Boolean)
  : [];

export const env = {
  ...parsed.data,
  allowedIpList,
  resolvedStoragePath: path.resolve(process.cwd(), parsed.data.LOCAL_STORAGE_PATH),
  resolvedDbPath: path.resolve(process.cwd(), parsed.data.DB_PATH),
};
