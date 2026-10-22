import fs from 'fs';
import JSZip from 'jszip';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { badRequest, HttpError, notFound } from '../utils/errors';

export interface FileMetadata {
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
}

const bucket = () => supabase.storage.from(env.SUPABASE_BUCKET);

/** Paths are "{CC}/{YYYY}/{file}": no leading slash, no "..", no empty segments */
function safePath(relativePath: string): string {
  const p = relativePath.replace(/\\/g, '/').trim();
  if (!p || p.startsWith('/') || p.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    throw badRequest(`Invalid file path: ${relativePath}`);
  }
  return p;
}

function fail(action: string, error: { message: string }): never {
  if (/not.?found/i.test(error.message)) throw notFound(`${action}: file not found`);
  throw new HttpError(502, `${action}: ${error.message}`);
}

/**
 * Export and uploaded files, kept in a private Supabase Storage bucket. The browser never
 * gets bucket access: downloads go through short-lived signed URLs handed out by this API.
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
    await this.upload(relativePath, await fs.promises.readFile(localPath), contentType);
  },

  async upload(relativePath: string, body: Buffer, contentType: string): Promise<void> {
    const { error } = await bucket().upload(safePath(relativePath), body, { upsert: true, contentType });
    if (error) fail('Upload', error);
  },

  /** Every file, newest first (folders are walked: country → year → files) */
  async listFiles(countryCode?: string): Promise<FileMetadata[]> {
    const files: FileMetadata[] = [];
    const walk = async (prefix: string, depth: number): Promise<void> => {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await bucket().list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
        if (error) fail('List', error);
        for (const entry of data) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.id === null) {
            if (depth < 3) await walk(path, depth + 1);
          } else if (!entry.name.startsWith('.')) {
            files.push({
              fileName: entry.name,
              relativePath: path,
              sizeBytes: Number(entry.metadata?.size ?? 0),
              modifiedAt: entry.updated_at ?? entry.created_at ?? '',
            });
          }
        }
        if (data.length < 1000) return;
      }
    };
    await walk(countryCode ? countryCode.toUpperCase() : '', countryCode ? 1 : 0);
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  },

  /** A link that downloads the file for the next five minutes */
  async signedUrl(relativePath: string): Promise<string> {
    const path = safePath(relativePath);
    const { data, error } = await bucket().createSignedUrl(path, 300, { download: path.split('/').pop() });
    if (error) fail('Download', error);
    return data.signedUrl;
  },

  async deleteFiles(relativePaths: string[]): Promise<string[]> {
    const { data, error } = await bucket().remove(relativePaths.map(safePath));
    if (error) fail('Delete', error);
    return data.map((f) => f.name);
  },

  /** Streams a zip of the given files (kept under their folders) */
  async zipStream(relativePaths: string[]): Promise<NodeJS.ReadableStream> {
    const zip = new JSZip();
    for (const relativePath of relativePaths) {
      const { data, error } = await bucket().download(safePath(relativePath));
      if (error) fail(`Download ${relativePath}`, error);
      zip.file(relativePath, Buffer.from(await data.arrayBuffer()));
    }
    return zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } });
  },
};
