import { Request, Response } from 'express';
import { parse } from '../middlewares/validate.middleware';
import { runsQuerySchema } from '../schemas';
import { extractionService } from '../services/extraction.service';
import { ledgerService } from '../services/ledger.service';
import { badRequest, notFound } from '../utils/errors';

/** GET /api/runs?limit= → newest runs with live stats */
export function list(req: Request, res: Response): void {
  const { limit } = parse(runsQuerySchema, req.query);
  const runs = ledgerService.listRuns(limit).map((r) => ({
    ...r,
    logs: extractionService.getLogs(r.id),
  }));
  res.json({ count: runs.length, runs });
}

/** GET /api/runs/:id */
export function getOne(req: Request, res: Response): void {
  const run = ledgerService.getRun(String(req.params.id));
  if (!run) throw notFound('Run not found');
  res.json({
    ...run,
    logs: extractionService.getLogs(run.id),
  });
}

/** POST /api/runs/:id/stop → aborts a running extraction */
export function stop(req: Request, res: Response): void {
  const runId = String(req.params.id);
  const stopped = extractionService.stopRun(runId);
  if (!stopped) {
    throw badRequest('Run is not currently running or cannot be stopped');
  }
  res.json({ success: true, message: 'Run stopped successfully', runId });
}

/** GET /api/runs/:id/logs → returns log history for this run */
export function logs(req: Request, res: Response): void {
  const runId = String(req.params.id);
  const logList = extractionService.getLogs(runId);
  res.json({ runId, count: logList.length, logs: logList });
}
