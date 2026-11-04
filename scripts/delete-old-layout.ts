/**
 * Lists, then with --delete removes, extracted files still in the layout from before imports and
 * exports had files of their own: {CC}/{YYYY}/{CC}_{YYYY-MM}[_partN].(csv|zip), and the same under
 * _test/. Files users uploaded ({CC}_{YYYY-MM}__{name}), merged files and files in the new layout
 * ({CC}/{YYYY}/{MM}/{FLOW}/…) are never touched.
 *
 *   npx tsx scripts/delete-old-layout.ts            lists them (changes nothing)
 *   npx tsx scripts/delete-old-layout.ts --delete   removes them
 */
import { storageService } from '../src/services/storage.service';

const OLD_LAYOUT = /^(?:_test\/)?([A-Z]{2,3})\/(\d{4})\/\1_\2-\d{2}(?:_part\d+)?\.(csv|zip)$/;
const BATCH = 100;

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

(async () => {
  const remove = process.argv.includes('--delete');
  const old = (await storageService.listTree('')).filter((f) => OLD_LAYOUT.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  for (const f of old) console.log(`  ${f.path}  (${mb(f.size)})`);
  const total = old.reduce((n, f) => n + f.size, 0);
  console.log(`${old.length} extracted file(s) in the old layout, ${mb(total)}.`);
  if (!old.length) return;
  if (!remove) {
    console.log('Nothing was deleted. Run again with --delete to remove them.');
    return;
  }
  for (let i = 0; i < old.length; i += BATCH) await storageService.removeFiles(old.slice(i, i + BATCH).map((f) => f.path));
  console.log(`Deleted ${old.length} file(s), ${mb(total)}.`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
