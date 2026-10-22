# Global Trade Data Extraction (Node.js Backend)

One Node.js / Express / TypeScript service that pulls customs trade data from government sources on request, keeps the rows in a SQLite ledger, and stores one file per country-month in a private Supabase Storage bucket. Users sign in with Supabase Auth; the web UI lives in `../frontend`.

Each source country is one file in src/countries/. Admins can also add **download-only** countries in the UI: sources that publish files (e.g. Excel) which users download from the website and upload here.

---

## Setup

Requires Node.js 22.13+ (uses the built-in `node:sqlite`) and a Supabase project.

1. In Supabase, open **Project Settings → API** and copy the project URL and the **service_role** key.
2. Configure and start the API:

   ```bash
   cp .env.example .env     # set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (and BPS_API_KEY for Indonesia)
   npm install
   npm run dev              # or: npm run build && npm run start:prod
   ```

   On first start the private bucket `SUPABASE_BUCKET` (default `trade-exports`) is created.
3. Create the first admin (later accounts are created in the UI's Admin page):

   ```bash
   npm run create-admin -- --email you@company.com --password 'a-long-password'
   ```

   Run it again for an existing user to make them an admin (and optionally reset their password).
4. Set up the frontend (`../frontend/README.md`) with the project URL and the **anon** key.

The service_role key bypasses all Supabase security, so it stays in this server's `.env` only. Turn off public sign-ups in Supabase (**Authentication → Sign In / Providers → Allow new users to sign up**) so only admins create accounts.

---

## Users and roles

- Users sign in in the browser with email and password (Supabase Auth). Every API call sends the Supabase access token; the API verifies it with Supabase (cached for a minute) and also checks `ALLOWED_IPS`.
- The role is `app_metadata.role` (`admin` or `user`), which only the service role can set, so users cannot promote themselves.
- Everyone can run extractions, mark/unmark completed months, upload, download and delete files.
- Admins also manage accounts (`/api/admin/users`) and country details (name, source links, notes, lag), and add or remove download-only countries.

---

## Completed months

A month counts as completed only when a user marks it (one month, a range, or a selection) on the dashboard. Extraction results never mark months on their own. Unmarking a month doesn't touch its stored rows or files.

---

## How an extraction runs

1. The request names a country, one month or a range, a flow (or all) and the dataset (saved complete/test HS code list, or typed-in codes).
2. The work is split into **tasks**: one per (country, HS code, month, flow), run code by code (sorted) so sources that return a whole chapter or year per request answer many tasks from one download. Every task is extracted, also ones extracted before; a task already running in another run is skipped.
3. Each task ends as `COMPLETED` (rows), `NO_DATA` (0 records) or `FAILED` (error, retried with backoff first).
4. Every month the run touched is written to `{CC}/{YYYY}/{CC}_{YYYY-MM}.csv` in the bucket, replacing the previous file (no history is kept). Files are also written when a run is stopped part-way.

**Flags.** After `EMPTY_STREAK_FLAG_AT` consecutive 0-record tasks (default 300) the run gets an `EMPTY_STREAK` flag naming the range (no data there, or the source may be restricting requests) and carries on. A month where every task came back empty gets an `EMPTY_MONTH` flag.

**Logs** are kept in memory per run (last 500 lines) and shown when an extraction is opened in the UI; they don't survive a restart. On boot, runs left `RUNNING` are marked `INTERRUPTED`.

---

## What the files contain

Files hold the source's own data, untouched; filtering happens downstream.

| Code | Columns |
|------|---------|
| `ZAF` | The SARS file exactly as delivered: its 21 columns with the cell text unchanged (SARS serves `.xlsx`; it is written as CSV without changing any value). |
| `THA` | Every field of the MOC response, with `request_hs_code` and `trade_flow` in front (the response doesn't say which code and flow were asked for). |
| `IDN` | Every field of the BPS response, with `request_hs_code` and `trade_flow` in front. |
| download-only | The uploaded files as they are: `{CC}/{YYYY}/{CC}_{YYYY-MM}__{original name}` (`.xlsx`, `.xls`, `.csv`, `.zip`, up to `UPLOAD_MAX_MB`). |

Supabase limits the size of one stored file (50 MB on the free plan; raise it under **Storage → Settings** on paid plans). A full month of South Africa's complete HS list can exceed that.

---

## Countries

| Code | Source | Default lag | Flows | HS codes accepted | Needs |
|------|--------|-----|-------|-------------------|-------|
| `IDN` | BPS DataExim API | 2 months | IMPORT, EXPORT | 8-digit tariff lines | `BPS_API_KEY` |
| `THA` | Thailand MOC trade report API | 2 months | IMPORT, EXPORT | 4–11 digits | — |
| `ZAF` | SARS Trade Statistics portal | 2 months | IMPORT, EXPORT | 8-digit tariff lines (4–6 digits return every line under them) | — |

Admins can change what users see for these (name, source name and link, endpoint, method, output, notes, lag, publish day); the changes are stored in the ledger (`country_config`). The lag only decides which months count as published for the month presets.

**South Africa** has no API: `south-africa.ts` fills in the portal's download form over plain HTTP (ASP.NET postbacks, no browser) and reads the workbook it returns. Each (flow, year, chapter) is downloaded once per run with every month the run covers, and every HS code in that chapter is answered from it. At most two portal sessions run at once.

### Adding an extracted country

1. Create `src/countries/<name>.ts` exporting a `Country` object (see `src/countries/country.types.ts`, and `thailand.ts` for a short example): code, name, `source` (shown to users), `lagMonths`, `tradeTypes`, `hsCodeHint`, `normalizeHsCode` and `fetchRecords`, which returns the response rows as they are (`[]` when there are none).
2. Add it to the list in `src/countries/index.ts`.
3. Put its HS codes in `storage/hs_codes/{CC}.csv` and a short `{CC}_TEST.csv` (first column is read; headers are ignored).

`getJson` throws a `RetryableError` for 429/5xx/network failures, which the extraction service retries with backoff. For sources that return a whole year or chapter per call, cache the request in a `TtlCache`; `runPeriods` in the query lists every month of the run so one request can cover them all.

---

## Project structure

```
src/
├── server.ts            # Start-up: recover interrupted runs, create the bucket, listen
├── app.ts               # Express app: JSON, logging, /api routes, error handler
├── config/              # env.ts (validated environment), supabase.ts (service-role client, roles)
├── countries/           # One file per extracted source + index.ts (the list)
├── routes/              # URL → middleware → controller, one file per resource
├── middlewares/         # auth (Supabase token, role, IP allow-list), validate (zod), error
├── schemas/index.ts     # Request shapes (zod)
├── controllers/         # Thin: read the request, call a service, send the response
├── services/
│   ├── extraction.service.ts   # Plan runs; run tasks with limits, retries and flags
│   ├── country.service.ts      # Built-in sources + admin edits + download-only countries
│   ├── ledger.service.ts       # SQLite: runs, tasks, rows, country config, completed months
│   ├── export.service.ts       # One CSV per country-month (raw columns) → Storage
│   ├── storage.service.ts      # Supabase Storage: upload, list, signed links, zip, delete
│   └── hs-codes.service.ts     # storage/hs_codes/{CC}.csv (server-side only)
├── scripts/create-admin.ts     # First admin account
├── utils/               # http, errors, period, concurrency, cache, hs-codes, client-ip, xlsx
└── types/index.ts       # Shared types
```

Key settings (see `.env.example` for all):

| Variable | Default | Meaning |
|----------|---------|---------|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | — | Supabase project (required) |
| `SUPABASE_BUCKET` | `trade-exports` | Private bucket for files |
| `UPLOAD_MAX_MB` | `200` | Largest upload for download-only countries |
| `ALLOWED_IPS` | empty (all) | Comma-separated IPs allowed to call the API |
| `EMPTY_STREAK_FLAG_AT` | `300` | Consecutive 0-record tasks before a run is flagged |
| `MAX_CONCURRENT_EXTRACTIONS` / `MAX_CONCURRENT_PER_COUNTRY` | `4` / `2` | Tasks running at once |
| `DB_PATH` | `./storage/ledger.db` | SQLite ledger |

---

## REST API

Every `/api` route checks `ALLOWED_IPS` and needs `Authorization: Bearer <Supabase access token>`. Errors are `{ "error": "...", ...details }`.

| Method & path | Who | Purpose |
|---------------|-----|---------|
| `GET /api/auth/me` | all | The signed-in user and role |
| `GET /api/health` | all | Environment |
| `GET /api/countries` | all | Countries with source, settings, completed months, latest completed, last extraction |
| `POST /api/countries/:code/months` | all | `{ start, end? }` or `{ periods: [...] }` → mark completed |
| `POST /api/countries/:code/months/remove` | all | `{ periods: [...] }` → unmark |
| `POST /api/countries` | admin | Add a download-only country `{ code, name, sourceUrl, sourceName?, notes?, lagMonths? }` |
| `PATCH /api/countries/:code` | admin | Edit name, source links and text, notes, lag, publish day |
| `DELETE /api/countries/:code` | admin | Remove a download-only country |
| `POST /api/extractions` | all | `{ countryCode, startDate, endDate, tradeType, mode, hsCodes? }` → `202 { runId }` |
| `GET /api/runs?limit=` · `GET /api/runs/:id` | all | Runs with live stats and flags |
| `GET /api/runs/:id/logs` · `POST /api/runs/:id/stop` | all | Logs; stop a run |
| `GET /api/files?country=` | all | Stored files with `countryCode`, `period`, `origin` (`extracted`/`uploaded`) |
| `GET /api/files/url?path=` | all | `{ url }`: signed download link, valid 5 minutes |
| `POST /api/files/zip` · `POST /api/files/delete` | all | `{ paths: [...] }` → one zip / delete |
| `PUT /api/files/upload?country=&period=&name=` | all | Raw file body → stored for that country and month |
| `GET/POST /api/admin/users` · `PATCH/DELETE /api/admin/users/:id` | admin | List, create (`{ email, password, role }`), change role/password, delete accounts |
