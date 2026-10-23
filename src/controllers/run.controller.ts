import { Request, Response } from 'express';
import { parse } from '../middlewares/validate.middleware';
import { runsQuerySchema } from '../schemas';
import { db } from '../services/db.service';
import { extractionService } from '../services/extraction.service';
import { badRequest, notFound } from '../utils/errors';

/** GET /api/runs?limit= */
export async function list(req: Request, res: Response): Promise<void> {
  const { limit } = parse(runsQuerySchema, req.query);
  const runs = (await db.listRuns(limit)).map((r) => extractionService.withLiveStats(r));
  res.json({ count: runs.length, runs });
}

/** GET /api/runs/:id */
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
