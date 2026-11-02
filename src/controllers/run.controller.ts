import { Request, Response } from 'express';
import { db } from '../services/db.service';
import { extractionService } from '../services/extraction.service';
import { heldService } from '../services/held.service';
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

/** GET /api/runs/:id/held → files of a run saved to the user's device, still waiting to be saved there */
export async function heldList(req: Request, res: Response): Promise<void> {
  const files = await heldService.list(String(req.params.id));
  res.json({ count: files.length, files });
}

/** GET /api/runs/:id/held/file?path={CC}/{YYYY}/{file} → the file itself, streamed */
export async function heldFile(req: Request, res: Response): Promise<void> {
  const { file, size, name } = await heldService.open(String(req.params.id), String(req.query.path ?? ''));
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.type(name.endsWith('.zip') ? 'application/zip' : 'text/csv; charset=utf-8');
  await new Promise<void>((resolve, reject) => res.sendFile(file, (err) => (err && !res.headersSent ? reject(err) : resolve())));
}

/** DELETE /api/runs/:id/held { paths? } → drops files the web app saved (all of the run's when no paths) */
export async function heldRemove(req: Request, res: Response): Promise<void> {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths.map(String) : undefined;
  await heldService.remove(String(req.params.id), paths);
  res.json({ success: true });
}
