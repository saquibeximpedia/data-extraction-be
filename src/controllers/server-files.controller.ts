import { Request, Response } from 'express';
import { serverFilesService } from '../services/server-files.service';

/** GET /api/server-files → files kept on the server instead of Storage */
export async function list(_req: Request, res: Response): Promise<void> {
  const files = await serverFilesService.list();
  res.json({ count: files.length, files });
}

/** POST /api/server-files/links { paths } → a download link for each (an hour; no sign-in needed to open it) */
export function links(req: Request, res: Response): void {
  res.json({ links: Object.fromEntries((req.body.paths as string[]).map((p) => [p, serverFilesService.link(p)])) });
}

/** DELETE /api/server-files { paths } → removes them from the server */
export async function remove(req: Request, res: Response): Promise<void> {
  await serverFilesService.remove(req.body.paths);
  res.json({ success: true });
}

/** GET /api/server-files/download?path&expires&sig → the file, streamed (the link is its own sign-in) */
export async function download(req: Request, res: Response): Promise<void> {
  const { file, size, name } = await serverFilesService.openSigned(req.query);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.type(name.endsWith('.zip') ? 'application/zip' : 'text/csv; charset=utf-8');
  await new Promise<void>((resolve, reject) => res.sendFile(file, (err) => (err && !res.headersSent ? reject(err) : resolve())));
}
