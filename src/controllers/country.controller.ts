import { Request, Response } from 'express';
import { currentUser } from '../middlewares/auth.middleware';
import { parse } from '../middlewares/validate.middleware';
import { countryPatchSchema, markMonthsSchema, newCountrySchema, unmarkMonthsSchema } from '../schemas';
import { countryService } from '../services/country.service';
import { ledgerService } from '../services/ledger.service';
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

/** GET /api/countries → every country with its source, settings and completed months */
export function list(_req: Request, res: Response): void {
  res.json({ countries: countryService.list() });
}

/** POST /api/countries/:code/months { start, end } or { periods } → marks them completed */
export function markMonths(req: Request, res: Response): void {
  const country = countryService.get(String(req.params.code));
  const body = parse(markMonthsSchema, req.body);
  const periods = body.periods?.length ? [...new Set(body.periods.map((p) => periodsBetween(p, p)[0]))] : periodsBetween(body.start!, body.end ?? body.start!);
  const added = ledgerService.markMonths(country.code, periods, currentUser(res).email);
  res.json({ added, country: countryService.get(country.code) });
}

/** POST /api/countries/:code/months/remove { periods } → unmarks them (stored data and files are kept) */
export function unmarkMonths(req: Request, res: Response): void {
  const country = countryService.get(String(req.params.code));
  const { periods } = parse(unmarkMonthsSchema, req.body);
  const removed = ledgerService.unmarkMonths(country.code, periods.map((p) => toPeriod(p)));
  res.json({ removed, country: countryService.get(country.code) });
}

/** PATCH /api/countries/:code (admin) → edits name, source links, notes, lag */
export function update(req: Request, res: Response): void {
  const patch = parse(countryPatchSchema, req.body);
  res.json(countryService.update(String(req.params.code), patch, currentUser(res).email));
}

/** POST /api/countries (admin) → adds a download-only country */
export function create(req: Request, res: Response): void {
  const body = parse(newCountrySchema, req.body);
  res.status(201).json(countryService.createManual(body, currentUser(res).email));
}

/** DELETE /api/countries/:code (admin) → removes a download-only country */
export function remove(req: Request, res: Response): void {
  countryService.removeManual(String(req.params.code));
  res.json({ deleted: String(req.params.code).toUpperCase() });
}
