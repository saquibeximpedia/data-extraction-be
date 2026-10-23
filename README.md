# Global Trade Data Extraction (Node.js Backend)

A Node.js / Express / TypeScript API that pulls customs trade data from government sources on request and stores one CSV per country-month in Supabase Storage. Everything else lives in Supabase too: sign-in (Auth), runs, country settings and month status (Postgres). The web UI is in `../frontend`.

Each source country is one file in `src/countries/`. Admins can also add **download-only** countries in the UI: sources that publish files (e.g. Excel) which users download from the website and upload here.

---

## Setup

Requires Node.js 22.13+ and a Supabase project.

1. In Supabase, open **Project Settings → API** and copy the project URL and the **service_role** key.
2. Open the **SQL editor** and run [`supabase/schema.sql`](supabase/schema.sql) (safe to run again).
3. Configure and start the API:

   ```bash
   cp .env.example .env     # set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (and BPS_API_KEY for Indonesia)
   npm install
   npm run dev              # or: npm run build && npm run start:prod
   ```

   On first start the private bucket `SUPABASE_BUCKET` (default `trade-exports`) is created. If the tables are missing, the API says so at start-up.
4. Create the first admin (later accounts are created in the UI under Admin):

   ```bash
   npm run create-admin -- --email you@company.com --password 'a-long-password'
   ```

5. Set up the frontend (`../frontend/README.md`) with the project URL and the **anon** key.

The service_role key bypasses all Supabase security, so it stays in this server's `.env`. The tables have row level security on with no policies, so the browser's anon key can't read them. Turn off public sign-ups (**Authentication → Sign In / Providers**) so only admins create accounts.

---

## Users and roles

- Users sign in in the browser (Supabase Auth). Every API call sends the access token; the API verifies it with Supabase (cached for a minute) and checks `ALLOWED_IPS`.
- The role is `app_metadata.role` (`admin` or `user`), which only the service role can set.
- Everyone can run extractions, change month status, and upload, download and delete files. Admins also manage accounts and country details, and add or remove download-only countries.

---

## How an extraction runs

1. A request names a country, a month or range, a flow (or both) and the HS codes (the saved complete or test list, or typed-in codes). Only one extraction per country runs at a time.
2. The country splits the work into **requests** (`splitQueries`), shaped by what its source returns in one call:
   - **South Africa**: one download per flow and month covering every chapter the codes are in.
   - **Indonesia**: one request per HS code, flow and year.
   - **Thailand** (the default): one request per HS code, month and flow.
3. Requests run in parallel within the country's concurrency and rate limits; temporary errors are retried with backoff. Each ends with rows, with 0 records, or failed.
4. The run's rows are collected in temporary local files, and each month that returned rows is written to `{CC}/{YYYY}/{CC}_{YYYY-MM}.csv`, replacing the previous file. Files are also written when a run is stopped part-way.

Starting an extraction marks its months **extracting**; a month becomes **completed** only when a user marks it on the country's Edit months page.

**Flags.** `EMPTY_STREAK_FLAG_AT` requests in a row with 0 records (default 300) flag the run (no data there, or the source may be restricting requests); a month with no records at all gets an `EMPTY_MONTH` flag.

**Logs and stats.** Logs are kept in memory while a run is live and dropped when it ends. Live stats are served from memory and saved to Supabase every few seconds; on boot, runs left `RUNNING` are marked `INTERRUPTED`.

---

## What the files contain

Files hold the source's own data, untouched; filtering happens downstream.

| Code | Columns |
|------|---------|
| `ZAF` | The SARS file exactly as delivered: its 21 columns with the cell text unchanged (written as CSV). |
| `THA` | Every field of the MOC response, with `request_hs_code` and `trade_flow` in front. |
| `IDN` | Every field of the BPS response, with `request_hs_code` and `trade_flow` in front. |
| download-only | The uploaded files as they are: `{CC}/{YYYY}/{CC}_{YYYY-MM}__{original name}` (`.xlsx`, `.xls`, `.csv`, `.zip`, up to `UPLOAD_MAX_MB`). |

Supabase limits the size of one stored file (50 MB on the free plan; raise it under **Storage → Settings** on paid plans).

---

## Countries

| Code | Source | Default lag | HS codes accepted | Needs |
|------|--------|-----|-------------------|-------|
| `IDN` | BPS DataExim API | 2 months | 8-digit tariff lines | `BPS_API_KEY` |
| `THA` | Thailand MOC trade report API | 2 months | 4–11 digits | — |
| `ZAF` | SARS Trade Statistics portal | 2 months | 8-digit tariff lines (4–6 digits return every line under them) | — |

**South Africa** has no API: `south-africa.ts` fills in the portal's download form over plain HTTP (ASP.NET postbacks) and reads the workbook. The portal accepts many chapters in one query, so each download is one month of every needed chapter (about 40 s for all chapters), two at a time. Several months of heavy chapters in one query can stall the portal, so months are not combined.

### Adding an extracted country

1. Create `src/countries/<name>.ts` exporting a `Country` (see `country.types.ts`; `thailand.ts` is the shortest example). `fetchRecords` returns the rows per month; add `splitQueries` when one call can answer several codes or months.
2. Add it to the list in `src/countries/index.ts`.
3. Put its HS codes in `storage/hs_codes/{CC}.csv` and a short `{CC}_TEST.csv` (the first column is read; headers are ignored).

`getJson` throws a `RetryableError` for 429/5xx/network failures, which the engine retries.

---

## Project structure

```
supabase/schema.sql      # Tables: runs, country_config, month_status
src/
├── server.ts            # Start-up: check tables, recover interrupted runs, create the bucket, listen
├── app.ts               # Express app: JSON, logging, /api routes, error handler
├── config/              # env.ts (validated environment), supabase.ts (service-role client, roles)
├── countries/           # One file per extracted source + index.ts (the list)
├── routes/ · controllers/ · middlewares/ · schemas/
├── services/
│   ├── extraction.service.ts   # Plan runs; run requests with limits, retries and flags
│   ├── db.service.ts           # Supabase tables: runs, country details, month status
│   ├── country.service.ts      # Built-in sources + admin edits + download-only countries
│   ├── export.service.ts       # A run's rows → one CSV per country-month
│   ├── storage.service.ts      # Supabase Storage: upload, list, signed links, zip, delete
│   └── hs-codes.service.ts     # storage/hs_codes/{CC}.csv (server-side only)
├── scripts/create-admin.ts
├── utils/               # http, errors, period, concurrency, hs-codes, client-ip, xlsx
└── types/index.ts
```

Key settings (see `.env.example` for all):

| Variable | Default | Meaning |
|----------|---------|---------|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | — | Supabase project (required) |
| `SUPABASE_BUCKET` | `trade-exports` | Private bucket for files |
| `UPLOAD_MAX_MB` | `200` | Largest upload for download-only countries |
| `ALLOWED_IPS` | empty (all) | Comma-separated IPs allowed to call the API |
| `EMPTY_STREAK_FLAG_AT` | `300` | Requests in a row with 0 records before a run is flagged |
| `MAX_CONCURRENT_EXTRACTIONS` / `MAX_CONCURRENT_PER_COUNTRY` | `4` / `2` | Requests at once, overall / per country (a country can set its own) |

---

## REST API

Every `/api` route checks `ALLOWED_IPS` and needs `Authorization: Bearer <Supabase access token>`. Errors are `{ "error": "...", ...details }`.

| Method & path | Who | Purpose |
|---------------|-----|---------|
| `GET /api/auth/me` | all | The signed-in user and role |
| `GET /api/health` | all | Environment |
| `GET /api/countries` | all | Countries with source, settings, completed and extracting months, last update |
| `POST /api/countries/:code/months` | all | `{ start, end? }` or `{ periods: [...] }`, optional `status` (`completed` default, or `extracting`) |
| `POST /api/countries/:code/months/remove` | all | `{ periods: [...] }` → clear their status |
| `POST /api/countries` | admin | Add a download-only country `{ code, name, sourceUrl, sourceName?, notes?, lagMonths? }` |
| `PATCH /api/countries/:code` | admin | Edit name, source links and text, notes, lag, publish day |
| `DELETE /api/countries/:code` | admin | Remove a download-only country |
| `POST /api/extractions` | all | `{ countryCode, startDate, endDate, tradeType, mode, hsCodes? }` → `202 { runId }`; marks the months extracting |
| `GET /api/runs?limit=` · `GET /api/runs/:id` | all | Runs with live stats (including `records`) and flags |
| `GET /api/runs/:id/logs` · `POST /api/runs/:id/stop` | all | Logs while the run is live; stop a run |
| `GET /api/files?country=` | all | Stored files with `countryCode`, `period`, `origin` (`extracted`/`uploaded`) |
| `GET /api/files/url?path=` | all | `{ url }`: signed download link, valid 5 minutes |
| `POST /api/files/zip` · `POST /api/files/delete` | all | `{ paths: [...] }` → one zip / delete |
| `PUT /api/files/upload?country=&period=&name=` | all | Raw file body → stored for that country and month |
| `GET/POST /api/admin/users` · `PATCH/DELETE /api/admin/users/:id` | admin | List, create (`{ email, password, role }`), change role/password, delete accounts |
