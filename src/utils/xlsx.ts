import JSZip from 'jszip';

const decodeXml = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Text of every <t> inside an XML fragment (rich text runs are concatenated) */
const textOf = (xml: string) => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([^<]*)<\/(?:\w+:)?t>/g)].map((m) => decodeXml(m[1])).join('');

/** "AB12" → 27 (0-based column index) */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Non-empty rows only: a self-closing <row/> must not swallow the next row's cells
const ROW = /<(?:\w+:)?row\b[^>]*(?<!\/)>([\s\S]*?)<\/(?:\w+:)?row>/g;
const CELL = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;

function parseRow(rowXml: string, shared: string[]): string[] {
  const row: string[] = [];
  for (const [, attrs, body = ''] of rowXml.matchAll(CELL)) {
    const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
    const type = attrs.match(/\bt="([^"]*)"/)?.[1];
    const raw = body.match(/<(?:\w+:)?v>([^<]*)<\/(?:\w+:)?v>/)?.[1];
    const value =
      type === 's' ? shared[Number(raw)] ?? '' : type === 'inlineStr' ? textOf(body) : raw === undefined ? '' : decodeXml(raw);
    row[ref ? columnIndex(ref) : row.length] = value.trim();
  }
  return Array.from(row, (v) => v ?? '');
}

/**
 * Calls `onRow` with the cell text of each row of an .xlsx file's first worksheet, in order.
 *
 * A small reader for generated workbooks, which ExcelJS can't open when their XML uses
 * namespace prefixes (<x:row>, <x:c>), as files written by the .NET OpenXML SDK do.
 * The sheet is streamed, so memory stays flat however many rows it has.
 * Values come back as written in the file: no number formats or dates are applied.
 */
export async function eachSheetRow(file: Buffer, onRow: (cells: string[]) => void): Promise<void> {
  const zip = await JSZip.loadAsync(file);
  const sheetPath = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
    .sort()[0];
  if (!sheetPath) return;

  const sharedXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';
  const shared = [...sharedXml.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1]));

  const decoder = new TextDecoder();
  let pending = '';
  const consume = (text: string) => {
    pending += text;
    let end = 0;
    ROW.lastIndex = 0;
    for (let m; (m = ROW.exec(pending)); end = ROW.lastIndex) onRow(parseRow(m[1], shared));
    pending = pending.slice(end);
  };

  await new Promise<void>((resolve, reject) => {
    zip
      .file(sheetPath)!
      .nodeStream('nodebuffer')
      .on('data', (chunk: Buffer) => {
        try {
          consume(decoder.decode(chunk, { stream: true }));
        } catch (err) {
          reject(err);
        }
      })
      .on('error', reject)
      .on('end', () => {
        try {
          consume(decoder.decode());
          resolve();
        } catch (err) {
          reject(err);
        }
      });
  });
}
