# Global Trade Data Extraction & Scheduler Engine (Node.js Backend)

One Node.js / Express / TypeScript service that pulls customs trade data from several countries' public APIs on a schedule, tracks every extraction in a SQLite ledger, and writes one CSV per country-month.

Each country is one small file in src/countries/; the scheduler, retries, rate limiting, ledger, exports and auth are shared. The web UI lives in its own repo (`data-extraction-web`).

---

## How the scheduler works

The scheduler ticks **daily** (`SCHEDULER_CRON`, default `0 3 * * *`). On each tick, for every enabled country it:

1. Works out the latest month the source should have published, from the country's `lagMonths` and `publishDay`.
   e.g. on 17 Oct 2026, Indonesia (2-month lag) → 2026-08, Thailand (2-month lag) → 2026-08.
2. Re-checks that month plus the previous `AUTO_SYNC_LOOKBACK_MONTHS - 1` months.
3. Breaks the work into **tasks**: one per (country, HS code, month, trade flow).
4. Skips tasks that are `COMPLETED`, runs the rest:
   - rows returned → `COMPLETED`
   - nothing returned → `NO_DATA` (not published yet, or no trade); retried on the next tick
   - error → `FAILED`; retried on the next tick until `MAX_TASK_ATTEMPTS` consecutive failures
5. Rebuilds `storage/exports/{CC}/{CC}_{YYYY-MM}.csv` for every month it touched.

Because every tick re-checks a window of months, late publications and days the server was down fill in on their own. A month where every task came back empty is reported in the run's `unpublishedPeriods`.

**Concurrency:** countries run in parallel. Each country is capped at `MAX_CONCURRENT_PER_COUNTRY` tasks and its `rateLimitPerMinute`, and the whole process at `MAX_CONCURRENT_EXTRACTIONS`. A task that is already running (e.g. the cron and a manual call overlap) is skipped, not duplicated. Only one daily check runs at a time.

**Restarts:** on boot, runs left `RUNNING` are marked `INTERRUPTED` and their in-flight tasks `FAILED`, so the next tick picks them up.

---

## Countries

| Code | Source | Lag | Flows | HS codes accepted | Needs |
|------|--------|-----|-------|-------------------|-------|
| `IDN` | BPS DataExim API | 2 months | IMPORT, EXPORT | 8-digit tariff lines | `BPS_API_KEY` |
| `THA` | Thailand MOC trade report API | 2 months | IMPORT, EXPORT | 4–11 digits | — |

A country whose required env vars are missing is listed as disabled and skipped by the scheduler.

### Adding a country

1. Create `src/countries/<name>.ts` exporting a `Country` object (see `src/countries/country.types.ts`):

   ```ts
   import { Country } from './country.types';
   import { getJson } from '../utils/http';
   import { splitPeriod } from '../utils/period';

   export const vietnam: Country = {
     code: 'VNM',
     name: 'Vietnam',
     lagMonths: 2,
     tradeTypes: ['IMPORT', 'EXPORT'],
     requiredEnv: ['VNM_API_KEY'],          // optional: stays disabled until set
     normalizeHsCode: (raw) => (/^\d{8}$/.test(raw) ? raw : null),

     async fetchRecords({ hsCode, period, tradeType }) {
       const { year, month } = splitPeriod(period);
       const rows = await getJson<any[]>(`https://example.gov.vn/api?hs=${hsCode}&y=${year}&m=${month}`);
       return rows.map((r) => ({ date: `${period}-01`, hsCode, tradeType, productDescription: '', valueUsd: r.value }));
     },
   };
   ```

2. Add it to the list in `src/countries/index.ts`.
3. Put its HS codes in `storage/hs_codes/VNM.csv` (first column is read; headers are ignored).

That's all. Return `[]` when a month isn't published yet. `getJson` throws a `RetryableError` for 429/5xx/network failures, which the extraction service retries with backoff; rate limiting (`rateLimitPerMinute`), scheduling, the ledger and CSV exports are shared. For sources that return a whole year per call, wrap the request in a `TtlCache` (see `indonesia.ts`).

---

## Project structure

A standard layered Express app: **routes → middlewares → controllers → services**, with country sources and shared helpers kept separate.

```
src/
├── server.ts            # Start-up: recover interrupted runs, listen, start the cron
├── app.ts               # Express app: JSON, logging, /api routes, error handler
├── config/env.ts        # Validated environment variables
├── countries/           # One file per data source + index.ts (the list)
│   ├── country.types.ts #   The Country interface every source implements
│   ├── indonesia.ts
│   └── thailand.ts
├── routes/              # URL → middleware → controller, one file per resource
├── middlewares/
│   ├── auth.middleware.ts      # IP allow-list, session token
│   ├── validate.middleware.ts  # zod body/query validation
│   └── error.middleware.ts     # HttpError → JSON response, 404s
├── schemas/index.ts     # Request shapes (zod)
├── controllers/         # Thin: read the request, call a service, send the response
├── services/
│   ├── extraction.service.ts   # Plan/preview manual runs; run tasks with limits + retries
│   ├── scheduler.service.ts    # Daily due-check (cron)
│   ├── ledger.service.ts       # SQLite: runs, tasks, trade records
│   ├── export.service.ts       # One CSV per country-month
│   ├── storage.service.ts      # Files on disk (path-safe)
│   ├── hs-codes.service.ts     # storage/hs_codes/{CC}.csv (server-side only)
│   └── auth.service.ts         # Password check, session tokens
├── utils/               # http (getJson, withRetry), errors, period, concurrency, cache, hs-codes, client-ip
└── types/index.ts       # Shared types: TradeRecord, Task, Run, ...
```

**Request flow, e.g. `POST /api/extractions`:** `routes/index.ts` checks the IP and token → `extraction.routes.ts` validates the body with `extractionSchema` → `extraction.controller.start` → `extractionService.planManual` (country, months, HS codes) → `extractionService.startRun` runs tasks in the background → each task calls the country's `fetchRecords` → results go to the ledger and the country-month CSV.

Errors: throw an `HttpError` (`badRequest`, `notFound`, … in `utils/errors.ts`) anywhere; `error.middleware.ts` turns it into `{ error, ...details }` with the right status. Express 5 forwards errors from async handlers automatically.

---

## Getting started

Requires Node.js 22.13+ (uses the built-in `node:sqlite`).

```bash
cp .env.example .env   # then set API_PASSWORD, JWT_SECRET and any country keys
npm install
npm run dev            # or: npm run build && npm run start:prod
```

The API runs on `http://localhost:3000` (JSON only; there is no UI on the backend).

### Web UI

The UI is a separate Next.js app in its own repo (`data-extraction-web`, port 3001); see its README for setup. The browser calls this API directly (Express already allows cross-origin requests), so the API sees each browser's real IP for its `ALLOWED_IPS` check.

The API only trusts `X-Forwarded-For` from loopback, so a client cannot fake its IP with that header.

Key settings (see `.env.example` for all):

| Variable | Default | Meaning |
|----------|---------|---------|
| `SCHEDULER_CRON` | `0 3 * * *` | When the daily due-check runs |
| `SCHEDULER_TIMEZONE` | server local | e.g. `Asia/Jakarta` |
| `SCHEDULER_RUN_ON_START` | `false` | Also run a due-check at boot |
| `AUTO_SYNC_LOOKBACK_MONTHS` | `3` | Months re-checked per tick |
| `MAX_TASK_ATTEMPTS` | `5` | Consecutive failures before auto sync gives up on a task |
| `MAX_CONCURRENT_EXTRACTIONS` | `4` | Tasks running at once, all countries |
| `MAX_CONCURRENT_PER_COUNTRY` | `2` | Tasks running at once, per country |
| `DB_PATH` | `./storage/ledger.db` | SQLite ledger |

---

## REST API

All `/api` routes check the caller's IP against `ALLOWED_IPS`. Everything except `/api/auth/login` also needs a session token: `Authorization: Bearer <token>`, or `?token=` on download links. Errors are always `{ "error": "...", ...details }`.

| Method & path | Purpose |
|---------------|---------|
| `POST /api/auth/login` | `{ "password": "..." }` → `{ token, expiresIn }` |
| `GET /api/auth/session` | 200 while the token is valid |
| `GET /api/health` | Scheduler state and task totals by status |
| `GET /api/countries` | Countries, enabled state, missing config, flows, months the daily check covers, saved-code counts |
| `GET /api/countries/:code/coverage` | Task counts per month (completed / no data / failed) |
| `POST /api/extractions` | Start a manual extraction in the background → `202 { runId }` |
| `POST /api/extractions/preview` | Same body; validates it and reports how many tasks per month are already done. Runs nothing. |
| `POST /api/extractions/daily-check` | Run the scheduler's daily check now → `202 { runId }` (409 if one is running) |
| `GET /api/runs?limit=25` / `GET /api/runs/:id` | Runs with live stats |
| `GET /api/tasks?countryCode=&status=&period=&hsCode=&limit=` | Per-task state (debugging) |
| `GET /api/files?country=` | Export files |
| `GET /api/files/download?path=THA/THA_2026-08.csv` | Download a file |

### Manual extraction body

```jsonc
{
  "countryCode": "THA",
  "startDate": "2026-06",
  "endDate": "2026-08",
  "hsCodes": "847130, 851713",  // optional: one code, or many separated by commas/new lines;
                                //   omit to use the saved list in storage/hs_codes/THA.csv
  "tradeType": "ALL",           // ALL | IMPORT | EXPORT (must be supported by the country)
  "force": true                 // default: re-extract months already done (the UI warns first via /preview)
}
```

Ranges are limited to 60 months and 1000 HS codes; codes the country rejects return a 400 listing them in `invalidHsCodes`.

The saved HS code lists are edited on the server only. The API never returns them; `/api/countries` only reports how many there are.
