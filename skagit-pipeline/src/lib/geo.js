const GIS_URL = 'https://gis.skagitcountywa.gov/arcgis/rest/services/Assessor/PropertyMap/MapServer/5/query';

export async function runGeoEnrich(env) {
  // Only patch parcels missing geo data (backfill done via Colab)
  const missing = await env.PARCEL_DB.prepare(
    'SELECT parcel_id FROM parcel_cards WHERE latitude IS NULL LIMIT 200'
  ).all();

  if (!missing.results.length) {
    console.log('[geo] nothing to enrich');
    return;
  }

  console.log(`[geo] enriching ${missing.results.length} parcels`);
  let success = 0;

  for (const { parcel_id } of missing.results) {
    try {
      const geo = await fetchGeo(parcel_id);
      if (geo) {
        await env.PARCEL_DB.prepare(
          'UPDATE parcel_cards SET latitude=?, longitude=?, geometry=? WHERE parcel_id=?'
        ).bind(geo.lat, geo.lon, geo.geojson, parcel_id).run();
        success++;
      }
    } catch (e) {
      console.warn(`[geo] failed ${parcel_id}:`, e.message);
    }
    await sleep(200); // ~5 req/sec — be polite
  }

  console.log(`[geo] enriched ${success} / ${missing.results.length}`);
}

async function fetchGeo(parcelId) {
  const params = new URLSearchParams({
    where:          `PARCELID='${parcelId}'`,
    outFields:      'PARCELID',
    returnGeometry: true,
    outSR:          4326,   // WGS84
    f:              'json',
  });
  const res = await fetch(`${GIS_URL}?${params}`, { signal: AbortSignal.timeout(8000) })
    .then(r => r.json());

  const rings = res.features?.[0]?.geometry?.rings;
  if (!rings?.length) return null;

  const coords = rings[0];
  const lons = coords.map(c => c[0]);
  const lats = coords.map(c => c[1]);
  return {
    lat:     (Math.min(...lats) + Math.max(...lats)) / 2,
    lon:     (Math.min(...lons) + Math.max(...lons)) / 2,
    geojson: JSON.stringify({ type: 'Polygon', coordinates: rings }),
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
