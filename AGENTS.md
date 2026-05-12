# Skagit Parcel Pipeline — Agent Reference

Complete reference for any AI agent working in this codebase. Read this before touching any file.

---

## Architecture Overview

```
Skagit County website (ZIP daily)
         │
         ▼
  GitHub Actions (weekly Sunday, 2am PST; manual repair can force full rewrite)
  scripts/ingest-node.js
         │  downloads + unzips
         │  parses 4 PSV files
         │  computes delta vs D1 ingest_manifests
         │  writes ONLY changed parcels
         ▼
  Cloudflare D1 (skagit-parcels)
  parcel_cards table
  ingest_manifests / ingest_runs
         │
         ▼
  Cloudflare Worker (skagit-parcels)
  skagit-parcels.ian-larsen-1976.workers.dev
         │
         ├── GET  /health
         ├── GET  /parcel/:id
         ├── GET  /parcels?...             (structured filters)
         ├── POST /ask                     (natural language → SQL → answer)
         └── POST /admin/ingest            (emergency manual trigger only)
                    │
                    ▼
             Worker cron (3:30am PST)
             src/lib/geo.js
             backfills lat/lon from Skagit GIS
```

---

## Key Files

### Ingest pipeline (GitHub Actions)

| File | Purpose |
|------|---------|
| `scripts/ingest-node.js` | Main ingest entry point. Imports from src/lib/. DO NOT duplicate logic here. |
| `src/lib/parse.js` | PSV parser. Produces `{ headers, rows }` with `_id` field on each row. |
| `src/lib/delta.js` | Hash-based change detection. Returns `{ added, modified, deleted }` per file. |
| `src/lib/card.js` | Builds a `parcel_cards` row from the 4 source records. All field mappings live here. |
| `.github/workflows/main.yml` | Active ingest workflow. Scheduled weekly Sunday at 2am PST. Manual trigger supports `force_full=true` for schema/column repair. |
| `.github/workflows/ingest.yml` | Deprecated/removed. Do not re-enable duplicate ingest workflows. |

### Worker (Cloudflare)

| File | Purpose |
|------|---------|
| `src/worker.js` | Entry point. Routes fetch → handleRequest, cron → runGeoEnrich only. |
| `src/lib/api.js` | All HTTP endpoints including `/ask` NL-to-SQL. |
| `src/lib/geo.js` | Geo enrichment cron — backfills lat/lon from Skagit GIS ArcGIS API. Runs at 3:30am PST. |
| `src/lib/ingest.js` | Worker-side ingest (emergency fallback via `/admin/ingest`). Requires `ADMIN_INGEST_TOKEN`; keep filters in sync with `scripts/ingest-node.js`. |

### Frontend (Cloudflare static assets)

| File | Purpose |
|------|---------|
| `public/index.html` | Static home page and chat UI for the parcel agent. Calls same-origin `/health` and `POST /ask`, renders answer/SQL/results, and stores previous questions/answers in browser `localStorage`. |
| `public/ask.html` | Compatibility redirect to `/` for the old prototype URL. |
| `wrangler.toml` | Uses `[assets] directory = "./public"` with `html_handling = "none"` and Worker-first routing for API endpoints (`/health`, `/parcel/*`, `/parcels`, `/ask`, `/admin/*`). |

### Config & scripts

| File | Purpose |
|------|---------|
| `wrangler.toml` | Worker config. One cron: `30 11 * * *` (geo only). Ingest cron removed. |
| `schema.sql` | D1 table definition. Run once to create table + indexes. |
| `config/land_use_filter.json` | Land use code allow/deny list. Set any code to `false` to exclude from ingest. Regenerate with `generate-land-use-filter.js`. Keys prefixed with `_` are metadata comments. |
| `scripts/generate-land-use-filter.js` | Downloads assessor ZIP, extracts unique land use codes, writes `config/land_use_filter.json`. Run manually: `node scripts/generate-land-use-filter.js`. Preserves existing `false` entries. |
| `scripts/backfill-geo.js` | One-time (and periodic) ArcGIS multi-layer enrichment. Discovers all MapServer layers, queries in bulk, stores in `parcel_geo_layers` D1 table. Also patches `parcel_cards` lat/lon/geometry. |

---

## Data Flow: Source → D1

### Source files (inside SkagitAssessmentData.zip)

All 4 files are pipe-delimited (`|`), all text values in **ALL CAPS**.

| File | Internal name | Parcel key field | Key columns used |
|------|--------------|-----------------|-----------------|
| `AssessorData.txt` | `assessor` | `Parcel Number` | All card columns — this is the primary source |
| `Land.txt` | `land` | `ParcelNumber` | `size_acres` only (fallback for acres if assessor missing) |
| `Improvements.txt` | `improvements` | `ParcelNumber` | Stored as JSON array in `improvements` column |
| `Sales.txt` | `sales` | `ParcelNumber` | Stored as JSON array in `sales_history` column |

### Field mappings (`src/lib/card.js`)

The authoritative list. All fields come from `AssessorData.txt` headers UNLESS noted.

| D1 column | Source field | Notes |
|-----------|-------------|-------|
| `assessed_value` | `a['Assessed Value']` | Falls back to `a['Total Market Value']` |
| `land_value` | `a['Impr Land Value'] + a['Unimpr Land Value']` | Sum of both |
| `improvement_value` | `a['Building Value']` | Building only, not land |
| `year_built` | `a['Year Built']` | |
| `sq_ft` | `a['Living Area']` | Living area only, not lot |
| `bedrooms` | `a['Number of Bedrooms']` | |
| `bathrooms` | `null` | Not in source PSV |
| `land_use_code` | `a['Land Use']` | Full string e.g. `"(111) HOUSEHOLD, SFR, INSIDE CITY"` |
| `zoning` | `null` | Not in source PSV |
| `acres` | `a['Acres']` | Falls back to `l['size_acres']` from Land.txt |
| `absentee_owner` | derived | `1` if `a['Owner State'] !== 'WA'` |
| `days_since_last_sale` | derived | Days since `a['Sale Date']` |
| `raw_json` | all four files | `{ assessor: {}, land: {}, improvements: [], sales: [] }` |

### Ingest filter

A parcel card is **skipped** (not written to D1) if any of:
- `a['Assessed Value']` is null, empty, zero, or negative
- `a['PropType'] === 'P'` (personal property — equipment, business assets, not real estate)
- `a['Land Use']` code is in `config/land_use_filter.json` set to `false` (opt-in exclusion)

---

## D1 Schema

```sql
CREATE TABLE parcel_cards (
  parcel_id             TEXT PRIMARY KEY,
  updated_date          TEXT,
  assessed_value        INTEGER,
  land_value            INTEGER,
  improvement_value     INTEGER,
  year_built            INTEGER,
  sq_ft                 INTEGER,         -- living area sq ft
  bedrooms              INTEGER,
  bathrooms             REAL,            -- always NULL (not in source)
  land_use_code         TEXT,            -- e.g. "(111) HOUSEHOLD, SFR, INSIDE CITY"
  zoning                TEXT,            -- always NULL (not in source)
  acres                 REAL,
  improvements          TEXT,            -- JSON array of improvement segments
  sales_history         TEXT,            -- JSON array of sale records
  latitude              REAL,            -- filled by geo worker
  longitude             REAL,
  geometry              TEXT,            -- GeoJSON polygon
  absentee_owner        INTEGER,         -- 1 = out-of-state owner
  days_since_last_sale  INTEGER,
  raw_json              TEXT             -- full denormalized snapshot
);
```

---

## API Endpoints

### `GET /`
Returns the static Skagit Parcel Agent home page from `public/index.html`.

### `GET /health`
Returns `{ ok, parcel_count }`.

### `GET /parcel/:id`
Returns a single parcel card. Parcel IDs have spaces/dashes stripped (e.g. `P90623`).

### `GET /parcels`
Structured filter query. Params: `zoning`, `land_use_code`, `min_value`, `max_value`,
`year_built_after`, `year_built_before`, `min_sqft`, `min_acres`, `bedrooms`,
`bbox` (minLon,minLat,maxLon,maxLat), `limit` (max 2000), `offset`.

### `POST /ask`
Natural language to SQL. Body: `{ "question": "..." }`
Returns: `{ question, sql, reasoning, row_count, answer, results }`

### `POST /admin/ingest`  _(emergency only)_
Triggers the Worker-side ingest. Normally ingest runs in GitHub Actions.

---

## NL-to-SQL: Critical Rules for `/ask`

These rules are encoded in the system prompt in `src/lib/api.js`. Any agent modifying
the system prompt must preserve these invariants:

### Data format
- **ALL text is UPPERCASE** in the database. Always use uppercase string literals.
- **City names have no hyphens**: `SEDRO WOOLLEY` not `SEDRO-WOOLLEY`.
- **Street names use USPS abbreviations**: `DR`, `ST`, `AVE`, `RD`, `LN`, `CT`, `BLVD`.
  `CULTUS MOUNTAIN DR` not `CULTUS MOUNTAIN DRIVE`.

### land_use_code
- Stored as full strings with code prefix: `(111) HOUSEHOLD, SFR, INSIDE CITY`
- **Always filter with LIKE**: `land_use_code LIKE '%(111)%'`
- **Never use equality**: `land_use_code = '111'` returns zero rows.
- Common codes: `(111)` = SFR, `(910)` = recreational/vacant lots

### Address search
- Use `raw_json LIKE '%STREET NAME%'` — the address is in `raw_json.assessor["Situs Street Name"]`
- Raw_json structure: `{ "assessor": {...}, "land": {...}, "improvements": [...], "sales": [...] }`

### Vacant land
- Always check both: `(improvement_value = 0 OR improvement_value IS NULL)`

### Days to years
- 1 year ≈ 365 days. "20 years" = `days_since_last_sale > 7300`.

### SQLite rules
- No PostgreSQL syntax. Use `json_each()` / `json_extract()` for JSON arrays.
- Always include `LIMIT` (max 200). Only `SELECT` allowed.

---

## Investor Query Patterns

```sql
-- Absentee-owned recreational lots under $50k
SELECT parcel_id, assessed_value, acres, days_since_last_sale
FROM parcel_cards
WHERE land_use_code LIKE '%(910)%'
  AND absentee_owner = 1
  AND assessed_value < 50000
LIMIT 50;

-- Vacant land (no improvements) with out-of-state owner
SELECT parcel_id, assessed_value, acres, land_use_code
FROM parcel_cards
WHERE absentee_owner = 1
  AND (improvement_value = 0 OR improvement_value IS NULL)
ORDER BY days_since_last_sale DESC
LIMIT 50;

-- Long-held SFR properties (20+ years since sale)
SELECT parcel_id, assessed_value, year_built, days_since_last_sale
FROM parcel_cards
WHERE land_use_code LIKE '%(111)%'
  AND days_since_last_sale > 7300
ORDER BY days_since_last_sale DESC
LIMIT 50;

-- Properties on a specific street
SELECT parcel_id, assessed_value, land_use_code, acres
FROM parcel_cards
WHERE raw_json LIKE '%CULTUS MOUNTAIN DR%'
LIMIT 50;
```

---

## Ingest Metadata

GitHub Actions stores normal ingest metadata in D1, not R2. This avoids unofficial R2 object REST writes from CI.

| Table | Written by | Contents |
|------|-----------|----------|
| `ingest_manifests` | `scripts/ingest-node.js` | Hash manifest JSON for delta detection. One row per source (`assessor`, `land`, `improvements`, `sales`). |
| `ingest_runs` | `scripts/ingest-node.js` | Run summary JSON: parcels written, deleted, total, per-file delta counts. |

---

## Infrastructure IDs

| Resource | Value |
|----------|-------|
| Worker URL | `https://skagit-parcels.ian-larsen-1976.workers.dev` |
| Cloudflare account ID | `55426a025182255079a703166b6cce8a` |
| D1 database | `skagit-parcels` / `bd1fd2cb-9d82-4068-a79a-de55c83cc981` |
| R2 bucket | `raw-parcels` (legacy Worker-side/emergency ingest binding; normal GitHub ingest metadata is in D1) |
| Anthropic model | `claude-sonnet-4-20250514` |
| Source ZIP | `https://www.skagitcounty.net/Assessor/Documents/DataDownloads/SkagitAssessmentData.zip` |
| Geo API | `https://gis.skagitcountywa.gov/arcgis/rest/services/Assessor/PropertyMap/MapServer/5/query` |

---

## Deployment

```bash
# Deploy Worker
wrangler deploy

# Set Anthropic key (first time or rotation)
wrangler secret put ANTHROPIC_API_KEY

# Set emergency manual ingest token (first time or rotation)
wrangler secret put ADMIN_INGEST_TOKEN

# Run emergency Worker-side ingest manually (GitHub UI preferred)
curl -X POST https://skagit-parcels.ian-larsen-1976.workers.dev/admin/ingest \
  -H "X-Admin-Token: $ADMIN_INGEST_TOKEN"

# Tail Worker logs
wrangler tail

# Clean up zero-value parcels after schema fix
wrangler d1 execute skagit-parcels --command \
  "DELETE FROM parcel_cards WHERE assessed_value IS NULL OR assessed_value <= 0"

# One-time geo backfill (all parcels, all layers)
CF_ACCOUNT_ID=... CF_API_TOKEN=... node scripts/backfill-geo.js

# Incremental geo backfill (only parcels not yet in parcel_geo_layers)
CF_ACCOUNT_ID=... CF_API_TOKEN=... ONLY_MISSING=1 node scripts/backfill-geo.js

# Regenerate land use filter (run after any assessor data format change)
node scripts/generate-land-use-filter.js
# Then review config/land_use_filter.json and set unwanted codes to false
```

## GitHub Secrets Required

| Secret | Used by |
|--------|---------|
| `CF_ACCOUNT_ID` | `scripts/ingest-node.js` |
| `CF_API_TOKEN` | `scripts/ingest-node.js` (D1 write) |

The `ANTHROPIC_API_KEY` and `ADMIN_INGEST_TOKEN` are **Wrangler Worker secrets**, not GitHub secrets.
