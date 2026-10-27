import { z } from 'zod';

const month = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, 'Use YYYY-MM');

/** POST /api/extractions */
export const extractionSchema = z.object({
  countryCode: z.string().min(2),
  startDate: month,
  endDate: month,
  // One code, or many separated by commas, semicolons, spaces or new lines
  hsCodes: z.union([z.string(), z.array(z.string())]).optional(),
  tradeType: z.enum(['ALL', 'IMPORT', 'EXPORT']).default('ALL'),
  mode: z.enum(['complete', 'test']).default('complete'),
  // Per-run tuning; anything left out uses the settings or the country's own limits
  options: z
    .object({
      concurrency: z.number().int().min(1).max(20).optional(),
      rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
      retryMaxAttempts: z.number().int().min(0).max(10).optional(),
      retryDelayMs: z.number().int().min(100).max(60_000).optional(),
    })
    .optional(),
});

/** PUT /api/settings: any subset of the settings */
export { appSettingsSchema } from '../services/settings.service';
