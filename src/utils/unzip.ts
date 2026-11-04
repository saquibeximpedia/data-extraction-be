import fs from 'fs';
import { pipeline, Readable } from 'stream';
import zlib from 'zlib';

/** One file inside a zip */
export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflated */
  method: number;
  compressedSize: number;
  /** Where its data starts in the zip */
  dataOffset: number;
}

/** The end-of-central-directory record sits in the last 22 bytes, or up to 64 KB more with a comment */
const EOCD_SEARCH = 22 + 0xffff;

/**
 * The files in a zip, read from its central directory (at the end), so entries written with
 * their sizes after the data (as ZipFileWriter does) are found too. No ZIP64: parts stay far
 * below 4 GB.
 */
export async function zipEntries(file: string): Promise<ZipEntry[]> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const tailSize = Math.min(size, EOCD_SEARCH);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(`${file} is not a zip file`);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff) throw new Error(`${file} is a ZIP64 file, which is not read here`);

    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf-8', p + 46, p + 46 + nameLength);
      // The local header's own name and extra field lengths can differ from the directory's
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, localOffset);
      const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      entries.push({ name, method, compressedSize, dataOffset });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** An entry's contents, streamed and inflated */
export function entryStream(file: string, entry: ZipEntry): Readable {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: compression method ${entry.method} is not supported`);
  if (!entry.compressedSize) return Readable.from([]);
  const raw = fs.createReadStream(file, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1 });
  if (entry.method === 0) return raw;
  const inflate = zlib.createInflateRaw();
  // A read error ends the inflated stream with it, rather than leaving it open
  pipeline(raw, inflate, (err) => err && inflate.destroy(err));
  return inflate;
}
