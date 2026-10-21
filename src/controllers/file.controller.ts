import { Request, Response } from 'express';
import { parse } from '../middlewares/validate.middleware';
import { downloadQuerySchema, filesQuerySchema } from '../schemas';
import { storageService } from '../services/storage.service';
import { notFound } from '../utils/errors';

/** GET /api/files?country= → export files, newest first */
export async function list(req: Request, res: Response): Promise<void> {
  const { country } = parse(filesQuerySchema, req.query);
  const files = await storageService.listFiles(country);
  res.json({ count: files.length, files });
}

/** GET /api/files/download?path= → the CSV as an attachment */
export async function download(req: Request, res: Response): Promise<void> {
  const { path } = parse(downloadQuerySchema, req.query);
  let stream;
  try {
    stream = await storageService.getFileStream(path);
  } catch {
    throw notFound(`File not found: ${path}`);
  }
  const fileName = path.split(/[/\\]/).pop() || 'download.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  stream.pipe(res);
}

/** DELETE /api/files?path= → deletes a file */
export async function remove(req: Request, res: Response): Promise<void> {
  const { path } = parse(downloadQuerySchema, req.query);
  try {
    await storageService.deleteFile(path);
  } catch (err: any) {
    throw notFound(`File not found: ${path}`);
  }
  res.json({ success: true, message: `File deleted: ${path}` });
}
