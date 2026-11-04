import fs from 'fs';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { badRequest, HttpError } from '../utils/errors';

const bucket = () => supabase.storage.from(env.SUPABASE_BUCKET);

/** Paths are "{CC}/{YYYY}/{file}": no leading slash, no "..", no empty segments */
function safePath(relativePath: string): string {
  const p = relativePath.replace(/\\/g, '/').trim();
  if (!p || p.startsWith('/') || p.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    throw badRequest(`Invalid file path: ${relativePath}`);
  }
  return p;
}

/**
 * Extracted files go to a private Supabase Storage bucket. Listing, downloading and deleting
 * them is done by the web app.
 */
export const storageService = {
  /** Creates the private bucket on first start */
  async ensureBucket(): Promise<void> {
    const { data } = await supabase.storage.getBucket(env.SUPABASE_BUCKET);
    if (data) return;
    const { error } = await supabase.storage.createBucket(env.SUPABASE_BUCKET, { public: false });
    if (error && !/already exists/i.test(error.message)) throw new Error(`Could not create bucket ${env.SUPABASE_BUCKET}: ${error.message}`);
  },

  /** Uploads a local file, replacing any file at that path */
  async uploadFile(relativePath: string, localPath: string, contentType: string): Promise<void> {
    const body = await fs.promises.readFile(localPath);
    const { error } = await bucket().upload(safePath(relativePath), body, { upsert: true, contentType });
    if (error) throw new HttpError(502, `Upload: ${error.message}`);
  },

  /** Names of the files directly in a folder */
  async list(folder: string): Promise<string[]> {
    const { data, error } = await bucket().list(safePath(folder), { limit: 1000 });
    if (error) throw new HttpError(502, `List: ${error.message}`);
    return data.filter((entry) => entry.id !== null).map((entry) => entry.name);
  },

  /** Every file under a folder, at any depth, as paths from the bucket's root */
  async listTree(folder: string): Promise<{ path: string; size: number }[]> {
    const out: { path: string; size: number }[] = [];
    const walk = async (prefix: string): Promise<void> => {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await bucket().list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
        if (error) throw new HttpError(502, `List: ${error.message}`);
        for (const entry of data) {
          const p = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.id === null) await walk(p);
          else if (!entry.name.startsWith('.')) out.push({ path: p, size: Number(entry.metadata?.size ?? 0) });
        }
        if (data.length < 1000) return;
      }
    };
    await walk(folder ? safePath(folder) : '');
    return out;
  },

  /** Downloads a file to a local path */
  async download(relativePath: string, localPath: string): Promise<void> {
    const { data, error } = await bucket().download(safePath(relativePath));
    if (error) throw new HttpError(/not.?found/i.test(error.message) ? 404 : 502, `Download ${relativePath}: ${error.message || 'failed'}`);
    await fs.promises.writeFile(localPath, Buffer.from(await data.arrayBuffer()));
  },

  /** Removes files if they exist (e.g. a month's CSV once it is stored zipped instead) */
  async removeFiles(relativePaths: string[]): Promise<void> {
    const { error } = await bucket().remove(relativePaths.map(safePath));
    if (error) throw new HttpError(502, `Delete: ${error.message}`);
  },
};
