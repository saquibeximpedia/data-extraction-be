import { app } from './app';
import { env } from './config/env';
import { listCountries, missingConfig } from './countries';
import { ledgerService } from './services/ledger.service';
import { schedulerService } from './services/scheduler.service';

// Anything still marked running was cut off by a restart; the next daily check retries it
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
  schedulerService.startCron();
});

function shutdown(signal: string) {
  console.log(`${signal} received: stopping...`);
  schedulerService.stopCron();
  server.close(() => {
    ledgerService.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
