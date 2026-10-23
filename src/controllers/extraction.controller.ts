import { Request, Response } from 'express';
import { currentCaller } from '../middlewares/auth.middleware';
import { db } from '../services/db.service';
import { extractionService } from '../services/extraction.service';

/** POST /api/extractions → 202 + run id; the run's months are marked extracting */
export async function start(req: Request, res: Response): Promise<void> {
  const plan = await extractionService.planManual(req.body);
  const user = currentCaller(res).email;
  const { run, done } = await extractionService.startRun('MANUAL_EXTRACT', [plan], user);
  await db.markExtracting(plan.countryCode, plan.periods, user);
  done.catch((err) => console.error('Background run error:', err));
  res.status(202).json({ status: 'ACCEPTED', runId: run.id });
}
