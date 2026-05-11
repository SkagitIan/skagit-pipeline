import { unzipSync, strFromU8 } from 'fflate';
import { parsePSV, indexBy, groupBy } from './parse.js';
import { computeDelta } from './delta.js';
import { buildCard, cardToRow } from './card.js';

const SOURCE = 'https://www.skagitcounty.net/Assessor/Documents/DataDownloads/SkagitAssessmentData.zip';

// File names inside the zip → our internal name
// Adjust these if the zip contents differ
const FILE_MAP = {
  'AssessorData.txt':     'assessor',
  'Improvements.txt': 'improvements',
  'Land.txt':         'land',
  'Sales.txt':        'sales',
};

const INSERT_SQL = `INSERT OR REPLACE INTO parcel_cards
  (parcel_id, updated_date, assessed_value, land_value, improvement_value,
   year_built, sq_ft, bedrooms, bathrooms,
   land_use_code, zoning, acres,
   improvements, sales_history,
   latitude, longitude, geometry, raw_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export async function runIngest(env) {
  const date = new Date().toISOString().slice(0, 10);
  console.log(`[ingest] starting ${date}`);

  // 1. Download zip
  const zip = await fetch(SOURCE).then(r => {
    if (!r.ok) throw new Error(`Download failed: ${r.status}`);
    return r.arrayBuffer();
  });
  console.log(`[ingest] downloaded ${(zip.byteLength / 1e6).toFixed(1)}MB`);

  // 2. Unzip
  const unzipped = unzipSync(new Uint8Array(zip));

  // Normalize filenames (zip may use different casing)
  const fileIndex = {};
  for (const [k, v] of Object.entries(unzipped)) {
    const base = k.split('/').pop(); // strip any folder prefix
    const name = Object.keys(FILE_MAP).find(f => f.toLowerCase() === base.toLowerCase());
    if (name) fileIndex[FILE_MAP[name]] = strFromU8(v);
  }

  const fileNames = Object.keys(fileIndex);
  console.log(`[ingest] found files: ${fileNames.join(', ')}`);
  if (fileNames.length < 4) console.warn('[ingest] WARNING: expected 4 files, got', fileNames.length);

  // 3. Parse all four
  const parsed = {};
  for (const [name, text] of Object.entries(fileIndex)) {
    parsed[name] = parsePSV(text, name);
    console.log(`[ingest] ${name}: ${parsed[name].rows.length} rows`);
  }

  // 4. Delta per file
  for (const name of Object.keys(parsed)) {
    const prevManifestObj = await env.PARCEL_STORE.get(`manifests/${name}.json`);
    const prevManifest = prevManifestObj ? JSON.parse(await prevManifestObj.text()) : null;
    const { delta, manifest } = computeDelta(prevManifest, parsed[name].rows, parsed[name].headers);

    await env.PARCEL_STORE.put(`manifests/${name}.json`, JSON.stringify(manifest));
    await env.PARCEL_STORE.put(`deltas/${date}/${name}.json`, JSON.stringify(delta));
    console.log(`[ingest] ${name} delta: +${delta.added.length} ~${delta.modified.length} -${delta.deleted.length} schema_changed=${delta.schemaChanged}`);
  }

  // 5. Build parcel cards
  const assessorIdx = indexBy(parsed.assessor?.rows ?? []);
  const landIdx     = indexBy(parsed.land?.rows ?? []);
  const impsIdx     = groupBy(parsed.improvements?.rows ?? []);
  const salesIdx    = groupBy(parsed.sales?.rows ?? []);

  const allIds = Object.keys(assessorIdx);
  const BATCH  = 100; // D1 batch limit
  let written  = 0;

  for (let i = 0; i < allIds.length; i += BATCH) {
    const chunk = allIds.slice(i, i + BATCH);
    const stmts = chunk.map(id => {
      const card = buildCard(id, assessorIdx[id], landIdx[id], impsIdx[id] ?? [], salesIdx[id] ?? [], date);
      return env.PARCEL_DB.prepare(INSERT_SQL).bind(...cardToRow(card));
    });
    await env.PARCEL_DB.batch(stmts);
    written += chunk.length;
  }

  console.log(`[ingest] wrote ${written} parcel cards`);

  // 6. Export NDJSON to R2 for DuckDB / external analysis
  // const all = await env.PARCEL_DB.prepare('SELECT * FROM parcel_cards').all();
  // const ndjson = all.results.map(r => JSON.stringify(r)).join('\n');
  // await env.PARCEL_STORE.put('exports/latest/parcel_cards.ndjson', ndjson);
  // await env.PARCEL_STORE.put(`exports/${date}/parcel_cards.ndjson`, ndjson);
  console.log(`[ingest] exported ${all.results.length} rows to R2`);
}
