import { Request, Response } from 'express';
import { db } from '../services/db.service';
import { extractionService } from '../services/extraction.service';
import { badRequest, notFound } from '../utils/errors';

/** GET /api/runs → extractions running on this service (history is read from the database by the web app) */
export function list(_req: Request, res: Response): void {
  const runs = extractionService.liveRuns();
  res.json({ count: runs.length, runs });
}

/** GET /api/runs/:id → live stats while running, otherwise the stored run */
export async function getOne(req: Request, res: Response): Promise<void> {
  const run = await db.getRun(String(req.params.id));
  if (!run) throw notFound('Run not found');
  res.json(extractionService.withLiveStats(run));
}

/** POST /api/runs/:id/stop */
export function stop(req: Request, res: Response): void {
  const runId = String(req.params.id);
  if (!extractionService.stopRun(runId)) throw badRequest('This extraction is not running.');
  res.json({ success: true, runId });
}

/** GET /api/runs/:id/logs: only while the run is live */
export function logs(req: Request, res: Response): void {
  const runId = String(req.params.id);
  const logList = extractionService.getLogs(runId);
  res.json({ runId, count: logList.length, logs: logList });
}
