import { Request, Response } from 'express';
import { parse } from '../middlewares/validate.middleware';
import { downloadQuerySchema, filePathsSchema, filesQuerySchema, uploadQuerySchema } from '../schemas';
import { countryService } from '../services/country.service';
import { exportService } from '../services/export.service';
import { storageService } from '../services/storage.service';
import { badRequest } from '../utils/errors';
import { toPeriod } from '../utils/period';

const UPLOAD_TYPES: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  zip: 'application/zip',
};

/** GET /api/files?country= → stored files, newest first, with country, month and origin */
export async function list(req: Request, res: Response): Promise<void> {
  const { country } = parse(filesQuerySchema, req.query);
  const files = (await storageService.listFiles(country)).map((f) => ({ ...f, ...exportService.describe(f.relativePath) }));
  res.json({ count: files.length, files });
}

/** GET /api/files/url?path= → { url }: a signed link that downloads the file for five minutes */
export async function url(req: Request, res: Response): Promise<void> {
  const { path } = parse(downloadQuerySchema, req.query);
  res.json({ url: await storageService.signedUrl(path) });
}

/** POST /api/files/zip { paths } → the files as one zip, keeping their folders */
export async function zip(req: Request, res: Response): Promise<void> {
  const { paths } = parse(filePathsSchema, req.body);
  const stream = await storageService.zipStream([...new Set(paths)]);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="trade-data_${stamp}.zip"`);
  stream.on('error', (err) => res.destroy(err as Error));
  stream.pipe(res);
}

/** POST /api/files/delete { paths } */
export async function remove(req: Request, res: Response): Promise<void> {
  const { paths } = parse(filePathsSchema, req.body);
  const deleted = await storageService.deleteFiles([...new Set(paths)]);
  res.json({ deleted });
}

/**
 * PUT /api/files/upload?country=&period=&name= (raw file body) → stores a file a user
 * downloaded from a source website, under that country and month
 */
export async function upload(req: Request, res: Response): Promise<void> {
  const query = parse(uploadQuerySchema, req.query);
  const country = await countryService.get(query.country);
  const ext = query.name.split('.').pop()?.toLowerCase() ?? '';
  if (!UPLOAD_TYPES[ext]) throw badRequest(`Upload .xlsx, .xls, .csv or .zip files (got .${ext || '?'})`);
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest('The file is empty');

  let period: string;
  try {
    period = toPeriod(query.period);
  } catch (err: any) {
    throw badRequest(err.message);
  }
  const path = exportService.uploadPathFor(country.code, period, query.name);
  await storageService.upload(path, req.body, UPLOAD_TYPES[ext]);
  res.status(201).json({ path });
}
