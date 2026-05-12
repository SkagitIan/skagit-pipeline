# Skagit County Parcel Pipeline

Weekly ingest of Skagit County Assessor data -> Cloudflare D1 -> REST API.

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

The Worker is live after deploy. GitHub Actions runs parcel ingest weekly Sunday at 2am PST. The Worker cron runs geo patching at 3:30am PST.

For a production repair after schema or column changes, run the `Weekly Parcel Ingest` workflow manually with `force_full=true`. That rewrites every assessor parcel instead of only changed parcels.

## Secrets

GitHub Actions:

| Secret | Used by |
|---|---|
| `CF_ACCOUNT_ID` | `scripts/ingest-node.js` |
| `CF_API_TOKEN` | D1 writes from `scripts/ingest-node.js` |

Worker secrets:

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ADMIN_INGEST_TOKEN
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
POST /admin/ingest
```

`/admin/ingest` is an emergency fallback and requires `X-Admin-Token`.

Query params for `/parcels`:

| param | example |
|---|---|
| `zoning` | `R1` |
| `land_use_code` | `111` or `(111)` |
| `min_value` / `max_value` | `300000` |
| `year_built_after` / `year_built_before` | `1990` |
| `min_sqft` | `1500` |
| `min_acres` | `0.5` |
| `bedrooms` | `3` |
| `bbox` | `minLon,minLat,maxLon,maxLat` |
| `limit` | `500` (max 2000) |
| `offset` | `0` |

## Ingest Metadata

The active GitHub ingest stores delta manifests and run summaries in D1 metadata tables:

- `ingest_manifests`
- `ingest_runs`

Legacy R2 exports may exist, but they are not part of the active GitHub ingest path.

## File Structure

```text
src/
  worker.js          # entry point: fetch (API) + scheduled (cron)
  lib/
    ingest.js        # emergency Worker-side ingest
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

Edit `src/lib/card.js` in `buildCard()`. That is the single place where the four source files are merged into one parcel card.
