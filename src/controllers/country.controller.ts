import { Request, Response } from 'express';
import { parse } from '../middlewares/validate.middleware';
import { sourceFilesSchema } from '../schemas';
import { registryService } from '../services/registry.service';
import { sourceFilesService } from '../services/source-files.service';

/** GET /api/countries → what this service can extract right now (enabled, flows, saved HS code counts) */
export function list(_req: Request, res: Response): void {
  res.json({ countries: registryService.list() });
}

/** GET /api/countries/:code/source-files?start&end&tradeType → each month and flow's file links at the source, for the browser to download */
export async function sourceFiles(req: Request, res: Response): Promise<void> {
  const { start, end, tradeType } = parse(sourceFilesSchema, req.query);
  res.json({ months: await sourceFilesService.list(String(req.params.code), start, end ?? start, tradeType) });
}
