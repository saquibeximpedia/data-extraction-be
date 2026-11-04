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
| `GET /api/runs/:id/logs` | The newest 500 log lines while the run is live (after it ends, the web app reads the stored logs from `run_logs`) |
| `POST /api/runs/:id/stop` | Stop a run; requests in flight finish, and files are saved for the months that returned rows |
| `POST /api/merges` | `{ paths, name? }`: stored folders or files to merge → `202` + the merge (it runs in the background; one at a time) |
| `GET /api/merges` | Merges running or finished since the service started, newest first |
| `GET /api/merges/:id` | One merge's progress: `step`, `rowsTotal`, `rowsWritten`, `outputs`, `onServer`, `error` |
| `GET /api/server-files` | Files kept on the server because Storage couldn't take them: `{ files: [{ path, size, modifiedAt }] }` |
| `POST /api/server-files/links` | `{ paths }` → `{ links }`: a download link per file, valid for an hour |
| `DELETE /api/server-files` | `{ paths }`: removes them from the server |
| `GET /api/server-files/download` | **No sign-in needed**: the file a link names, streamed, once its signature and expiry check out (links are signed with a key made at start-up, so a restart ends them) |

---

## How an extraction runs

1. A request names a country, a month or range, a flow (or both) and the HS codes (the saved complete or test list, or typed-in codes). A source whose requests return every code (`allHsCodes`: Bahrain, Qatar) needs no list: a complete run takes every code, and typed-in codes only keep those. Only one extraction per country runs at a time.
2. The country splits the work into **requests** (`splitQueries`), shaped by what its source returns in one call:
   - **Bahrain, Qatar**: one request per flow and month, returning the whole month (every code and partner).
   - **South Africa**: one download per flow and month covering every chapter the codes are in.
   - **EU**: one request per flow, month and batch of up to 150 codes (every member state and partner).
   - **Indonesia**: one request per flow, year and batch of up to 20 HS codes (the most BPS accepts), at most 15 a minute: a BPS key allows 1,000 requests an hour and 10,000 a day.
   - **Japan**: one request per flow, year and batch of up to 20 HS codes (codes of one heading stay together).
   - **Turkey**: one request per flow, month and batch of up to 500 HS codes (one session on TÜİK's dashboard engine each).
   - **Thailand** (the default): one request per HS code, month and flow.
3. Requests run in parallel within the country's concurrency and rate limits, and temporary errors are retried with backoff. Each request ends with rows, with 0 records, or failed.
4. The run's rows are collected in temporary local files, per month and flow. Imports and exports get files of their own, in one folder per country, year, month and flow: `{CC}/{YYYY}/{MM}/{IMPORT|EXPORT}/{CC}_{YYYY-MM}_{FLOW}.zip`, replacing the previous files. Files for Storage are always zipped on the service first (about 15 times smaller), then uploaded; each zip holds one CSV with the header row. No CSV holds more than 900,000 rows (9 lakh; Excel shows at most 1,048,576), so a bigger month is split into `_part1.zip`, `_part2.zip`…; files are split by rows only. A zip Storage can't take, bigger than `MAX_UPLOAD_MB` or whose upload fails (e.g. storage full), is **kept on the server** instead, in `SERVER_FILES_DIR` under the same path, and the run logs why; the web app lists it in Files as *On server*, downloads it from the service, and it stays until someone deletes it there (share links can't include it). A later run that uploads the month removes the server copy. A run saved to the user's device keeps a month as a plain CSV up to `ZIP_OVER_MB` (default 5 MB). Runs on the test HS codes write to `_test/{CC}/…` instead, so they never replace real data. Files are also written when a run is stopped part-way, and after a crash the rows fetched so far are saved at the next start.

**Merging.** `POST /api/merges` (Merge on the web app's Files page) combines extracted files picked as folders (a country, a year, a month, a flow) or single files into one dataset under `merged/{name}/`: one zip, or parts of at most 9 lakh rows. Its columns are `source_country`, `trade_flow` and `period` (from each file's folder when its rows lack them), then every column of every file in the order they first appear, so countries with different columns keep all their data; a file without a column leaves it empty. Rows are counted before writing and again as they are written: a difference, or a row with more or fewer cells than its header, fails the merge and nothing is saved. Uploaded and merged files in a selection are left out.

Starting an extraction marks its months **extracting**. A month becomes **completed** only when a user marks it in the web app.

**Flags.** If `EMPTY_STREAK_FLAG_AT` requests in a row (default 300) return 0 records, the run is flagged: there is no data there, or the source may be restricting requests. A month with no records at all gets an `EMPTY_MONTH` flag.

**Logs and stats.** Live stats and logs are served from memory and saved to Supabase every few seconds: stats in `runs`, log lines in `run_logs` (one row per run, kept after it ends, and shown on the run's page in the web app). A run keeps up to 5,000 lines: past that the oldest info lines go first, and warnings, errors and the run's first lines stay. Each retry is logged as a warning with its reason and wait (`retry 1/3 in 10s: …`), and a batch names its first and last code (`500 HS codes 010121000000…030389900000`), so a failed one can be run again with those codes. After updating, run `supabase/schema.sql` again to add `run_logs`; the service won't start without it.

**Retries.** A request that fails with a temporary error is retried `RETRY_MAX_ATTEMPTS` times, waiting `RETRY_DELAY_MS` before the first retry and doubling after. A country can set its own first wait (`retryDelayMs`: Turkey 10 s); a value typed on the extract form overrides both.

---

## What the files contain

Files hold the source's own data, untouched; filtering happens downstream.

| Code | Columns |
|------|---------|
| `EU` | One row per product, EU reporter and partner, codes, names and values exactly as Eurostat sends them: `time_period`, `flow_code`, `flow`, `reporter_code`, `reporter_name`, `partner_code`, `partner_name`, `product_code`, `product_name`, `VALUE_IN_EUROS`, `QUANTITY_IN_100KG`, `SUPPLEMENTARY_QUANTITY`. Eurostat totals (EU27, euro area, world, extra/intra-EU) are left out. |
| `ZAF` | The SARS file exactly as delivered: its 21 columns with the cell text unchanged (written as CSV). |
| `THA` | Every field of the MOC response, with `request_hs_code` and `trade_flow` in front. |
| `IDN` | Every field of the BPS response, with `request_hs_code` and `trade_flow` in front. |
| `QAT` | Every field of the data.gov.qa row (English and Arabic description and country, quantity, weight in kg, value in riyals), with `trade_flow`, `request_hs_code` and `hs_code` (the code with its leading zero restored) in front. Field names differ by dataset (e.g. `hs8`/`lsn_year`/`lshhr_month` for 2019–2024 imports). |
| `BHR` | One row per 8-digit HS code and partner, the same columns every year: `request_hs_code`, `trade_flow`, `period`, `hs_code`, `description_en`, `description_ar`, `partner_code` (ISO), `partner_name_en`, `partner_name_ar`, `value_bd`, `value_usd`, `weight_kg`, `quantity`, `unit`. The source's field names differ by year (2024 imports use transliterated Arabic names) and are mapped onto these. |
| `JPN` | One row per 9-digit commodity code, partner country and month: `trade_flow`, `hs_code`, `country_code`, `country_name`, `year`, `month`, `unit1`, `quantity1`, `unit2`, `quantity2`, `value_1000_yen`. Rows without trade are left out. |
| `TUR` | One row per 12-digit GTİP code × partner × province × customs office × transport mode (values summed over everything else, e.g. payment method and currency): `trade_flow`, `period`, `hs_code` (leading zero kept), `description` (Turkish), `partner_name`, `province`, `customs_office`, `transport_mode`, `value_usd`, `value_try`, `quantity1_kg`, `quantity2`, `unit` (e.g. `KG/ADET`: quantity 1 in kg, quantity 2 in pieces), `hs8` and `hs8_name` (the code's 8-digit CN code). Rows without trade are left out. |

Supabase limits the size of one stored file (50 MB on the free plan; raise it under **Storage → Settings** on paid plans).

---

## Countries

| Code | Source | Default lag | HS codes accepted | Needs |
|------|--------|-----|-------------------|-------|
| `BHR` | Bahrain Open Data Portal (Opendatasoft API, iGA datasets) | 1 month | None needed (every 8-digit code); 2–8 digits keep only those | — |
| `EU` | Eurostat Comext API (DS-045409) | 2 months | 8-digit CN codes only | — |
| `IDN` | BPS DataExim API | 2 months | 8-digit tariff lines | `BPS_API_KEY` |
| `JPN` | e-Stat API (Ministry of Finance trade statistics) | 2 months | 9-digit statistical codes (4–6 digits return every code under them) | `ESTAT_APP_ID` |
| `PHL` | PSA OpenSTAT yearly files (download-only, not extracted) | 1 month | — (files cover every commodity) | — |
| `QAT` | Qatar Open Data Portal (Opendatasoft API, PSA datasets) | 8 months | None needed (every code); 4–12 digits keep only those. Imports 12-digit from 2025 (8 before), exports 4-digit only | — |
| `THA` | Thailand MOC trade report API | 2 months | 4–11 digits | — |
| `TUR` | TÜİK foreign trade dashboard (its Qlik Sense engine, general trade) | 2 months, around day 3 | 12-digit GTİP codes (11 digits get the leading zero back) | — |
| `ZAF` | SARS Trade Statistics portal | 2 months | 8-digit tariff lines (4–6 digits return every line under them) | — |

**South Africa** has no API. `south-africa.ts` fills in the portal's download form over plain HTTP (ASP.NET postbacks) and reads the workbook. The portal accepts many chapters in one query, so each download is one month of every needed chapter (about 40 s for all chapters), two at a time. Several months of heavy chapters in one query can stall the portal, so months are not combined.

**EU** reads Eurostat Comext dataset DS-045409 over its SDMX 3.0 API. Eurostat refuses extractions estimated above 5 million rows, so codes go in batches of 150 per flow and month (a batch still too big is halved), and large requests are queued as jobs that `eu.ts` polls until ready (about a minute per batch). Codes Eurostat doesn't know are dropped from the batch. Only 8-digit CN codes are accepted: Eurostat's HS2/4/6 totals also hold trade it can't attribute to a CN code (confidential lines), so they don't match the CN8 rows. An HS subheading the CN doesn't split is its code plus `00` (293341 → 29334100). The saved lists were moved to CN8 in Oct 2026; the codes taken out (HS codes with no 2026 trade, mostly retired before 2022) are in `storage/hs_codes/archive/`.

**EU bulk files** are not extracted. `eu.ts` describes Eurostat's monthly Comext files (`bulkDownload`: a link pattern `…/files/?downfile=comext/COMEXT_DATA/PRODUCTS/full_v2_{YYYYMM}.7z` and the folder listing), and the web app's extract page offers **Bulk file links**: a popup with each chosen month's direct link, opened in the browser. The service downloads nothing for them. Each file is a 7z of 25–45 MB holding about 5 million rows (both flows, every product, confidential `XX` rows, 18 columns).

**Philippines** is download-only: `philippines.ts` has no `fetchRecords`, so the service refuses runs for it and the extract page shows only **Bulk file links**. PSA publishes one file per flow and year (tables 1.1E exports / 2.1E imports, PSCC2022, from 2024) as Excel and CSV under `openstat.psa.gov.ph/Portals/0/files/IMTS/{Export|Import}/{excel|csv}/`. A finished year's file is named `… (JANUARY - DECEMBER {YYYY}).{ext}`; the current year's is `… (JANUARY - {MONTH} {YYYY}) PRELIMINARY.{ext}` and is renamed as months are added, so the link is built from the latest month the source should have out (`bulkDownload.per: 'year'`). The site is behind a Cloudflare check only browsers pass, so the service couldn't fetch these files even if it tried. Years before 2024 are in other tables with other names; use the listing page.

**Opendatasoft portals (Bahrain, Qatar).** Both publish a dataset per year (or per few years) and are read through the Explore API v2.1 (no key) with the helpers in `opendatasoft.ts`. Each request is one flow and month from `/catalog/datasets/{id}/exports/json?where=…`, which returns the whole month in one go (1–10 s); the paged `/records` endpoint stops at 100 rows a page and 10,000 in all, too few for a month. Typed-in codes filter the rows afterwards. The dataset for a year is the module's built-in one (Bahrain: else the iGA catalog entry titled for that year); a year with none fails its months with a message saying so, so it isn't mistaken for a month without trade.

**Bahrain** reads the Information & eGovernment Authority datasets on data.gov.bh: imports (`import-2026`, `import-1-2025`… from 2021) and **total exports** (`total-exports-2026`, `total-export-1-2025`…, national origin plus re-exports, from 2020; 2020–2022 share `03-total-export-2019-2022`, filtered by `year = date'YYYY'`). Non-oil trade only. Months are written three ways (`September`, `09 September`, `09-September`), matched by `month = "September" or startswith(month, "09")`. Monthly totals match iGA's press releases (April 2026: imports BD 287.7M, exports BD 316.6M). About 25,000 import and 4,000 export rows a month; September of year Y is published around 20–26 October.

**Qatar** reads the Planning and Statistics Authority datasets on data.gov.qa. Imports are three datasets by year range, each naming its fields differently: `qatar-imports-2014-2018` (`hs8` number), `qatar-imports-2019-2024-copy` (`hs8` text, `lsn_year`, `lshhr_month`) and `qatar-imports-2025-2026` (12-digit `harmonized_system_code`); exports are `qatar-export-statistics-2019-2024` (2014 onwards, `hs4` only). `qatar.ts` reads each dataset's field list once to find its year, month and code fields (names containing `year`, `month`, `hsN` or `harmonized`) and the code length (from `hsN`, else the longest code), so an added dataset needs only its ID. Numeric codes lose their leading zero; `hs_code` restores it. A typed-in code longer than the dataset's is cut to its length (an export code returns its heading), and each row goes to the most specific typed-in code that covers it. About 11,000–18,000 import and 1,000–2,000 export rows a month. `QAT.csv` (the 8,583 12-digit lines in `qatar-imports-2025-2026`) is no longer needed for complete runs; `QAT_TEST.csv` still drives test runs. In January 2026 imports the source copied value into `quantity`; NPC's yearly workbook (`npc.qa/en/statistics/Documents/ft/Imports_Exports_{YYYY}.xlsx`) has the right figures.

**Japan** reads the e-Stat tables "Commodity by Country Import / Export". e-Stat re-issues a year's table under a new ID every month, so `japan.ts` looks up the current table for each flow and year (cached for 30 minutes) instead of hard-coding IDs. Import and export use different 9-digit codes: a 9-digit code a flow lacks returns that flow's codes under its 6-digit subheading.

**Turkey** has no download API at this level. TÜİK's report page *Foreign Trade by Countries and HS Codes* (`bi.tuik.gov.tr/extensions/tuik-mashup/index.html?report_type=2`) is a Qlik Sense mashup, and `turkey.ts` talks to its engine the way the page does: `GET /resources/autogenerated/product-info.json` for an anonymous session cookie, `GET /qps/csrftoken` for a token, then JSON-RPC over `wss://bi.tuik.gov.tr/app/{app id}?reloadUri=…&qlik-csrf-token=…` (without `reloadUri` the server answers HTTP 200 instead of opening the socket). Each request opens a session, selects the year (`YIL`), month (`AY`) and its codes (`ISTPOZ`), and reads one table of code × name × CN code × partner × province × customs office × transport mode × unit (names read in the same table, so no other calls) with the flow's `DOLAR`, `TL`, `MIKTAR_1` and `MIKTAR_2` (`IHRITH_FLAG` 1 = exports, 2 = imports) in pages of 10,000 cells. The app is the English general-trade one (`6310efbf-…`, the system TÜİK's press releases use; `TUR_APP_ID` overrides it, e.g. `2d1b1108-9cf2-436d-8a54-420aec9d4350` for special trade).

The engine skips a selection that matches nothing without saying so, and a skipped selection widens the table: a month not published yet drops the year (every year's October came back for 2026-10), and codes without trade that month leave no code selected (the whole month, 245,000 rows). So each request reads the selections back and returns no rows unless the year, the month and at least one code are all selected. Codes are text without their leading zero (`10121000000`); a number or the 12-digit form selects nothing.

`TUR.csv` is every code with trade in 2026 (13,772 codes on 3 Nov 2026), so retired codes, such as the pre-2012 horse code `010110101000`, aren't requested. Rebuild it each January, when the tariff changes, with `npx tsx scripts/tur-hs-codes.ts [YYYY]`: a code new that year is only extracted once it is in the list. A full month is 28 batches per flow, about 10 minutes at the default 2 requests at a time; the engine stalls under more. A page that gets no answer within 60 s is read again on a new session, carrying on from that page (tables are sorted, so pages line up across sessions), up to 6 tries 10 s, 20 s, 30 s… apart, each logged; only then does the request fail and the engine retry the batch (from 10 s). The data starts in 2013, and a month appears about two months later (September 2026 on 3 November).

**Start month.** A country can set `startPeriod`, the earliest month it has data for (Japan: 2026-01). Admins can change it in the web app; the service refuses extractions that start earlier.

### Adding an extracted country

1. Create `src/countries/<name>.ts` exporting a `Country` (see `country.types.ts`; `thailand.ts` is the shortest example). `fetchRecords` returns the rows per month. Add `splitQueries` when one call can answer several codes or months.
2. Add it to the list in `src/countries/index.ts`.
3. Put its HS codes in `storage/hs_codes/{CC}.csv` and a short `{CC}_TEST.csv` (the first column is read; headers are ignored). A source whose requests return every code sets `allHsCodes: true` and needs no `{CC}.csv`.
4. Restart the service: it publishes the new country, and the web app shows it.

**Choosing a dataset.** A country with yearly datasets lists them in `datasets`. The extract page then shows a **Dataset** dropdown: *Automatic* (each month reads its year's dataset), any listed dataset, or *New dataset ID…* with a text box for one not listed yet (e.g. next year's, before the code knows it). The choice is sent as `dataset`, read for every month of the run (`context.dataset` in `fetchRecords`), and logged. A dataset holds one flow, so the service refuses one with both flows picked; picking a listed dataset switches the form to its flow. A listed dataset keeps its years (a several-year one is still filtered by year), and Bahrain drops rows whose `year` isn't the month's, so a dataset of another year returns no rows instead of filing them under the wrong month. Nothing is saved: the next run is automatic again.

To try a country without the engine, database or storage: `npx tsx scripts/month-check.ts <CC> <out-dir> <YYYY-MM>[,…] [hs codes…] [--flow IMPORT|EXPORT] [--dataset ID]` writes each month's CSV and a summary (`--dataset` reads that dataset for every month, as the extract page's Dataset dropdown would).

`getJson` throws a `RetryableError` for 429/5xx/network failures, which the engine retries.

A **download-only country** (links to the source's files, nothing extracted) leaves out `normalizeHsCode` and `fetchRecords` and sets `bulkDownload`: `urlTemplate` with `{YYYYMM}` for a file per month, or `per: 'year'` with `files` for a file per year (see `philippines.ts`). It needs no HS code files.

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
│   ├── export.service.ts       # A run's rows → zipped CSVs per country, month and flow
│   ├── merge.service.ts        # Merges stored files into merged/{name}/
│   ├── server-files.service.ts # Files kept on the server when Storage can't take them
│   ├── storage.service.ts      # Creates the bucket, uploads, lists and downloads files
│   └── hs-codes.service.ts     # storage/hs_codes/{CC}.csv (server-side only)
├── utils/               # http, errors, period, concurrency, hs-codes, client-ip, xlsx, csv, zip, unzip
└── types/index.ts
```

Key settings (see `.env.example` for all):

| Variable | Default | Meaning |
|----------|---------|---------|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | — | Supabase project (required) |
| `SUPABASE_BUCKET` | `trade-exports` | Private bucket for files (the web app must use the same one) |
| `ALLOWED_IPS` | empty (all) | Comma-separated IPs allowed to call the service |
| `SERVER_FILES_DIR` | `storage/server-files` | Files Storage couldn't take, kept until deleted from the web app (not cleared automatically: keep the disk in mind) |
| `EMPTY_STREAK_FLAG_AT` | `300` | Requests in a row with 0 records before a run is flagged |
| `MAX_CONCURRENT_EXTRACTIONS` / `MAX_CONCURRENT_PER_COUNTRY` | `4` / `2` | Requests at once, overall / per country (a country can set its own) |

The extraction settings (concurrency, retries, the empty-streak flag, `MAX_UPLOAD_MB` and `ZIP_OVER_MB`) start from `.env`, and admins can change them from the web app's Settings page (`GET` / `PUT /api/settings`). Changes take effect without a restart and are kept in `settings.json` next to `.env`. Each extraction can also override its concurrency, rate limit and retries (`options` on `POST /api/extractions`).
