# Skagit Parcel Pipeline - Agent Reference

Complete reference for any AI agent working in this codebase. Read this before touching any file.

## Architecture Overview

```text
Skagit County website (ZIP daily)
         |
         v
  GitHub Actions (weekly Sunday, 2am PST; manual runs also do full rebuild)
  scripts/ingest-node.js
         | downloads + unzips
         | parses 4 PSV files
         | cleans + normalizes parcel fields
         | writes a D1 SQL import for full rebuilds
         v
  Cloudflare D1 (skagit-parcels)
  parcel_cards
  parcel_sales
  parcel_improvements
  parcel_land_segments
  ingest_runs / ingest_manifests
         |
         v
  Cloudflare Worker (skagit-parcels)
         |
         +-- GET  /
         +-- GET  /health
         +-- GET  /parcel/:id
         +-- GET  /parcels?...    (structured filters)
         +-- POST /ask            (natural language -> SQL -> answer)
         +-- POST /admin/ingest   (disabled; use GitHub Actions)
```

The Worker cron only runs geo enrichment at `30 11 * * *` (3:30am PST/PDT depending on UTC offset handling). Parcel ingest belongs in GitHub Actions.

## Key Files

| File | Purpose |
|------|---------|
| `scripts/ingest-node.js` | Main ingest entry point. Builds normalized rows and, for full rebuilds, writes a SQL import file for Wrangler/D1. |
| `src/lib/parse.js` | PSV parser. Produces `{ headers, rows }` with `_id` on each row. |
| `src/lib/delta.js` | Hash-based change detection for incremental runs. |
| `src/lib/card.js` | Authoritative cleaning/mapping layer. Builds normalized parcel, sale, improvement, and land rows. |
| `schema.sql` | D1 schema for normalized parcel tables plus metadata tables. |
| `.github/workflows/main.yml` | Active ingest workflow. Scheduled runs use the full SQL import path. |
| `.github/workflows/ingest.yml` | Deprecated/removed. Do not re-enable duplicate ingest workflows. |
| `src/lib/api.js` | HTTP endpoints and `/ask` NL-to-SQL prompt. |
| `src/lib/ingest.js` | Disabled Worker-side ingest stub. |
| `src/lib/geo.js` | Geo enrichment cron. |

## Data Flow: Source -> D1

All source files are pipe-delimited (`|`) and mostly uppercase.

| File | Internal name | Parcel key field | D1 target |
|------|--------------|------------------|-----------|
| `AssessorData.txt` | `assessor` | `Parcel Number` | `parcel_cards` primary card fields |
| `Land.txt` | `land` | `ParcelNumber` | `parcel_land_segments` |
| `Improvements.txt` | `improvements` | `ParcelNumber` | `parcel_improvements` |
| `Sales.txt` | `sales` | `ParcelNumber` | `parcel_sales` |

Raw source blobs are not stored in D1. Keep D1 query-friendly and compact. If raw snapshots are needed later, write them to R2 and store a `raw_r2_key`.

## Normalization Rules

`src/lib/card.js` is the single source of truth for field cleaning.

Important rules:

- `land_use_code` is the clean numeric code, e.g. `111`.
- `land_use_description` is the definition, e.g. `HOUSEHOLD, SFR, INSIDE CITY`.
- Situs address is split into `situs_street_number`, `situs_street_name`, `situs_city`, `situs_state`, and `situs_zip`.
- Money, integer, decimal, and date values are parsed before insert.
- Bathrooms are derived from plumbing text where possible.
- Child arrays are normalized into `parcel_sales`, `parcel_improvements`, and `parcel_land_segments`.
- Investor flags are materialized: `absentee_owner`, `is_vacant`, `is_sfr`, `is_recreational_land`, `distressed_transfer_recent`.

Parcels are skipped when:

- assessed value is null, empty, zero, or negative
- `PropType` is `P` (personal property)
- the land use code is set to `false` in `config/land_use_filter.json`

## D1 Schema

Main table:

```sql
parcel_cards(
  parcel_id, account_number, updated_date, legal_description, property_type,
  situs_street_number, situs_street_name, situs_city, situs_state, situs_zip,
  owner_name, owner_city, owner_state, owner_zip, absentee_owner,
  land_use_code, land_use_description,
  assessed_value, taxable_value, market_value, building_value, land_value,
  impr_land_value, unimpr_land_value, improvement_value,
  acres, sq_ft, bedrooms, bathrooms, garage_sq_ft, year_built, effective_year_built,
  sale_date, sale_price, sale_type, sale_deed_type, days_since_last_sale,
  last_valid_sale_date, last_valid_sale_price,
  value_per_acre, improvement_ratio,
  is_vacant, is_sfr, is_recreational_land, distressed_transfer_recent,
  latitude, longitude, geometry, raw_r2_key
)
```

Child tables:

- `parcel_sales`
- `parcel_improvements`
- `parcel_land_segments`

Metadata tables:

- `ingest_manifests`
- `ingest_runs`
- `parcel_geo_layers`

## API Endpoints

### `GET /`

Returns the static Skagit Parcel Agent home page from `public/index.html`.

### `GET /health`

Returns `{ ok, parcel_count }`.

### `GET /parcel/:id`

Returns one normalized parcel card plus `sales`, `improvements`, and `land_segments`.

### `GET /parcels`

Structured filter query. Supported params include:

`land_use_code`, `situs_city`, `city`, `street`, `owner_state`, `absentee_owner`, `min_value`, `max_value`, `year_built_after`, `year_built_before`, `min_sqft`, `min_acres`, `bedrooms`, `is_vacant`, `is_sfr`, `bbox`, `limit`, `offset`.

### `POST /ask`

Natural language to SQL. Body: `{ "question": "..." }`.

### `POST /admin/ingest`

Disabled. It returns `410`. Use the GitHub Actions ingest workflow.

## NL-to-SQL Critical Rules

These rules are encoded in `src/lib/api.js`; preserve them when editing the prompt.

- Use SQLite syntax only.
- Only `SELECT` statements are allowed.
- Always include `LIMIT` with max 200.
- Use normalized columns instead of `raw_json`.
- Filter land use with equality: `land_use_code = '111'`.
- Search addresses with `situs_street_name`, `situs_city`, and related normalized columns.
- Text values are uppercase in the database.
- For child data, join `parcel_sales`, `parcel_improvements`, or `parcel_land_segments`.

## Investor Query Patterns

```sql
-- Absentee-owned recreational lots under $50k
SELECT parcel_id, assessed_value, acres, days_since_last_sale
FROM parcel_cards
WHERE land_use_code = '910'
  AND absentee_owner = 1
  AND assessed_value < 50000
LIMIT 50;

-- Vacant land with out-of-state owner
SELECT parcel_id, assessed_value, acres, land_use_code, land_use_description
FROM parcel_cards
WHERE absentee_owner = 1
  AND is_vacant = 1
ORDER BY days_since_last_sale DESC
LIMIT 50;

-- Long-held SFR properties (20+ years since sale)
SELECT parcel_id, assessed_value, year_built, days_since_last_sale
FROM parcel_cards
WHERE land_use_code = '111'
  AND days_since_last_sale > 7300
ORDER BY days_since_last_sale DESC
LIMIT 50;

-- Properties on a specific street
SELECT parcel_id, assessed_value, situs_street_number, situs_street_name, situs_city
FROM parcel_cards
WHERE situs_street_name LIKE '%CULTUS MOUNTAIN DR%'
LIMIT 50;
```

## Deployment

```bash
# Deploy Worker
wrangler deploy

# Set Anthropic key
wrangler secret put ANTHROPIC_API_KEY

# Manual full rebuild through GitHub Actions:
# Run "Weekly Parcel Ingest" manually; it always uses full SQL import.

# Local full SQL generation
FORCE_FULL_REINGEST=1 OUTPUT_SQL_FILE=parcel-import.sql node scripts/ingest-node.js
npx wrangler d1 execute skagit-parcels --remote --file parcel-import.sql --yes

# One-time geo backfill
CF_ACCOUNT_ID=... CF_API_TOKEN=... node scripts/backfill-geo.js

# Incremental geo backfill
CF_ACCOUNT_ID=... CF_API_TOKEN=... ONLY_MISSING=1 node scripts/backfill-geo.js
```

## GitHub Secrets Required

| Secret | Used by |
|--------|---------|
| `CF_ACCOUNT_ID` | `scripts/ingest-node.js` and Wrangler import |
| `CF_API_TOKEN` | D1 write/import access |

`ANTHROPIC_API_KEY` is a Wrangler Worker secret, not a GitHub secret.
