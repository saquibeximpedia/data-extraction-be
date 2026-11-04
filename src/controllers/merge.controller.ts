import { Request, Response } from 'express';
import { currentCaller } from '../middlewares/auth.middleware';
import { mergeService } from '../services/merge.service';

/** POST /api/merges { paths, name? } → 202 + the merge; it runs in the background */
export async function start(req: Request, res: Response): Promise<void> {
  const job = await mergeService.start(req.body.paths, req.body.name, currentCaller(res).username);
  res.status(202).json(job);
}

/** GET /api/merges → merges running or finished since the service started, newest first */
export function list(_req: Request, res: Response): void {
  res.json({ merges: mergeService.list() });
}

/** GET /api/merges/:id → one merge's progress */
export function getOne(req: Request, res: Response): void {
  res.json(mergeService.get(String(req.params.id)));
}
