import { Request, Response } from 'express';
import { registryService } from '../services/registry.service';

/** GET /api/countries → what this service can extract right now (enabled, flows, saved HS code counts) */
export function list(_req: Request, res: Response): void {
  res.json({ countries: registryService.list() });
}
