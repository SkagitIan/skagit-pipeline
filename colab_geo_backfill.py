"""
Skagit Parcel Geo Backfill
Run once in Google Colab to fetch lat/lon for all ~80k parcels.
Outputs parcel_geo.csv — then use the seed SQL to load into D1.

Runtime estimate: ~4.5 hours at 5 req/sec.
Use Colab's "Run all" and let it go.
"""

import requests, pandas as pd, json, time, os
from tqdm.notebook import tqdm

# ── Config ────────────────────────────────────────────────────────────────────
SOURCE_ZIP = "https://www.skagitcounty.net/Assessor/Documents/DataDownloads/SkagitAssessmentData.zip"
GIS_URL    = "https://gis.skagitcountywa.gov/arcgis/rest/services/Assessor/PropertyMap/MapServer/5/query"
SLEEP_SEC  = 0.2   # 5 req/sec
OUTPUT_CSV = "parcel_geo.csv"
CHECKPOINT = "parcel_geo_checkpoint.csv"  # resume from here if interrupted

# ── Step 1: Download and extract assessor file ────────────────────────────────
import zipfile, io

print("Downloading assessor data...")
r = requests.get(SOURCE_ZIP, stream=True)
z = zipfile.ZipFile(io.BytesIO(r.content))
print("Files in zip:", z.namelist())

# Find assessor file (may be named Assessor.txt or similar)
assessor_name = next(f for f in z.namelist() if 'ssessor' in f and not f.endswith('/'))
df_assessor = pd.read_csv(z.open(assessor_name), sep='|', dtype=str, low_memory=False)
print(f"Loaded {len(df_assessor)} assessor rows, columns: {list(df_assessor.columns[:5])}...")

# Normalize parcel IDs
parcel_col = 'Parcel Number'  # adjust if different
df_assessor['parcel_id'] = df_assessor[parcel_col].str.replace(r'[\s\-]', '', regex=True).str.strip()
parcel_ids = df_assessor['parcel_id'].dropna().unique().tolist()
print(f"Unique parcels: {len(parcel_ids)}")

# ── Step 2: Resume from checkpoint if exists ─────────────────────────────────
done = set()
results = []

if os.path.exists(CHECKPOINT):
    df_done = pd.read_csv(CHECKPOINT, dtype=str)
    done = set(df_done['parcel_id'].tolist())
    results = df_done.to_dict('records')
    print(f"Resuming: {len(done)} already done")

remaining = [p for p in parcel_ids if p not in done]
print(f"Remaining: {len(remaining)}")

# ── Step 3: Fetch geo ─────────────────────────────────────────────────────────
def fetch_geo(parcel_id):
    params = {
        'where':          f"PARCELID='{parcel_id}'",
        'outFields':      'PARCELID',
        'returnGeometry': 'true',
        'outSR':          4326,
        'f':              'json',
    }
    try:
        data = requests.get(GIS_URL, params=params, timeout=10).json()
        feats = data.get('features', [])
        if not feats:
            return None, None, None
        rings = feats[0]['geometry']['rings']
        coords = rings[0]
        lons = [c[0] for c in coords]
        lats = [c[1] for c in coords]
        return (
            (min(lats) + max(lats)) / 2,
            (min(lons) + max(lons)) / 2,
            json.dumps({'type': 'Polygon', 'coordinates': rings}),
        )
    except Exception as e:
        return None, None, None

SAVE_EVERY = 500
for i, pid in enumerate(tqdm(remaining, desc="Fetching geo")):
    lat, lon, geom = fetch_geo(pid)
    results.append({'parcel_id': pid, 'latitude': lat, 'longitude': lon, 'geometry': geom})
    time.sleep(SLEEP_SEC)

    if (i + 1) % SAVE_EVERY == 0:
        pd.DataFrame(results).to_csv(CHECKPOINT, index=False)

# ── Step 4: Save final output ─────────────────────────────────────────────────
df_geo = pd.DataFrame(results)
df_geo.to_csv(OUTPUT_CSV, index=False)
print(f"\nSaved {len(df_geo)} rows to {OUTPUT_CSV}")
print(f"  Found geo: {df_geo['latitude'].notna().sum()}")
print(f"  Missing:   {df_geo['latitude'].isna().sum()}")

# ── Step 5: Generate seed SQL for D1 ─────────────────────────────────────────
print("\nGenerating seed SQL...")
rows_with_geo = df_geo[df_geo['latitude'].notna()]

with open('seed_geo.sql', 'w') as f:
    for _, row in rows_with_geo.iterrows():
        geom_escaped = str(row['geometry']).replace("'", "''") if row['geometry'] else 'NULL'
        f.write(
            f"UPDATE parcel_cards SET latitude={row['latitude']}, longitude={row['longitude']}, "
            f"geometry='{geom_escaped}' WHERE parcel_id='{row['parcel_id']}';\n"
        )

print(f"Saved seed_geo.sql with {len(rows_with_geo)} UPDATE statements")
print("\nTo load into D1:")
print("  wrangler d1 execute skagit-parcels --file=seed_geo.sql")
print("\nOr split into chunks:")
print("  split -l 1000 seed_geo.sql seed_geo_chunk_")
print("  for f in seed_geo_chunk_*; do wrangler d1 execute skagit-parcels --file=$f; done")
