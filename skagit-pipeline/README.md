# Skagit County Parcel Pipeline

Nightly ingest of Skagit County Assessor data → Cloudflare R2 + D1 → REST API.

## Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/): `npm i -g wrangler`
- Cloudflare account (free tier + $5/mo Workers Paid)

## Deploy (3 steps)

```bash
# 1. Login to Cloudflare
wrangler login

# 2. Clone and setup
git clone <this-repo>
cd skagit-pipeline
npm run setup        # installs deps, creates R2, runs schema, deploys worker
```

Done. Worker is live. Crons run automatically at 2am PST (ingest) and 3:30am PST (geo patch).

## One-Time Geo Backfill (~4.5 hours)

Run `colab_geo_backfill.py` in [Google Colab](https://colab.research.google.com):

1. Upload the `.py` file to Colab
2. Run all cells — it checkpoints every 500 parcels so it's resumable
3. Download `seed_geo.sql` when done
4. `wrangler d1 execute skagit-parcels --file=seed_geo.sql`

After the backfill, the nightly geo worker handles new/changed parcels automatically.

## API

```
GET /health
GET /parcel/:id
GET /parcels?zoning=R1&min_value=300000&max_value=800000&limit=500
GET /parcels?bbox=-122.5,48.3,-122.0,48.6
GET /parcels?year_built_after=2000&min_sqft=2000&bedrooms=4
```

Query params for `/parcels`:

| param | example |
|---|---|
| `zoning` | `R1` |
| `land_use_code` | `111` |
| `min_value` / `max_value` | `300000` |
| `year_built_after` / `year_built_before` | `1990` |
| `min_sqft` | `1500` |
| `min_acres` | `0.5` |
| `bedrooms` | `3` |
| `bbox` | `minLon,minLat,maxLon,maxLat` |
| `limit` | `500` (max 2000) |
| `offset` | `0` |

## DuckDB (local bulk analysis)

R2 exports a full NDJSON snapshot nightly. Query it directly with DuckDB:

```sql
INSTALL httpfs; LOAD httpfs;
SET s3_endpoint='<account-id>.r2.cloudflarestorage.com';
SET s3_access_key_id='<key>';
SET s3_secret_access_key='<secret>';

SELECT zoning, COUNT(*), AVG(assessed_value)
FROM read_ndjson_auto('s3://raw-parcels/exports/latest/parcel_cards.ndjson')
GROUP BY zoning ORDER BY 2 DESC;
```

## Cost

~$5/month (Workers Paid plan). Everything else (R2, D1) stays in free tier.

## File Structure

```
src/
  worker.js          # entry point: fetch (API) + scheduled (cron)
  lib/
    ingest.js        # download → unzip → parse → delta → D1
    geo.js           # nightly geo patch for new parcels
    api.js           # HTTP handlers
    parse.js         # PSV parsing + key normalization
    delta.js         # manifest-based delta detection
    card.js          # buildCard + cleaning hooks
schema.sql
setup.sh
colab_geo_backfill.py
```

## Adding Data Cleaning

Edit `src/lib/card.js` → `buildCard()`. That's the single place where
all four files are merged into one record. Add derived fields, normalize
values, or filter bad data there.
