import { z } from 'zod';

const month = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, 'Use YYYY-MM');
const positiveLimit = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback);

export const loginSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

/** POST /api/extractions and /api/extractions/preview */
export const extractionSchema = z.object({
  countryCode: z.string().min(2),
  startDate: month,
  endDate: month,
  // One code, or many separated by commas, semicolons, spaces or new lines
  hsCodes: z.union([z.string(), z.array(z.string())]).optional(),
  tradeType: z.enum(['ALL', 'IMPORT', 'EXPORT']).default('ALL'),
  // Re-extract months that are already done (the UI warns before sending this)
  force: z.boolean().default(true),
  mode: z.enum(['complete', 'test']).default('complete').optional(),
});

export const runsQuerySchema = z.object({
  limit: positiveLimit(25, 500),
});

export const filesQuerySchema = z.object({
  country: z.string().optional(),
});

export const downloadQuerySchema = z.object({
  path: z.string().min(1, 'path is required'),
});
