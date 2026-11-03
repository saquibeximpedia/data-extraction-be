/**
 * Runs a country's extractor for some months the way the engine would, without the engine,
 * database or storage, and writes one CSV per month and flow with a summary of each.
 *
 *   npx tsx scripts/month-check.ts <CC> <out-dir> <YYYY-MM>[,<YYYY-MM>…] [hs codes…] [--flow IMPORT|EXPORT] [--dataset ID]
 *
 * With no HS codes a whole-month source (allHsCodes) keeps every code. --dataset reads that dataset
 * for every month, as choosing it on the extract page would (it holds one flow, so give --flow too).
 */
import fs from 'fs';
import path from 'path';
import { findCountry, isExtractable } from '../src/countries';
import { TradeFlow } from '../src/types';

// Same escaping as services/export.service.ts
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => args[args.indexOf(name) + 1] && args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const dataset = option('--dataset');
  const flow = option('--flow') as TradeFlow | undefined;
  const [code, outDir, periodArg, ...codeArgs] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const country = code && findCountry(code);
  if (!country || !isExtractable(country) || !outDir || !periodArg) throw new Error('usage: tsx scripts/month-check.ts <CC> <out-dir> <YYYY-MM>[,…] [hs codes…] [--flow IMPORT|EXPORT] [--dataset ID]');
  if (dataset && !flow) throw new Error('A dataset holds one flow: add --flow IMPORT or --flow EXPORT');

  const hsCodes = codeArgs.map((c) => country.normalizeHsCode(c));
  if (hsCodes.some((c) => !c)) throw new Error(`Invalid HS code for ${country.code} in: ${codeArgs.join(' ')}`);
  if (!hsCodes.length && !country.allHsCodes) throw new Error(`${country.code} needs HS codes`);
  const periods = periodArg.split(',');
  const split = country.splitQueries ?? ((codes: string[], ps: string[], flow: TradeFlow) => codes.flatMap((c) => ps.map((p) => ({ hsCodes: [c], periods: [p], tradeType: flow }))));
  const queries = (flow ? [flow] : country.tradeTypes).flatMap((f) => split(hsCodes as string[], periods, f));
  console.log(`${country.code}: ${queries.length} request(s), ${hsCodes.length ? `${hsCodes.length} HS code(s)` : 'every HS code'}${dataset ? `, dataset ${dataset}` : ''}`);

  for (const query of queries) {
    const started = Date.now();
    const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
    const label = `${query.periods.join(',')} ${query.tradeType.padEnd(6)}`;
    let months;
    try {
      months = await country.fetchRecords(query, new AbortController().signal, { dataset });
    } catch (err: any) {
      console.log(`${label} FAILED: ${err.message}`);
      continue;
    }
    if (!months.size) console.log(`${label} no rows (not published, or no trade for these codes) · ${seconds()}s`);
    for (const [period, rows] of months) {
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const file = path.join(outDir, country.code, period.slice(0, 4), `${country.code}_${period}_${query.tradeType}.csv`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '﻿' + [keys.map(escapeCell).join(','), ...rows.map((r) => keys.map((k) => escapeCell(r[k])).join(','))].join('\n'));
      const codes = new Set(rows.map((r) => r.hs_code));
      const lengths = [...new Set([...codes].map((c) => String(c).length))].sort().join('/');
      console.log(`${period} ${query.tradeType.padEnd(6)} ${String(rows.length).padStart(6)} rows · ${String(codes.size).padStart(5)} HS codes (${lengths} digits) · ${seconds()}s → ${path.relative(outDir, file)}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
