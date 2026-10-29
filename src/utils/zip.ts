import fs from 'fs';
import zlib from 'zlib';

/** Plain zip (no ZIP64): each part stays far below 4 GB, since parts are capped by the upload limit */
const ZIP_LIMIT = 0xffffffff;
// Bit 3: sizes in a data descriptor after the data; bit 11: UTF-8 names
const FLAGS = 0x0808;

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Writes a zip file holding one deflated entry, streamed: text goes in with `write`, and
 * `compressedBytes` says how big the file has grown so far (to start a new part in time).
 */
export class ZipFileWriter {
  private readonly out: fs.WriteStream;
  private readonly deflate = zlib.createDeflateRaw({ level: 6 });
  private readonly name: Buffer;
  private readonly stamp = dosDateTime(new Date());
  private crc = 0;
  private size = 0;
  private compressed = 0;

  constructor(file: string, entryName: string) {
    this.out = fs.createWriteStream(file);
    this.name = Buffer.from(entryName, 'utf-8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(this.stamp.time, 10);
    header.writeUInt16LE(this.stamp.date, 12);
    header.writeUInt16LE(this.name.length, 26);
    this.out.write(Buffer.concat([header, this.name]));
    this.deflate.on('data', (chunk: Buffer) => {
      this.compressed += chunk.length;
      this.out.write(chunk);
    });
  }

  /** Zip file size so far (deflate holds back a little until it is flushed) */
  get compressedBytes(): number {
    return 30 + this.name.length + this.compressed;
  }

  async write(text: string): Promise<void> {
    const chunk = Buffer.from(text, 'utf-8');
    this.crc = zlib.crc32(chunk, this.crc);
    this.size += chunk.length;
    if (!this.deflate.write(chunk)) await new Promise((resolve) => this.deflate.once('drain', resolve));
  }

  /** Finishes the entry and the zip's directory, and closes the file */
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.deflate.once('end', resolve);
      this.deflate.once('error', reject);
      this.deflate.end();
    });
    if (this.size > ZIP_LIMIT || this.compressedBytes > ZIP_LIMIT) throw new Error('A zip part would pass 4 GB; lower the upload limit');

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(this.crc >>> 0, 4);
    descriptor.writeUInt32LE(this.compressed, 8);
    descriptor.writeUInt32LE(this.size, 12);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(FLAGS, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(this.stamp.time, 12);
    record.writeUInt16LE(this.stamp.date, 14);
    record.writeUInt32LE(this.crc >>> 0, 16);
    record.writeUInt32LE(this.compressed, 20);
    record.writeUInt32LE(this.size, 24);
    record.writeUInt16LE(this.name.length, 28);
    // The entry starts at the beginning of the file (offset 0)

    const directoryAt = this.compressedBytes + descriptor.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(record.length + this.name.length, 12);
    end.writeUInt32LE(directoryAt, 16);

    await new Promise<void>((resolve, reject) => {
      this.out.once('error', reject);
      this.out.end(Buffer.concat([descriptor, record, this.name, end]), resolve);
    });
  }
}
