import { unzipSync, strFromU8 } from 'fflate';
import { parsePSV, indexBy, groupBy } from './parse.js';
import { computeDelta } from './delta.js';
import { buildCard, cardToRow } from './card.js';

const SOURCE = 'https://www.skagitcounty.net/Assessor/Documents/DataDownloads/SkagitAssessmentData.zip';

const FILE_MAP = {
  'AssessorData.txt': 'assessor',
  'Improvements.txt': 'improvements',
  'Land.txt':         'land',
  'Sales.txt':        'sales',
};

const INSERT_SQL = `INSERT OR REPLACE INTO parcel_cards
  (parcel_id, updated_date, assessed_value, land_value, improvement_value,
   year_built, sq_ft, bedrooms, bathrooms,
   land_use_code, zoning, acres,
   improvements, sales_history,
   latitude, longitude, geometry,
   absentee_owner, days_since_last_sale,
   raw_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

// How many D1 batch() calls to fire in parallel. Each batch holds up to 100 statements.
// 5 concurrent × 100 rows = 500 rows per round-trip group.
const BATCH_SIZE   = 100;
const CONCURRENCY  = 5;

export async function runIngest(env) {
  const date = new Date().toISOString().slice(0, 10);
  console.log(`[ingest] starting ${date}`);

  // 1. Download zip
  const zip = await fetch(SOURCE).then(r => {
    if (!r.ok) throw new Error(`Download failed: ${r.status}`);
    return r.arrayBuffer();
  });
  console.log(`[ingest] downloaded ${(zip.byteLength / 1e6).toFixed(1)} MB`);

  // 2. Unzip — normalize filenames (zip may use different casing or folder prefix)
  const unzipped = unzipSync(new Uint8Array(zip));
  const fileIndex = {};
  for (const [k, v] of Object.entries(unzipped)) {
    const base = k.split('/').pop();
    const name = Object.keys(FILE_MAP).find(f => f.toLowerCase() === base.toLowerCase());
    if (name) fileIndex[FILE_MAP[name]] = strFromU8(v);
  }
  console.log(`[ingest] found files: ${Object.keys(fileIndex).join(', ')}`);
  if (Object.keys(fileIndex).length < 4) {
    console.warn('[ingest] WARNING: expected 4 files, got', Object.keys(fileIndex).length);
  }

  // 3. Parse all four files
  const parsed = {};
  for (const [name, text] of Object.entries(fileIndex)) {
    parsed[name] = parsePSV(text, name);
    console.log(`[ingest] ${name}: ${parsed[name].rows.length} rows`);
  }

  // 4. Delta per file — load previous manifests, compute changes, persist new manifests
  const deltas = {};
  const nextManifests = [];
  for (const name of Object.keys(parsed)) {
    const prevObj = await env.PARCEL_STORE.get(`manifests/${name}.json`);
    const prevManifest = prevObj ? JSON.parse(await prevObj.text()) : null;
    const { delta, manifest } = computeDelta(prevManifest, parsed[name].rows, parsed[name].headers);
    deltas[name] = delta;

    // Fire manifest + delta writes in background — don't block on them
    nextManifests.push({ name, manifest, delta });

    console.log(
      `[ingest] ${name} delta: +${delta.added.length} ~${delta.modified.length}` +
      ` -${delta.deleted.length} schema_changed=${delta.schemaChanged}`,
    );
  }

  // 5. Determine which parcel IDs actually need a DB write.
  //    A parcel is dirty if ANY of its four source files changed.
  //    On a typical night this is a small fraction of the total dataset.
  const dirtyIds = new Set([
    ...(deltas.assessor?.added      ?? []),
    ...(deltas.assessor?.modified   ?? []),
    ...(deltas.land?.added          ?? []),
    ...(deltas.land?.modified       ?? []),
    ...(deltas.improvements?.added  ?? []),
    ...(deltas.improvements?.modified ?? []),
    ...(deltas.sales?.added         ?? []),
    ...(deltas.sales?.modified      ?? []),
  ]);

  // If the assessor schema changed, treat every parcel as dirty (rare but safe)
  const assessorIdx = indexBy(parsed.assessor?.rows ?? []);
  if (deltas.assessor?.schemaChanged) {
    console.log('[ingest] assessor schema changed — forcing full rewrite');
    for (const id of Object.keys(assessorIdx)) dirtyIds.add(id);
  }

  // Only write parcels that exist in the assessor file, have a positive assessed value,
  // and are real property rather than personal property.
  const idsToWrite = [...dirtyIds].filter(id => {
    if (!assessorIdx[id]) return false;
    const a = assessorIdx[id];
    const val = +(a['Assessed Value'] ?? 0);
    if (val <= 0) return false;
    if (a['PropType'] === 'P') return false;
    return true;
  });
  console.log(`[ingest] parcels to write: ${idsToWrite.length} of ${Object.keys(assessorIdx).length} total`);

  // 6. Build indexes for the other three files
  const landIdx  = indexBy(parsed.land?.rows ?? []);
  const impsIdx  = groupBy(parsed.improvements?.rows ?? []);
  const salesIdx = groupBy(parsed.sales?.rows ?? []);

  // 7. Write dirty parcels to D1 — BATCH_SIZE rows per batch(), CONCURRENCY batches at once
  let written = 0;
  for (let i = 0; i < idsToWrite.length; i += BATCH_SIZE * CONCURRENCY) {
    const parallelBatches = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      const chunk = idsToWrite.slice(start, start + BATCH_SIZE);
      if (!chunk.length) break;
      const stmts = chunk.map(id => {
        const card = buildCard(
          id, assessorIdx[id], landIdx[id],
          impsIdx[id] ?? [], salesIdx[id] ?? [],
          date,
        );
        return env.PARCEL_DB.prepare(INSERT_SQL).bind(...cardToRow(card));
      });
      parallelBatches.push(env.PARCEL_DB.batch(stmts));
    }
    await Promise.all(parallelBatches);
    written += parallelBatches.length * BATCH_SIZE; // approximate; last batch may be smaller
  }
  written = idsToWrite.length; // exact count

  // 8. Delete parcels that disappeared from the assessor file
  const deletedIds = deltas.assessor?.deleted ?? [];
  if (deletedIds.length) {
    // D1 has no array bind support, so chunk into batches of 100
    for (let i = 0; i < deletedIds.length; i += BATCH_SIZE) {
      const chunk = deletedIds.slice(i, i + BATCH_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      await env.PARCEL_DB
        .prepare(`DELETE FROM parcel_cards WHERE parcel_id IN (${placeholders})`)
        .bind(...chunk)
        .run();
    }
    console.log(`[ingest] deleted ${deletedIds.length} removed parcels`);
  }

  console.log(`[ingest] done — wrote ${written}, deleted ${deletedIds.length}`);

  // Wait for manifest/delta R2 writes to complete before returning
  await Promise.all(nextManifests.flatMap(({ name, manifest, delta }) => [
    env.PARCEL_STORE.put(`manifests/${name}.json`, JSON.stringify(manifest)),
    env.PARCEL_STORE.put(`deltas/${date}/${name}.json`, JSON.stringify(delta)),
  ]));
}
