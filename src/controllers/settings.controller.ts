import { Request, Response } from 'express';
import { settingsService } from '../services/settings.service';

/** GET /api/settings → the extraction settings in force, and their .env defaults */
export function get(_req: Request, res: Response): void {
  res.json({ settings: settingsService.get(), defaults: settingsService.defaults() });
}

/** PUT /api/settings (admins) → changes some settings; they apply to requests from now on */
export function update(req: Request, res: Response): void {
  res.json({ settings: settingsService.update(req.body), defaults: settingsService.defaults() });
}
