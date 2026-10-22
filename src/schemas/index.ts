import { z } from 'zod';

const month = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, 'Use YYYY-MM');
const positiveLimit = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const optionalText = (max: number) => z.string().trim().max(max).optional();

/** POST /api/extractions */
export const extractionSchema = z.object({
  countryCode: z.string().min(2),
  startDate: month,
  endDate: month,
  // One code, or many separated by commas, semicolons, spaces or new lines
  hsCodes: z.union([z.string(), z.array(z.string())]).optional(),
  tradeType: z.enum(['ALL', 'IMPORT', 'EXPORT']).default('ALL'),
  mode: z.enum(['complete', 'test']).default('complete'),
});

/** POST /api/countries/:code/months: a range (start, optional end) or a list of months */
export const markMonthsSchema = z
  .object({
    start: month.optional(),
    end: month.optional(),
    periods: z.array(month).max(1000).optional(),
  })
  .refine((b) => b.start || b.periods?.length, 'Give a start month or a list of months');

/** POST /api/countries/:code/months/remove */
export const unmarkMonthsSchema = z.object({
  periods: z.array(month).min(1, 'Select at least one month').max(1000),
});

/** PATCH /api/countries/:code (admin) */
export const countryPatchSchema = z.object({
  name: optionalText(80),
  sourceName: optionalText(120),
  sourceUrl: z.union([z.url('Enter a full link, e.g. https://example.gov/data'), z.literal('')]).optional(),
  endpoint: optionalText(300),
  method: optionalText(500),
  output: optionalText(500),
  notes: optionalText(2000),
  lagMonths: z.number().int().min(0).max(24).optional(),
  publishDay: z.number().int().min(1).max(31).optional(),
});

/** POST /api/countries (admin): a download-only country */
export const newCountrySchema = countryPatchSchema.extend({
  code: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Use the 3-letter ISO code, e.g. VNM'),
  name: z.string().trim().min(2).max(80),
  sourceUrl: z.url('Enter a full link, e.g. https://example.gov/data'),
});

/** POST /api/admin/users */
export const createUserSchema = z.object({
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'Use at least 8 characters'),
  role: z.enum(['admin', 'user']).default('user'),
});

/** PATCH /api/admin/users/:id */
export const updateUserSchema = z.object({
  password: z.string().min(8, 'Use at least 8 characters').optional(),
  role: z.enum(['admin', 'user']).optional(),
});

/** POST /api/files/zip and /api/files/delete */
export const filePathsSchema = z.object({
  paths: z.array(z.string().min(1)).min(1, 'Select at least one file').max(500),
});

/** PUT /api/files/upload */
export const uploadQuerySchema = z.object({
  country: z.string().min(2),
  period: month,
  name: z.string().trim().min(1).max(200),
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
