import { Request, Response } from 'express';
import { currentUser } from '../middlewares/auth.middleware';
import { extractionService } from '../services/extraction.service';

/** POST /api/extractions → starts an extraction in the background (202 + run id) */
export function start(req: Request, res: Response): void {
  const { plan } = extractionService.planManual(req.body);
  const { run, done } = extractionService.startRun('MANUAL_EXTRACT', [plan], currentUser(res).email);
  done.catch((err) => console.error('Background run error:', err));
  res.status(202).json({ status: 'ACCEPTED', runId: run.id });
}
