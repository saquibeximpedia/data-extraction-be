import readline from 'readline';

/** A value as a CSV cell, quoted when it holds a comma, quote or line break */
export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * The records of a CSV as their text (without the line end), streamed: a quoted cell can hold
 * line breaks, so a record runs on until no quote is left open. A leading BOM is dropped.
 */
export async function* csvRecords(input: NodeJS.ReadableStream): AsyncGenerator<string> {
  let pending: string | null = null;
  let quoted = false;
  let first = true;
  for await (let line of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (first) {
      line = line.replace(/^﻿/, '');
      first = false;
    }
    pending = pending === null ? line : `${pending}\n${line}`;
    if ((line.match(/"/g)?.length ?? 0) % 2) quoted = !quoted;
    if (quoted) continue;
    yield pending;
    pending = null;
  }
  if (pending !== null) yield pending;
}

/** A record's cells, unquoted */
export function parseRecord(text: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}
