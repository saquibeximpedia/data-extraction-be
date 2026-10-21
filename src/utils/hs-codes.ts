/**
 * Splits user input like "0101, 0202", one code per line, or pasted CSV tables with descriptions
 * into distinct non-empty HS code tokens, ignoring descriptions and header lines.
 */
export function splitHsInput(input: string | string[] | undefined): string[] {
  if (!input) return [];
  const rawList = Array.isArray(input) ? input : [input];
  const codes = new Set<string>();

  for (const item of rawList) {
    if (!item) continue;
    for (const line of item.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let first = '';
      if (trimmed.startsWith('"')) {
        const match = trimmed.match(/^"((?:[^"]|"")*)"/);
        first = match ? match[1] : (trimmed.split(/[,;\t]/)[0] ?? '');
      } else {
        const delimiter = /[,;\t]/.test(trimmed) ? /[,;\t]/ : /\s+/;
        const parts = trimmed.split(delimiter).map((p) => p.trim());
        const digitParts = parts
          .map((p) => p.replace(/["'=]/g, '').replace(/[.\s]/g, '').trim())
          .filter((p) => /^\d{2,12}$/.test(p));
        if (digitParts.length > 1) {
          for (const dp of digitParts) codes.add(dp);
          continue;
        }
        first = parts[0] ?? '';
      }

      const code = first.replace(/["'=]/g, '').replace(/[.\s]/g, '').trim();
      if (/^\d{2,12}$/.test(code)) {
        codes.add(code);
      }
    }
  }

  return [...codes];
}

/**
 * Reads HS codes from CSV text: extracts only the HS code from the first column,
 * ignoring descriptions, header rows, Excel formulas (e.g. ="01012100000"), quotes,
 * and trailing commas.
 */
export function parseHsCsv(csv: string): string[] {
  const codes = new Set<string>();
  const cleanCsv = csv.replace(/^\uFEFF/, '');
  for (const line of cleanCsv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let first = '';
    if (trimmed.startsWith('"')) {
      const match = trimmed.match(/^"((?:[^"]|"")*)"/);
      first = match ? match[1] : (trimmed.split(/[,;\t]/)[0] ?? '');
    } else {
      first = trimmed.split(/[,;\t]/)[0] ?? '';
    }

    const code = first.replace(/["'=]/g, '').replace(/[.\s]/g, '').trim();
    if (/^\d{2,12}$/.test(code)) {
      codes.add(code);
    }
  }
  return [...codes];
}

