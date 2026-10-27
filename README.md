# Trade Data Extraction Service (Node.js)

A Node.js / Express / TypeScript service that **only extracts**: it pulls customs trade data from government sources on request and writes one CSV per country-month to Supabase Storage.

Everything people see and manage lives in the web app (`../frontend`, Next.js): sign-in, accounts, countries and their months, extraction history, and files. The web app works while this service is down. Only extracting and watching live extractions need the service.

---

## What this service does and doesn't do

| This service | The web app |
|---|---|
| Runs extractions (`POST /api/extractions`) | Sign-in, accounts and roles |
| Live extractions, logs, stopping a run | Countries, admin edits, download-only countries |
| Writes runs, files and "extracting" months to Supabase | Month status (completed / extracting / not done) |
| Publishes its extractor list to the database on start-up | Extraction history, files (list, download, zip, delete, upload) |

It still checks that each request carries a valid Supabase session (it never signs anyone in), and `ALLOWED_IPS` applies to every route.

---

## Setup

Requires Node.js 22.13+ and a Supabase project.

1. In Supabase, open **Project Settings → API** and copy the project URL and the **service_role** key.
2. Open the **SQL editor** and run [`supabase/schema.sql`](supabase/schema.sql). It is safe to run again, and it adds the `extractor` columns to an existing database.
3. Configure and start:

   ```bash
   cp .env.example .env     # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (and BPS_API_KEY for Indonesia)
   npm install
   npm run dev              # or: npm run build && npm run start:prod
   ```

   On start-up the service checks the tables, marks runs left `RUNNING` as `INTERRUPTED`, creates the private bucket `SUPABASE_BUCKET` if needed, and **publishes its extractors** (name, source, lag, flows, HS code counts, enabled or not) to `country_config.extractor`. The web app reads that list, so start the service once after adding a country.

4. Point the web app at it: `NEXT_PUBLIC_EXTRACTION_SERVICE_URL` in the web app, or **Settings** in the app (saved per browser, so a service on `localhost` works too).

The service_role key bypasses all Supabase security, so it stays in this server's `.env`. The browser calls this service directly, and CORS is open; protection comes from the Supabase session check and `ALLOWED_IPS`.

---

## REST API

Errors are `{ "error": "...", ...details }`. Every route checks `ALLOWED_IPS`. Except for health, every route needs `Authorization: Bearer <Supabase access token>`.

| Method & path | Purpose |
|---|---|
| `GET /api/health` | **No sign-in needed.** `{ status, environment, isProd, running, countries, startedAt }`. The web app polls this to show the service as live or offline. |
| `GET /api/countries` | What this service can extract now: per country `enabled`, `missingConfig`, source, lag, flows, `hsCodeCount`, `testHsCodeCount` |
| `POST /api/extractions` | `{ countryCode, startDate, endDate, tradeType, mode, hsCodes? }` → `202 { runId }`; marks the months extracting |
| `GET /api/runs` | Extractions running on this service, with live stats |
| `GET /api/runs/:id` | One run: live stats while running, otherwise as stored |
| `GET /api/runs/:id/logs` | Logs while the run is live (dropped when it ends) |
| `POST /api/runs/:id/stop` | Stop a run; requests in flight finish, and files are saved for the months that returned rows |

---

## How an extraction runs

1. A request names a country, a month or range, a flow (or both) and the HS codes (the saved complete or test list, or typed-in codes). Only one extraction per country runs at a time.
2. The country splits the work into **requests** (`splitQueries`), shaped by what its source returns in one call:
   - **South Africa**: one download per flow and month covering every chapter the codes are in.
   - **Indonesia**: one request per HS code, flow and year.
   - **Japan**: one request per flow, year and batch of up to 20 HS codes (codes of one heading stay together).
   - **Thailand** (the default): one request per HS code, month and flow.
3. Requests run in parallel within the country's concurrency and rate limits, and temporary errors are retried with backoff. Each request ends with rows, with 0 records, or failed.
4. The run's rows are collected in temporary local files. Each month that returned rows is then written to `{CC}/{YYYY}/{CC}_{YYYY-MM}.csv`, replacing the previous file. Files are also written when a run is stopped part-way.

Starting an extraction marks its months **extracting**. A month becomes **completed** only when a user marks it in the web app.

**Flags.** If `EMPTY_STREAK_FLAG_AT` requests in a row (default 300) return 0 records, the run is flagged: there is no data there, or the source may be restricting requests. A month with no records at all gets an `EMPTY_MONTH` flag.

**Logs and stats.** Logs are kept in memory while a run is live. Live stats are served from memory and saved to Supabase every few seconds.

---

## What the files contain

Files hold the source's own data, untouched; filtering happens downstream.

| Code | Columns |
|------|---------|
| `ZAF` | The SARS file exactly as delivered: its 21 columns with the cell text unchanged (written as CSV). |
| `THA` | Every field of the MOC response, with `request_hs_code` and `trade_flow` in front. |
| `IDN` | Every field of the BPS response, with `request_hs_code` and `trade_flow` in front. |
| `JPN` | One row per 9-digit commodity code, partner country and month: `trade_flow`, `hs_code`, `country_code`, `country_name`, `year`, `month`, `unit1`, `quantity1`, `unit2`, `quantity2`, `value_1000_yen`. Rows without trade are left out. |

Supabase limits the size of one stored file (50 MB on the free plan; raise it under **Storage → Settings** on paid plans).

---

## Countries

| Code | Source | Default lag | HS codes accepted | Needs |
|------|--------|-----|-------------------|-------|
| `IDN` | BPS DataExim API | 2 months | 8-digit tariff lines | `BPS_API_KEY` |
| `JPN` | e-Stat API (Ministry of Finance trade statistics) | 2 months | 9-digit statistical codes (4–6 digits return every code under them) | `ESTAT_APP_ID` |
| `THA` | Thailand MOC trade report API | 2 months | 4–11 digits | — |
| `ZAF` | SARS Trade Statistics portal | 2 months | 8-digit tariff lines (4–6 digits return every line under them) | — |

**South Africa** has no API. `south-africa.ts` fills in the portal's download form over plain HTTP (ASP.NET postbacks) and reads the workbook. The portal accepts many chapters in one query, so each download is one month of every needed chapter (about 40 s for all chapters), two at a time. Several months of heavy chapters in one query can stall the portal, so months are not combined.

**Japan** reads the e-Stat tables "Commodity by Country Import / Export". e-Stat re-issues a year's table under a new ID every month, so `japan.ts` looks up the current table for each flow and year (cached for 30 minutes) instead of hard-coding IDs. Import and export use different 9-digit codes: a 9-digit code a flow lacks returns that flow's codes under its 6-digit subheading.

**Start month.** A country can set `startPeriod`, the earliest month it has data for (Japan: 2026-01). Admins can change it in the web app; the service refuses extractions that start earlier.

### Adding an extracted country

1. Create `src/countries/<name>.ts` exporting a `Country` (see `country.types.ts`; `thailand.ts` is the shortest example). `fetchRecords` returns the rows per month. Add `splitQueries` when one call can answer several codes or months.
2. Add it to the list in `src/countries/index.ts`.
3. Put its HS codes in `storage/hs_codes/{CC}.csv` and a short `{CC}_TEST.csv` (the first column is read; headers are ignored).
4. Restart the service: it publishes the new country, and the web app shows it.

`getJson` throws a `RetryableError` for 429/5xx/network failures, which the engine retries.

---

## Project structure

```
supabase/schema.sql      # Tables: runs, country_config (+ extractor columns), month_status
src/
├── server.ts            # Start-up: check tables, recover runs, publish extractors, create the bucket, listen
├── app.ts               # Express app: JSON, logging, /api routes, error handler
├── config/              # env.ts (validated environment), supabase.ts (service-role client)
├── countries/           # One file per extracted source + index.ts (the list)
├── routes/ · controllers/ · middlewares/ · schemas/
├── services/
│   ├── extraction.service.ts   # Plan runs; run requests with limits, retries and flags
│   ├── registry.service.ts     # The extractor list: served at /api/countries, published to the database
│   ├── db.service.ts           # Writes runs, "extracting" months and the extractor list
│   ├── export.service.ts       # A run's rows → one CSV per country-month
│   ├── storage.service.ts      # Creates the bucket, uploads the CSVs
│   └── hs-codes.service.ts     # storage/hs_codes/{CC}.csv (server-side only)
├── utils/               # http, errors, period, concurrency, hs-codes, client-ip, xlsx
└── types/index.ts
```

Key settings (see `.env.example` for all):

| Variable | Default | Meaning |
|----------|---------|---------|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | — | Supabase project (required) |
| `SUPABASE_BUCKET` | `trade-exports` | Private bucket for files (the web app must use the same one) |
| `ALLOWED_IPS` | empty (all) | Comma-separated IPs allowed to call the service |
| `EMPTY_STREAK_FLAG_AT` | `300` | Requests in a row with 0 records before a run is flagged |
| `MAX_CONCURRENT_EXTRACTIONS` / `MAX_CONCURRENT_PER_COUNTRY` | `4` / `2` | Requests at once, overall / per country (a country can set its own) |
