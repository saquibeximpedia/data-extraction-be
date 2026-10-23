import { Request, Response } from 'express';
import { env } from '../config/env';
import { extractionService } from '../services/extraction.service';
import { registryService } from '../services/registry.service';

const startedAt = new Date().toISOString();

/**
 * GET /api/health (no sign-in needed) → the web app polls this to know whether the service is up.
 * The UI only offers the test HS code set outside production.
 */
export function health(_req: Request, res: Response): void {
  res.json({
    status: 'ok',
    service: 'trade-extraction',
    timestamp: new Date().toISOString(),
    startedAt,
    environment: env.NODE_ENV,
    isProd: env.NODE_ENV === 'prod' || env.NODE_ENV === 'production',
    running: extractionService.liveRuns().length,
    countries: registryService.list().filter((c) => c.enabled).map((c) => c.code),
  });
}
