import { Request, Response } from 'express';
import { extractionService } from '../services/extraction.service';
import { schedulerService } from '../services/scheduler.service';

/** POST /api/extractions → starts a manual run in the background (202 + run id) */
export function start(req: Request, res: Response): void {
  const { plan } = extractionService.planManual(req.body);
  const { run, done } = extractionService.startRun('MANUAL_EXTRACT', [plan], req.body.force);
  done.catch((err) => console.error('Background run error:', err));
  res.status(202).json({ status: 'ACCEPTED', runId: run.id });
}


/** POST /api/extractions/daily-check → what the scheduler does, right now */
export function dailyCheck(_req: Request, res: Response): void {
  const run = schedulerService.startDailyCheck('AUTO_SYNC_API');
  res.status(202).json({ status: 'ACCEPTED', runId: run.id });
}
