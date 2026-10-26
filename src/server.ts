import { app } from './app';
import { env } from './config/env';
import { listCountries, missingConfig } from './countries';
import { connectDatabase } from './services/startup.service';
import { storageService } from './services/storage.service';

for (const country of listCountries()) {
  const missing = missingConfig(country);
  console.log(`🌍 ${country.code} (${country.name})${missing.length ? ` - disabled, set ${missing.join(', ')}` : ''}`);
}

const server = app.listen(env.PORT, () => {
  console.log(`API running on http://localhost:${env.PORT}`);
  connectDatabase();
  storageService
    .ensureBucket()
    .then(() => console.log(`🗄️  Files are stored in Supabase bucket "${env.SUPABASE_BUCKET}"`))
    .catch((err) => console.error(`❌ Supabase Storage is not reachable: ${err.message}. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.`));
});

function shutdown(signal: string) {
  console.log(`${signal} received: stopping...`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
