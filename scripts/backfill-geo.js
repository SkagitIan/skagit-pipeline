#!/usr/bin/env node
/**
 * One-time (and periodic refresh) ArcGIS multi-layer geo backfill.
 *
 * What it does:
 *   1. Discovers all layers from the Skagit PropertyMap MapServer
 *   2. Queries each layer in batches by parcel ID
 *   3. Upserts results into parcel_geo_layers (D1) as JSON blobs
 *   4. Also patches parcel_cards.latitude/longitude/geometry from layer 5 (polygons)
 *
 * Run:
 *   CF_ACCOUNT_ID=... CF_API_TOKEN=... node scripts/backfill-geo.js
 *
 * Optional env vars:
 *   LIMIT        — max parcels to process (default: all)
 *   ONLY_MISSING — set to "1" to skip parcels already in parcel_geo_layers (default: 0)
 *   BATCH_SIZE   — IDs per ArcGIS request (default: 50)
 *
 * GitHub secrets required (same as ingest):
 *   CF_ACCOUNT_ID, CF_API_TOKEN, D1_DATABASE_ID
 */

const MAPSERVER_BASE = 'https://gis.skagitcountywa.gov/arcgis/rest/services/Assessor/PropertyMap/MapServer';
const GEO_LAYER_ID   = 5;   // polygon layer used for lat/lon/geometry in parcel_cards

const {
  CF_ACCOUNT_ID  = '',
  CF_API_TOKEN   = '',
  D1_DATABASE_ID = 'bd1fd2cb-9d82-4068-a79a-de55c83cc981',
  LIMIT          = '',
  ONLY_MISSING   = '0',
  BATCH_SIZE     = '50',
} = process.env;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
  console.error('ERROR: CF_ACCOUNT_ID and CF_API_TOKEN must be set');
  process.exit(1);
}

const batchSize    = parseInt(BATCH_SIZE, 10);
const onlyMissing  = ONLY_MISSING === '1';
const maxParcels   = LIMIT ? parseInt(LIMIT, 10) : Infinity;

const CF_BASE    = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}`;
const authHeader = { Authorization: `Bearer ${CF_API_TOKEN}` };

// ── D1 helpers ────────────────────────────────────────────────────────────────

async function d1Query(sql, params = []) {
  const res  = await fetch(`${CF_BASE}/d1/database/${D1_DATABASE_ID}/query`, {
    method:  'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body:    JSON.stringify([{ sql, params }]),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors ?? data)}`);
  }
  return data.result[0];
}

async function d1Batch(statements) {
  const res  = await fetch(`${CF_BASE}/d1/database/${D1_DATABASE_ID}/query`, {
    method:  'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body:    JSON.stringify(statements),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(`D1 batch failed: ${JSON.stringify(data.errors ?? data)}`);
  }
  return data.result;
}

// ── ArcGIS helpers ────────────────────────────────────────────────────────────

async function discoverLayers() {
  const url = `${MAPSERVER_BASE}?f=json`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`MapServer discovery failed: ${res.status}`);
  const data = await res.json();
  return (data.layers ?? []).map(l => ({ id: l.id, name: l.name }));
}

async function queryLayer(layerId, parcelIds) {
  const inList = parcelIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
  const params = new URLSearchParams({
    where:          `PARCELID IN (${inList})`,
    outFields:      '*',
    returnGeometry: layerId === GEO_LAYER_ID ? 'true' : 'false',
    outSR:          '4326',
    f:              'json',
  });
  const res  = await fetch(`${MAPSERVER_BASE}/${layerId}/query?${params}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Layer ${layerId} query failed: ${res.status}`);
  return res.json();
}

function centroidFromRings(rings) {
  const coords = rings[0];
  const lons   = coords.map(c => c[0]);
  const lats   = coords.map(c => c[1]);
  return {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lon: (Math.min(...lons) + Math.max(...lons)) / 2,
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main ──────────────────────────────────────────────────────────────────────

const date = new Date().toISOString().slice(0, 10);
console.log(`[backfill-geo] starting ${date}`);

// 1. Discover layers
console.log('[backfill-geo] discovering MapServer layers…');
const layers = await discoverLayers();
console.log(`[backfill-geo] found ${layers.length} layers:`);
layers.forEach(l => console.log(`  [${l.id}] ${l.name}`));

// 2. Load parcel IDs from D1
console.log('[backfill-geo] loading parcel IDs from D1…');
const sql = onlyMissing
  ? `SELECT parcel_id FROM parcel_cards
     WHERE parcel_id NOT IN (SELECT parcel_id FROM parcel_geo_layers)
     ORDER BY parcel_id`
  : `SELECT parcel_id FROM parcel_cards ORDER BY parcel_id`;

// Fetch all IDs (D1 REST API max is 10k rows per call; page if needed)
let allIds = [];
let offset = 0;
const PAGE = 10_000;
while (true) {
  const result = await d1Query(`${sql} LIMIT ${PAGE} OFFSET ${offset}`);
  const chunk  = (result.results ?? []).map(r => r.parcel_id);
  allIds.push(...chunk);
  if (chunk.length < PAGE) break;
  offset += PAGE;
}

if (maxParcels < Infinity) allIds = allIds.slice(0, maxParcels);
console.log(`[backfill-geo] ${allIds.length} parcels to process (only_missing=${onlyMissing})`);

if (!allIds.length) {
  console.log('[backfill-geo] nothing to do');
  process.exit(0);
}

// 3. Process layer by layer
const enriched = {};  // parcelId → { layerName: { ...fields } }

for (const layer of layers) {
  console.log(`[backfill-geo] querying layer [${layer.id}] ${layer.name}…`);
  let layerHits = 0;

  for (let i = 0; i < allIds.length; i += batchSize) {
    const chunk = allIds.slice(i, i + batchSize);

    let data;
    try {
      data = await queryLayer(layer.id, chunk);
    } catch (e) {
      console.warn(`  layer ${layer.id} batch ${i}–${i + chunk.length} failed: ${e.message}`);
      await sleep(2000);
      continue;
    }

    for (const feature of data.features ?? []) {
      const id = feature.attributes?.PARCELID;
      if (!id) continue;
      if (!enriched[id]) enriched[id] = {};

      // Store all non-null attribute fields
      const attrs = Object.fromEntries(
        Object.entries(feature.attributes ?? {}).filter(([, v]) => v != null),
      );
      enriched[id][layer.name] = attrs;

      // For the polygon layer, also extract centroid + geometry
      if (layer.id === GEO_LAYER_ID && feature.geometry?.rings) {
        const rings  = feature.geometry.rings;
        const center = centroidFromRings(rings);
        enriched[id]['_geo'] = {
          latitude:  center.lat,
          longitude: center.lon,
          geometry:  JSON.stringify({ type: 'Polygon', coordinates: rings }),
        };
      }

      layerHits++;
    }

    if ((i / batchSize) % 20 === 0) {
      console.log(`  layer ${layer.id}: processed ${Math.min(i + batchSize, allIds.length)} / ${allIds.length}`);
    }

    await sleep(200);  // ~5 req/sec per layer
  }

  console.log(`  layer ${layer.id} done — ${layerHits} features collected`);
}

// 4. Write parcel_geo_layers and patch parcel_cards in D1 batches
console.log('[backfill-geo] writing to D1…');

const GEO_LAYERS_SQL = `INSERT OR REPLACE INTO parcel_geo_layers
  (parcel_id, enriched_date, layers)
  VALUES (?, ?, ?)`;

const PATCH_GEO_SQL = `UPDATE parcel_cards
  SET latitude=?, longitude=?, geometry=?
  WHERE parcel_id=?`;

const enrichedIds = Object.keys(enriched);
let   geoPatched  = 0;
let   layersWrit  = 0;

const WRITE_BATCH = 100;
for (let i = 0; i < enrichedIds.length; i += WRITE_BATCH) {
  const chunk      = enrichedIds.slice(i, i + WRITE_BATCH);
  const statements = [];

  for (const id of chunk) {
    const data = enriched[id];
    const geo  = data['_geo'];

    // Build layers blob (exclude internal _geo key)
    const layersBlob = JSON.stringify(
      Object.fromEntries(Object.entries(data).filter(([k]) => k !== '_geo')),
    );

    statements.push({ sql: GEO_LAYERS_SQL, params: [id, date, layersBlob] });
    layersWrit++;

    if (geo) {
      statements.push({ sql: PATCH_GEO_SQL, params: [geo.latitude, geo.longitude, geo.geometry, id] });
      geoPatched++;
    }
  }

  await d1Batch(statements);

  if ((i / WRITE_BATCH) % 10 === 0) {
    console.log(`  wrote ${Math.min(i + WRITE_BATCH, enrichedIds.length)} / ${enrichedIds.length}`);
  }
}

console.log(`[backfill-geo] done — ${layersWrit} geo_layers rows, ${geoPatched} parcel_cards patched`);
