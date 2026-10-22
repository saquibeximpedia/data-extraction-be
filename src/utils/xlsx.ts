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

/**
 * Reads the first worksheet of an .xlsx file as rows of cell text.
 *
 * A small reader for generated workbooks, which ExcelJS can't open when their XML uses
 * namespace prefixes (<x:row>, <x:c>), as files written by the .NET OpenXML SDK do.
 * Values come back as written in the file: no number formats or dates are applied.
 */
export async function readFirstSheet(file: Buffer): Promise<string[][]> {
  const zip = await JSZip.loadAsync(file);
  const sheetPath = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
    .sort()[0];
  if (!sheetPath) return [];

  const sharedXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';
  const shared = [...sharedXml.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1]));

  const sheetXml = await zip.file(sheetPath)!.async('string');
  const rows: string[][] = [];
  for (const [, rowXml] of sheetXml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const row: string[] = [];
    for (const [, attrs, body = ''] of rowXml.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/\bt="([^"]*)"/)?.[1];
      const raw = body.match(/<(?:\w+:)?v>([^<]*)<\/(?:\w+:)?v>/)?.[1];
      const value =
        type === 's' ? shared[Number(raw)] ?? '' : type === 'inlineStr' ? textOf(body) : raw === undefined ? '' : decodeXml(raw);
      row[ref ? columnIndex(ref) : row.length] = value.trim();
    }
    rows.push(Array.from(row, (v) => v ?? ''));
  }
  return rows;
}
