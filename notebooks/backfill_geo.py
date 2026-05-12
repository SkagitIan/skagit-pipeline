"""
Skagit Geo Backfill — paste this into a Google Colab cell and run it.
Reads CF_ACCOUNT_ID and CF_API_TOKEN from Colab secrets (the key icon in the sidebar).
"""

import requests, json, time, math
from datetime import date
from google.colab import userdata

# ── Config ────────────────────────────────────────────────────────────────────

CF_ACCOUNT_ID  = userdata.get('CF_ACCOUNT_ID')
CF_API_TOKEN   = userdata.get('CF_API_TOKEN')
D1_DATABASE_ID = 'bd1fd2cb-9d82-4068-a79a-de55c83cc981'

ONLY_MISSING = False   # True = skip parcels already in parcel_geo_layers
BATCH_SIZE   = 50      # IDs per ArcGIS request
LIMIT        = None    # set an int to cap total parcels for testing

MAPSERVER    = 'https://gis.skagitcountywa.gov/arcgis/rest/services/Assessor/PropertyMap/MapServer'
GEO_LAYER_ID = 5
TODAY        = date.today().isoformat()
CF_BASE      = f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}'
AUTH         = {'Authorization': f'Bearer {CF_API_TOKEN}'}

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

def d1_all(sql):
    rows, offset = [], 0
    while True:
        chunk = d1_query(f'{sql} LIMIT 10000 OFFSET {offset}')
        rows.extend(chunk)
        if len(chunk) < 10000:
            break
        offset += 10000
    return rows

# ── ArcGIS helpers ────────────────────────────────────────────────────────────

def discover_layers():
    r = requests.get(f'{MAPSERVER}?f=json', timeout=15)
    r.raise_for_status()
    return [{'id': l['id'], 'name': l['name']} for l in r.json().get('layers', [])]

def query_layer(layer_id, parcel_ids):
    in_list = ','.join(f"'{pid}'" for pid in parcel_ids)
    r = requests.get(f'{MAPSERVER}/{layer_id}/query', timeout=30, params={
        'where':          f'PARCELID IN ({in_list})',
        'outFields':      '*',
        'returnGeometry': 'true' if layer_id == GEO_LAYER_ID else 'false',
        'outSR':          '4326',
        'f':              'json',
    })
    r.raise_for_status()
    return r.json()

def centroid(rings):
    coords = rings[0]
    lats = [c[1] for c in coords]
    lons = [c[0] for c in coords]
    return (min(lats) + max(lats)) / 2, (min(lons) + max(lons)) / 2

# ── Step 1: Discover layers ───────────────────────────────────────────────────

layers = discover_layers()
print(f'Found {len(layers)} layers:')
for l in layers:
    print(f'  [{l["id"]}] {l["name"]}')

# ── Step 2: Load parcel IDs ───────────────────────────────────────────────────

if ONLY_MISSING:
    sql = ('SELECT parcel_id FROM parcel_cards '
           'WHERE parcel_id NOT IN (SELECT parcel_id FROM parcel_geo_layers) '
           'ORDER BY parcel_id')
else:
    sql = 'SELECT parcel_id FROM parcel_cards ORDER BY parcel_id'

print('\nLoading parcel IDs...')
all_ids = [r['parcel_id'] for r in d1_all(sql)]
if LIMIT:
    all_ids = all_ids[:LIMIT]
print(f'{len(all_ids):,} parcels to process')

# ── Step 3: Query each layer ──────────────────────────────────────────────────

enriched = {}  # parcel_id -> { layer_name: attrs, '_geo': {...} }

for layer in layers:
    lid, lname = layer['id'], layer['name']
    hits, errors = 0, 0
    print(f'\nLayer [{lid}] {lname}...')

    for i in range(0, len(all_ids), BATCH_SIZE):
        chunk = all_ids[i:i + BATCH_SIZE]
        try:
            data = query_layer(lid, chunk)
        except Exception as e:
            print(f'  batch {i} error: {e}')
            errors += 1
            time.sleep(2)
            continue

        for feature in data.get('features', []):
            pid = feature.get('attributes', {}).get('PARCELID')
            if not pid:
                continue
            if pid not in enriched:
                enriched[pid] = {}
            enriched[pid][lname] = {k: v for k, v in feature['attributes'].items() if v is not None}
            if lid == GEO_LAYER_ID:
                rings = (feature.get('geometry') or {}).get('rings')
                if rings:
                    lat, lon = centroid(rings)
                    enriched[pid]['_geo'] = {
                        'latitude':  lat,
                        'longitude': lon,
                        'geometry':  json.dumps({'type': 'Polygon', 'coordinates': rings}),
                    }
            hits += 1

        if i % (BATCH_SIZE * 50) == 0:
            print(f'  {min(i + BATCH_SIZE, len(all_ids)):,} / {len(all_ids):,}  ({hits} hits)')
        time.sleep(0.2)

    print(f'  done — {hits} features, {errors} errors')

print(f'\n{len(enriched):,} parcels enriched across all layers')

# ── Step 4: Write to D1 ───────────────────────────────────────────────────────

GEO_LAYERS_SQL = 'INSERT OR REPLACE INTO parcel_geo_layers (parcel_id, enriched_date, layers) VALUES (?, ?, ?)'
PATCH_GEO_SQL  = 'UPDATE parcel_cards SET latitude=?, longitude=?, geometry=? WHERE parcel_id=?'

enriched_ids = list(enriched.keys())
layers_writ, geo_patched = 0, 0

print('\nWriting to D1...')
for i in range(0, len(enriched_ids), 100):
    chunk = enriched_ids[i:i + 100]
    stmts = []
    for pid in chunk:
        data = enriched[pid]
        geo  = data.get('_geo')
        blob = json.dumps({k: v for k, v in data.items() if k != '_geo'})
        stmts.append({'sql': GEO_LAYERS_SQL, 'params': [pid, TODAY, blob]})
        layers_writ += 1
        if geo:
            stmts.append({'sql': PATCH_GEO_SQL, 'params': [geo['latitude'], geo['longitude'], geo['geometry'], pid]})
            geo_patched += 1
    d1_batch(stmts)
    if i % 1000 == 0:
        print(f'  {min(i + 100, len(enriched_ids)):,} / {len(enriched_ids):,}')

print(f'\nDone — {layers_writ:,} geo_layer rows written, {geo_patched:,} parcel_cards patched')

# ── Step 5: Verify ────────────────────────────────────────────────────────────

total  = d1_query('SELECT COUNT(*) as n FROM parcel_cards')[0]['n']
has    = d1_query('SELECT COUNT(*) as n FROM parcel_cards WHERE latitude IS NOT NULL')[0]['n']
glrows = d1_query('SELECT COUNT(*) as n FROM parcel_geo_layers')[0]['n']
print(f'\nparcel_cards:      {total:,} total | {has:,} with lat/lon | {total - has:,} still missing')
print(f'parcel_geo_layers: {glrows:,} rows')
