/**
 * Writes storage/hs_codes/TUR.csv: every 12-digit GTİP code with trade (either flow) in a year,
 * with its Turkish description, read from TÜİK's dashboard engine. Codes retired before that year
 * have no trade in it, so they are left out.
 *
 *   npx tsx scripts/tur-hs-codes.ts [YYYY]        (default: this year)
 *
 * Run it again each January: TÜİK's codes change with the yearly tariff, and a code new that year
 * is only extracted once it is in the list.
 */
import fs from 'fs';
import path from 'path';
import { QlikSession } from '../src/countries/turkey';

const escapeCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

async function main() {
  const year = Number(process.argv[2] ?? new Date().getFullYear());
  if (!Number.isInteger(year)) throw new Error('usage: tsx scripts/tur-hs-codes.ts [YYYY]');
  const { session, doc } = await QlikSession.open();
  try {
    await session.select(doc, 'YIL', [year]);
    // An unknown year is skipped without an error, and the list would then be every year's codes
    if ((await session.selections(doc)).get('YIL')?.text !== String(year)) throw new Error(`TÜİK has no data for ${year}`);
    const rows = await session.table(doc, ['ISTPOZ', 'ISTPOZ_ADI'], ['Sum(DOLAR) + Sum(MIKTAR_1)']);
    const codes = new Map(rows.map(([code, name]) => [(code.qText ?? '').padStart(12, '0'), name.qText ?? '']));
    const bad = [...codes.keys()].filter((c) => !/^\d{12}$/.test(c));
    if (bad.length) throw new Error(`unexpected codes from TÜİK: ${bad.slice(0, 5).join(', ')}`);

    const file = path.resolve(process.cwd(), 'storage/hs_codes/TUR.csv');
    const lines = [...codes].sort(([a], [b]) => a.localeCompare(b)).map(([code, name]) => `${code},${escapeCell(name)}`);
    fs.writeFileSync(file, '﻿' + ['hs_code,description', ...lines].join('\n') + '\n');
    console.log(`${codes.size} codes with trade in ${year} → ${path.relative(process.cwd(), file)}`);
  } finally {
    session.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
