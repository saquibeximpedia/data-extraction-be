import { Request, Response } from 'express';
import { currentUser } from '../middlewares/auth.middleware';
import { parse } from '../middlewares/validate.middleware';
import { countryPatchSchema, markMonthsSchema, newCountrySchema, unmarkMonthsSchema } from '../schemas';
import { countryService } from '../services/country.service';
import { db } from '../services/db.service';
import { badRequest } from '../utils/errors';
import { periodRange, toPeriod } from '../utils/period';

const MAX_MARK_MONTHS = 240;

function periodsBetween(start: string, end: string): string[] {
  try {
    const periods = periodRange(toPeriod(start), toPeriod(end));
    if (periods.length > MAX_MARK_MONTHS) throw new Error(`Range covers ${periods.length} months; the limit is ${MAX_MARK_MONTHS}.`);
    return periods;
  } catch (err: any) {
    throw badRequest(err.message);
  }
}

/** GET /api/countries */
export async function list(_req: Request, res: Response): Promise<void> {
  res.json({ countries: await countryService.list() });
}

/** POST /api/countries/:code/months { start, end } or { periods }, optional status */
export async function markMonths(req: Request, res: Response): Promise<void> {
  const country = await countryService.get(String(req.params.code));
  const body = parse(markMonthsSchema, req.body);
  const periods = body.periods?.length ? [...new Set(body.periods.map((p) => periodsBetween(p, p)[0]))] : periodsBetween(body.start!, body.end ?? body.start!);
  const added = await db.markMonths(country.code, periods, currentUser(res).email, body.status);
  res.json({ added, country: await countryService.get(country.code) });
}

/** POST /api/countries/:code/months/remove { periods } (files are kept) */
export async function unmarkMonths(req: Request, res: Response): Promise<void> {
  const country = await countryService.get(String(req.params.code));
  const { periods } = parse(unmarkMonthsSchema, req.body);
  const removed = await db.unmarkMonths(country.code, periods.map((p) => toPeriod(p)));
  res.json({ removed, country: await countryService.get(country.code) });
}

/** PATCH /api/countries/:code (admin) */
export async function update(req: Request, res: Response): Promise<void> {
  const patch = parse(countryPatchSchema, req.body);
  res.json(await countryService.update(String(req.params.code), patch, currentUser(res).email));
}

/** POST /api/countries (admin): a download-only country */
export async function create(req: Request, res: Response): Promise<void> {
  const body = parse(newCountrySchema, req.body);
  res.status(201).json(await countryService.createManual(body, currentUser(res).email));
}

/** DELETE /api/countries/:code (admin): a download-only country */
export async function remove(req: Request, res: Response): Promise<void> {
  await countryService.removeManual(String(req.params.code));
  res.json({ deleted: String(req.params.code).toUpperCase() });
}
