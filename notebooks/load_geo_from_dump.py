"""
Skagit Geo from Postgres Dump — paste into a single Colab cell.

Steps:
  1. Installs postgres + postgis, restores backup.dump
  2. Queries parcel geometry → lat/lon/geojson
  3. Uploads to D1 (parcel_cards + parcel_geo_layers)

Upload backup.dump to Colab first:
  Files panel (left sidebar) → Upload → backup.dump
  It will land at /content/backup.dump
"""

import subprocess, requests, json, time
from datetime import date
from google.colab import userdata

# ── Config ────────────────────────────────────────────────────────────────────

CF_ACCOUNT_ID  = userdata.get('CF_ACCOUNT_ID')
CF_API_TOKEN   = userdata.get('CF_API_TOKEN')
D1_DATABASE_ID = 'bd1fd2cb-9d82-4068-a79a-de55c83cc981'
from google.colab import drive
drive.mount('/drive')
# Update this path to match where you put it in Drive:
DUMP_PATH = '/drive/MyDrive/backup.dump'

BATCH_SIZE = 500   # rows per D1 write batch
TODAY      = date.today().isoformat()
CF_BASE    = f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}'
AUTH       = {'Authorization': f'Bearer {CF_API_TOKEN}'}

# ── Step 1: Install postgres + postgis ────────────────────────────────────────

print('Installing postgres + postgis...')
subprocess.run('apt-get install -qq postgresql postgresql-client postgis > /dev/null 2>&1', shell=True, check=True)
subprocess.run('service postgresql start', shell=True, check=True)
subprocess.run('sudo -u postgres createuser --superuser root 2>/dev/null || true', shell=True)
print('postgres running')

# ── Step 2: Restore dump ──────────────────────────────────────────────────────

print('Restoring dump (this takes 1-3 min)...')
subprocess.run('sudo -u postgres createdb skagit 2>/dev/null || true', shell=True)
result = subprocess.run(
    f'pg_restore -d skagit -j 4 --no-owner --no-acl {DUMP_PATH} 2>&1 | tail -5',
    shell=True, capture_output=True, text=True
)
print(result.stdout or 'restore complete')

# ── Step 3: Query geometry ────────────────────────────────────────────────────

print('Querying parcel geometry...')
query = """
COPY (
  SELECT
    pg.parcel_id,
    ST_Y(ST_Centroid(ST_Transform(
      COALESCE(pg.geom_2926_valid, pg.geom_2926), 4326
    ))) AS latitude,
    ST_X(ST_Centroid(ST_Transform(
      COALESCE(pg.geom_2926_valid, pg.geom_2926), 4326
    ))) AS longitude,
    ST_AsGeoJSON(ST_Transform(
      COALESCE(pg.geom_2926_valid, pg.geom_2926), 4326
    )) AS geometry
  FROM public.openskagit_parcelgeometry pg
  WHERE COALESCE(pg.geom_2926_valid, pg.geom_2926) IS NOT NULL
) TO '/tmp/geo.csv' WITH CSV HEADER;
"""
subprocess.run(f'psql -d skagit -c "{query}"', shell=True, check=True)

# Read the CSV
import csv
rows = []
with open('/tmp/geo.csv') as f:
    for row in csv.DictReader(f):
        rows.append(row)

print(f'{len(rows):,} parcels with geometry')

# ── Step 4: D1 helpers ────────────────────────────────────────────────────────

def d1_batch(statements):
    r = requests.post(
        f'{CF_BASE}/d1/database/{D1_DATABASE_ID}/batch',
        headers={**AUTH, 'Content-Type': 'application/json'},
        json={'statements': statements}, timeout=60,
    )
    r.raise_for_status()
    data = r.json()
    if not data['success']:
        raise RuntimeError(data['errors'])

# ── Step 5: Upload to D1 ──────────────────────────────────────────────────────

PATCH_CARDS = 'UPDATE parcel_cards SET latitude=?, longitude=?, geometry=? WHERE parcel_id=?'
UPSERT_GEO  = 'INSERT OR REPLACE INTO parcel_geo_layers (parcel_id, enriched_date, layers) VALUES (?, ?, ?)'

print(f'Writing to D1 in batches of {BATCH_SIZE}...')
patched, written = 0, 0

for i in range(0, len(rows), BATCH_SIZE):
    chunk = rows[i:i + BATCH_SIZE]
    stmts = []
    for row in chunk:
        pid  = row['parcel_id']
        lat  = float(row['latitude'])
        lon  = float(row['longitude'])
        geom = row['geometry']

        stmts.append({'sql': PATCH_CARDS, 'params': [lat, lon, geom, pid]})
        patched += 1

        # Also write to parcel_geo_layers so it's queryable later
        layers_blob = json.dumps({'parcelgeometry': {'latitude': lat, 'longitude': lon}})
        stmts.append({'sql': UPSERT_GEO, 'params': [pid, TODAY, layers_blob]})
        written += 1

    d1_batch(stmts)

    if i % (BATCH_SIZE * 10) == 0:
        print(f'  {min(i + BATCH_SIZE, len(rows)):,} / {len(rows):,}')

print(f'\nDone — {patched:,} parcel_cards patched, {written:,} geo_layer rows written')

# ── Step 6: Verify ────────────────────────────────────────────────────────────

def d1_query(sql):
    r = requests.post(
        f'{CF_BASE}/d1/database/{D1_DATABASE_ID}/query',
        headers={**AUTH, 'Content-Type': 'application/json'},
        json={'sql': sql, 'params': []}, timeout=30,
    )
    r.raise_for_status()
    return r.json()['result'][0]['results']

total  = d1_query('SELECT COUNT(*) as n FROM parcel_cards')[0]['n']
has    = d1_query('SELECT COUNT(*) as n FROM parcel_cards WHERE latitude IS NOT NULL')[0]['n']
print(f'\nparcel_cards: {total:,} total | {has:,} with lat/lon | {total - has:,} still missing')
