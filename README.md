# Skagit County Parcel Pipeline

Weekly ingest of Skagit County Assessor data -> normalized Cloudflare D1 tables -> REST API.

## Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/): `npm i -g wrangler`
- Cloudflare account

## Deploy

```bash
wrangler login
git clone <this-repo>
cd skagit-pipeline
npm run setup
```

The Worker is live after deploy. GitHub Actions runs parcel ingest weekly Sunday at 2am PST using a full D1 SQL import. The Worker cron runs geo patching at 3:30am PST.

For a production repair after schema or column changes, run the `Weekly Parcel Ingest` workflow manually. The workflow always uses the full SQL import path.

## Secrets

GitHub Actions:

| Secret | Used by |
|---|---|
| `CF_ACCOUNT_ID` | `scripts/ingest-node.js` |
| `CF_API_TOKEN` | D1 writes from `scripts/ingest-node.js` |

Worker secrets:

```bash
wrangler secret put ANTHROPIC_API_KEY
```

## One-Time Geo Backfill

Run the bulk geo backfill when geometry coverage needs repair or refresh:

```bash
CF_ACCOUNT_ID=... CF_API_TOKEN=... node scripts/backfill-geo.js
CF_ACCOUNT_ID=... CF_API_TOKEN=... ONLY_MISSING=1 node scripts/backfill-geo.js
```

After the backfill, the Worker geo cron handles new or missing parcels incrementally.

## API

```text
GET /health
GET /parcel/:id
GET /parcels?zoning=R1&min_value=300000&max_value=800000&limit=500
GET /parcels?bbox=-122.5,48.3,-122.0,48.6
GET /parcels?year_built_after=2000&min_sqft=2000&bedrooms=4
POST /ask
POST /admin/ingest  # disabled; use GitHub Actions
```

`/admin/ingest` returns `410`. Ingest is intentionally kept out of the Worker because the normalized rebuild is a large D1 import job.

Query params for `/parcels`:

| param | example |
|---|---|
| `zoning` | `R1` |
| `land_use_code` | `111` or `(111)` |
| `situs_city` / `city` | `SEDRO WOOLLEY` |
| `street` | `CULTUS MOUNTAIN DR` |
| `owner_state` | `WA` |
| `absentee_owner` | `1` |
| `is_vacant` / `is_sfr` | `1` |
| `min_value` / `max_value` | `300000` |
| `year_built_after` / `year_built_before` | `1990` |
| `min_sqft` | `1500` |
| `min_acres` | `0.5` |
| `bedrooms` | `3` |
| `bbox` | `minLon,minLat,maxLon,maxLat` |
| `limit` | `500` (max 2000) |
| `offset` | `0` |

## Ingest Metadata

The active GitHub ingest stores normalized parcel data in:

- `parcel_cards`
- `parcel_sales`
- `parcel_improvements`
- `parcel_land_segments`

It stores run metadata in:

- `ingest_manifests`
- `ingest_runs`

Raw source blobs are not stored in D1. If raw snapshots are needed later, store them in R2 and keep only `raw_r2_key` in D1.

## File Structure

```text
src/
  worker.js          # entry point: fetch (API) + scheduled (cron)
  lib/
    ingest.js        # disabled Worker-side ingest stub
    geo.js           # geo patch for new parcels
    api.js           # HTTP handlers
    parse.js         # PSV parsing + key normalization
    delta.js         # manifest-based delta detection
    card.js          # buildCard + field mapping
scripts/
  ingest-node.js     # primary GitHub Actions ingest
  backfill-geo.js    # bulk ArcGIS enrichment
schema.sql
setup.sh
```

## Adding Data Cleaning

Edit `src/lib/card.js`. That is the single place where the four source files are cleaned and converted into `parcel_cards`, `parcel_sales`, `parcel_improvements`, and `parcel_land_segments` rows.
