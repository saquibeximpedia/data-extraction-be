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
});
