import dotenv from 'dotenv';
import os from 'os';
import path from 'path';
import { z } from 'zod';

dotenv.config();

const positiveInt = (fallback: string) =>
  z.string().default(fallback).transform(Number).pipe(z.number().int().positive());

const envSchema = z.object({
  PORT: positiveInt('3000'),
  NODE_ENV: z.enum(['dev', 'development', 'prod', 'production', 'test']).default('dev'),

  // Auth, tables and file storage. The service role key bypasses row level security: server only.
  SUPABASE_URL: z.url('SUPABASE_URL must be the project URL, e.g. https://xyz.supabase.co'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  SUPABASE_BUCKET: z.string().default('trade-exports'),

  // A run flags this many requests in a row returning 0 records, then carries on
  EMPTY_STREAK_FLAG_AT: positiveInt('300'),

  MAX_CONCURRENT_EXTRACTIONS: positiveInt('4'),
  MAX_CONCURRENT_PER_COUNTRY: positiveInt('2'),
  RETRY_MAX_ATTEMPTS: positiveInt('3'),
  RETRY_DELAY_MS: positiveInt('2000'),

  // Comma-separated; empty or * allows all
  ALLOWED_IPS: z.string().default(''),

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
  /** Run rows are collected here before each month is uploaded to Storage */
  tempDir: path.join(os.tmpdir(), 'trade-data-exports'),
};
