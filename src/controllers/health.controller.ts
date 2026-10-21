import { Request, Response } from 'express';
import { env } from '../config/env';
import { ledgerService } from '../services/ledger.service';
import { schedulerService } from '../services/scheduler.service';

/** GET /api/health → scheduler state and task totals */
export function health(_req: Request, res: Response): void {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
    isProd: env.NODE_ENV === 'prod' || env.NODE_ENV === 'production',
    scheduler: {
      enabled: env.SCHEDULER_ENABLED,
      cron: env.SCHEDULER_CRON,
      autoSyncRunning: schedulerService.isBusy(),
      lookbackMonths: env.AUTO_SYNC_LOOKBACK_MONTHS,
    },
    summary: ledgerService.getSummary(),
  });
}
