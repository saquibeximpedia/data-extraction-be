import { Request, Response } from 'express';
import { env } from '../config/env';

/** GET /api/health → environment (the UI only offers the test HS code set outside production) */
export function health(_req: Request, res: Response): void {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
    isProd: env.NODE_ENV === 'prod' || env.NODE_ENV === 'production',
  });
}
