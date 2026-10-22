import { app } from './app';
import { env } from './config/env';
import { listCountries, missingConfig } from './countries';
import { ledgerService } from './services/ledger.service';
import { storageService } from './services/storage.service';

// Anything still marked running was cut off by a restart; the next run of those months retries it
const recovered = ledgerService.recoverInterrupted();
if (recovered.runs || recovered.tasks) {
  console.warn(`♻️  Marked ${recovered.runs} run(s) INTERRUPTED and ${recovered.tasks} task(s) FAILED after an unclean shutdown.`);
}

for (const country of listCountries()) {
  const missing = missingConfig(country);
  console.log(`🌍 ${country.code} (${country.name})${missing.length ? ` - disabled, set ${missing.join(', ')}` : ''}`);
}

const server = app.listen(env.PORT, () => {
  console.log(`API running on http://localhost:${env.PORT}`);
  storageService
    .ensureBucket()
    .then(() => console.log(`🗄️  Files are stored in Supabase bucket "${env.SUPABASE_BUCKET}"`))
    .catch((err) => console.error(`❌ Supabase Storage is not reachable: ${err.message}. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.`));
});

function shutdown(signal: string) {
  console.log(`${signal} received: stopping...`);
  server.close(() => {
    ledgerService.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
