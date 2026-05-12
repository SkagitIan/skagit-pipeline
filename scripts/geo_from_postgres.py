"""
geo_from_postgres.py — run locally after restoring backup.dump

  pip install psycopg2-binary requests

  python scripts/geo_from_postgres.py

Reads geometry from local PostgreSQL, pushes lat/lon/geometry to D1.
"""

import psycopg2, psycopg2.extras, requests, json, os
from datetime import date

# ── Config ────────────────────────────────────────────────────────────────────

PG_DSN = os.getenv('PG_DSN', 'dbname=skagit host=localhost user=postgres password=postgres')

CF_ACCOUNT_ID  = os.getenv('CF_ACCOUNT_ID', '55426a025182255079a703166b6cce8a')
CF_API_TOKEN   = os.getenv('CF_API_TOKEN', '')
D1_DATABASE_ID = os.getenv('D1_DATABASE_ID', 'bd1fd2cb-9d82-4068-a79a-de55c83cc981')

BATCH_SIZE = 500
TODAY      = date.today().isoformat()
CF_BASE    = f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}'
AUTH       = {'Authorization': f'Bearer {CF_API_TOKEN}'}

if not CF_API_TOKEN:
    import getpass
    CF_API_TOKEN = getpass.getpass('CF API token: ')
    AUTH = {'Authorization': f'Bearer {CF_API_TOKEN}'}

# ── D1 helpers ────────────────────────────────────────────────────────────────

def d1_query(sql, params=None):
    r = requests.post(
        f'{CF_BASE}/d1/database/{D1_DATABASE_ID}/query',
        headers={**AUTH, 'Content-Type': 'application/json'},
        json={'sql': sql, 'params': params or []}, timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if not data['success']:
        raise RuntimeError(data['errors'])
    return data['result'][0]['results']

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

# ── Query Postgres ────────────────────────────────────────────────────────────

print(f'Connecting to PostgreSQL ({PG_DSN.split()[0]})...')
conn   = psycopg2.connect(PG_DSN)
cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

print('Querying geometry...')
cursor.execute("""
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
    ORDER BY pg.parcel_id
""")

rows = cursor.fetchall()
conn.close()
print(f'{len(rows):,} parcels with geometry')

# ── Push to D1 ────────────────────────────────────────────────────────────────

PATCH_CARDS = 'UPDATE parcel_cards SET latitude=?, longitude=?, geometry=? WHERE parcel_id=?'
UPSERT_GEO  = 'INSERT OR REPLACE INTO parcel_geo_layers (parcel_id, enriched_date, layers) VALUES (?, ?, ?)'

print(f'Writing to D1...')
patched = 0

for i in range(0, len(rows), BATCH_SIZE):
    chunk = rows[i:i + BATCH_SIZE]
    stmts = []
    for row in chunk:
        pid  = row['parcel_id']
        lat  = float(row['latitude'])
        lon  = float(row['longitude'])
        geom = row['geometry']
        stmts.append({'sql': PATCH_CARDS, 'params': [lat, lon, geom, pid]})
        stmts.append({'sql': UPSERT_GEO,  'params': [pid, TODAY, json.dumps({'latitude': lat, 'longitude': lon})]})
        patched += 1

    d1_batch(stmts)

    if i % (BATCH_SIZE * 10) == 0:
        print(f'  {min(i + BATCH_SIZE, len(rows)):,} / {len(rows):,}')

print(f'\nDone — {patched:,} parcels written')

# ── Verify ────────────────────────────────────────────────────────────────────

total = d1_query('SELECT COUNT(*) as n FROM parcel_cards')[0]['n']
has   = d1_query('SELECT COUNT(*) as n FROM parcel_cards WHERE latitude IS NOT NULL')[0]['n']
print(f'parcel_cards: {total:,} total | {has:,} with lat/lon | {total - has:,} still missing')
