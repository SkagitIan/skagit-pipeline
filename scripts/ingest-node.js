#!/usr/bin/env node
/**
 * Parcel ingest — runs in GitHub Actions (no CPU/memory/time limits).
 * Reuses src/lib/ modules directly so field mappings stay in one place.
 * Talks to D1 via the Cloudflare REST API.
 *
 * GitHub secrets required:
 *   CF_ACCOUNT_ID   — Cloudflare account ID
 *   CF_API_TOKEN    — API token with D1 edit permissions
 *   D1_DATABASE_ID  — hardcoded as default, overrideable via env
 */

import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync, existsSync } from 'node:fs';
import { resolve }                  from 'node:path';
import { parsePSV, indexBy, groupBy } from '../src/lib/parse.js';
import { computeDelta }               from '../src/lib/delta.js';
import { buildCard, cardToRow }       from '../src/lib/card.js';

// ── Land use filter (config/land_use_filter.json) ────────────────────────────
// Keys starting with '_' are metadata comments, ignored during filtering.
// A missing file means: allow everything.
const FILTER_PATH  = resolve('config/land_use_filter.json');
const landUseFilter = existsSync(FILTER_PATH)
  ? JSON.parse(readFileSync(FILTER_PATH, 'utf8'))
  : null;
if (landUseFilter) {
  const excluded = Object.entries(landUseFilter).filter(([k, v]) => !k.startsWith('_') && v === false).length;
  console.log(`[ingest] land use filter loaded — ${excluded} codes excluded`);
} else {
  console.log('[ingest] no land use filter found — all codes allowed');
}

// ── Config ────────────────────────────────────────────────────────────────────

const {
  CF_ACCOUNT_ID  = '',
  CF_API_TOKEN   = '',
  D1_DATABASE_ID = 'bd1fd2cb-9d82-4068-a79a-de55c83cc981',
  FORCE_FULL_REINGEST = '',
} = process.env;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
  console.error('ERROR: CF_ACCOUNT_ID and CF_API_TOKEN must be set');
  process.exit(1);
}

const SOURCE    = 'https://www.skagitcounty.net/Assessor/Documents/DataDownloads/SkagitAssessmentData.zip';
const forceFull = FORCE_FULL_REINGEST === '1' || FORCE_FULL_REINGEST.toLowerCase() === 'true';

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

const INSERT_COLUMNS = 20;
const BATCH_SIZE  = 25;  // 25 rows * 20 columns = 500 params per D1 request
const DELETE_BATCH_SIZE = 100;
const CONCURRENCY = 2;
const D1_MAX_ATTEMPTS = 6;

// ── Cloudflare REST API helpers ───────────────────────────────────────────────

const CF_BASE    = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}`;
const authHeader = { Authorization: `Bearer ${CF_API_TOKEN}` };

async function d1Query(statements) {
  if (Array.isArray(statements)) {
    return Promise.all(statements.map(statement => d1Query(statement)));
  }

  for (let attempt = 1; attempt <= D1_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${CF_BASE}/d1/database/${D1_DATABASE_ID}/query`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(statements),
    });
    const data = await res.json();
    if (res.ok && data.success) return data.result;

    const detail = JSON.stringify(data.errors ?? data);
    if (!isRetryableD1Error(res.status, data) || attempt === D1_MAX_ATTEMPTS) {
      throw new Error(`D1 query failed: ${detail}`);
    }

    const delay = 1000 * attempt * attempt;
    console.warn(`[ingest] D1 busy, retrying attempt ${attempt + 1}/${D1_MAX_ATTEMPTS} after ${delay}ms: ${detail}`);
    await sleep(delay);
  }
}

async function d1First(sql, params = []) {
  const result = await d1Query({ sql, params });
  return result?.[0]?.results?.[0] ?? null;
}

async function ensureMetadataTables() {
  await d1Query([
    {
      sql: `CREATE TABLE IF NOT EXISTS ingest_manifests (
        name TEXT PRIMARY KEY,
        updated_date TEXT,
        manifest_json TEXT NOT NULL
      )`,
      params: [],
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS ingest_runs (
        run_date TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL
      )`,
      params: [],
    },
  ]);
}

async function getManifest(name) {
  if (forceFull) return null;
  const row = await d1First(
    'SELECT manifest_json FROM ingest_manifests WHERE name = ?',
    [name],
  );
  return row?.manifest_json ? JSON.parse(row.manifest_json) : null;
}

async function putManifest(name, manifest, date) {
  await d1Query({
    sql: `INSERT OR REPLACE INTO ingest_manifests
      (name, updated_date, manifest_json)
      VALUES (?, ?, ?)`,
    params: [name, date, JSON.stringify(manifest)],
  });
}

async function putRunSummary(date, summary) {
  await d1Query({
    sql: `INSERT OR REPLACE INTO ingest_runs
      (run_date, summary_json)
      VALUES (?, ?)`,
    params: [date, JSON.stringify(summary)],
  });
}

function isRetryableD1Error(status, data) {
  const errors = data?.errors ?? [];
  return status === 429 ||
    status >= 500 ||
    errors.some(error => error?.code === 7429 || /overloaded|queued for too long/i.test(error?.message ?? ''));
}

function buildMultiRowInsert(rows) {
  const placeholders = rows
    .map(() => `(${Array.from({ length: INSERT_COLUMNS }, () => '?').join(',')})`)
    .join(',');
  return {
    sql: INSERT_SQL.replace('VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', `VALUES ${placeholders}`),
    params: rows.flat(),
  };
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runPool(tasks, concurrency) {
  const queue = [...tasks];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) await queue.shift()();
    }),
  );
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Main ──────────────────────────────────────────────────────────────────────

const date = new Date().toISOString().slice(0, 10);
console.log(`[ingest] starting ${date}`);
if (forceFull) console.log('[ingest] FORCE_FULL_REINGEST enabled — rewriting every assessor parcel');

await ensureMetadataTables();

// 1. Download
console.log('[ingest] downloading source zip…');
const zipRes = await fetch(SOURCE);
if (!zipRes.ok) { console.error(`Download failed: ${zipRes.status}`); process.exit(1); }
const zipBuf = Buffer.from(await zipRes.arrayBuffer());
console.log(`[ingest] downloaded ${(zipBuf.length / 1e6).toFixed(1)} MB`);

// 2. Unzip
const unzipped = unzipSync(new Uint8Array(zipBuf));
const fileIndex = {};
for (const [k, v] of Object.entries(unzipped)) {
  const base = k.split('/').pop();
  const name = Object.keys(FILE_MAP).find(f => f.toLowerCase() === base.toLowerCase());
  if (name) fileIndex[FILE_MAP[name]] = strFromU8(v);
}
console.log(`[ingest] found files: ${Object.keys(fileIndex).join(', ')}`);
if (Object.keys(fileIndex).length < 4) {
  console.warn(`[ingest] WARNING: expected 4 files, got ${Object.keys(fileIndex).length}`);
}

// 3. Parse
const parsed = {};
for (const [name, text] of Object.entries(fileIndex)) {
  parsed[name] = parsePSV(text, name);
  console.log(`[ingest] ${name}: ${parsed[name].rows.length} rows`);
}

// 4. Delta — compare against D1 manifests from last run
const deltas = {};
const nextManifests = [];

for (const name of Object.keys(parsed)) {
  const prevManifest = await getManifest(name);
  const { delta, manifest } = computeDelta(prevManifest, parsed[name].rows, parsed[name].headers);
  deltas[name] = delta;
  console.log(
    `[ingest] ${name} delta: +${delta.added.length} ~${delta.modified.length}` +
    ` -${delta.deleted.length} schema_changed=${delta.schemaChanged}`,
  );
  nextManifests.push({ name, manifest });
}

// 5. Determine which parcel IDs need writing
const dirtyIds = new Set([
  ...(deltas.assessor?.added        ?? []),
  ...(deltas.assessor?.modified     ?? []),
  ...(deltas.land?.added            ?? []),
  ...(deltas.land?.modified         ?? []),
  ...(deltas.improvements?.added    ?? []),
  ...(deltas.improvements?.modified ?? []),
  ...(deltas.sales?.added           ?? []),
  ...(deltas.sales?.modified        ?? []),
]);

const assessorIdx = indexBy(parsed.assessor?.rows ?? []);

if (deltas.assessor?.schemaChanged) {
  console.log('[ingest] assessor schema changed — forcing full rewrite');
  for (const id of Object.keys(assessorIdx)) dirtyIds.add(id);
}
if (forceFull) {
  for (const id of Object.keys(assessorIdx)) dirtyIds.add(id);
}

const idsToWrite = [...dirtyIds].filter(id => {
  if (!assessorIdx[id]) return false;
  const a = assessorIdx[id];
  if (+(a['Assessed Value'] ?? 0) <= 0) return false;
  if (a['PropType'] === 'P') return false;           // skip personal property
  if (landUseFilter) {
    const code = (a['Land Use'] ?? '').trim();
    if (code && landUseFilter[code] === false) return false;
  }
  return true;
});

console.log(`[ingest] parcels to write: ${idsToWrite.length} of ${Object.keys(assessorIdx).length} total`);

// 6. Write dirty parcels to D1 in parallel batches
const landIdx  = indexBy(parsed.land?.rows         ?? []);
const impsIdx  = groupBy(parsed.improvements?.rows ?? []);
const salesIdx = groupBy(parsed.sales?.rows        ?? []);

const batchTasks = [];
for (let i = 0; i < idsToWrite.length; i += BATCH_SIZE) {
  const chunk = idsToWrite.slice(i, i + BATCH_SIZE);
  batchTasks.push(async () => {
    const rows = chunk.map(id => {
      const card = buildCard(
        id, assessorIdx[id], landIdx[id],
        impsIdx[id] ?? [], salesIdx[id] ?? [],
        date,
      );
      return cardToRow(card);
    });
    await d1Query(buildMultiRowInsert(rows));
  });
}

await runPool(batchTasks, CONCURRENCY);
console.log(`[ingest] wrote ${idsToWrite.length} parcel cards`);

// 7. Delete parcels removed from assessor file
const deletedIds = deltas.assessor?.deleted ?? [];
if (deletedIds.length) {
  const deleteTasks = [];
  for (let i = 0; i < deletedIds.length; i += DELETE_BATCH_SIZE) {
    const chunk        = deletedIds.slice(i, i + DELETE_BATCH_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    deleteTasks.push(() =>
      d1Query({ sql: `DELETE FROM parcel_cards WHERE parcel_id IN (${placeholders})`, params: chunk }),
    );
  }
  await runPool(deleteTasks, CONCURRENCY);
  console.log(`[ingest] deleted ${deletedIds.length} removed parcels`);
}

// 8. Write run summary to D1 metadata
const summary = {
  date,
  force_full_reingest: forceFull,
  parcels_written: idsToWrite.length,
  parcels_deleted: deletedIds.length,
  total_in_assessor: Object.keys(assessorIdx).length,
  deltas: Object.fromEntries(
    Object.entries(deltas).map(([name, d]) => [
      name,
      { added: d.added.length, modified: d.modified.length, deleted: d.deleted.length, schema_changed: d.schemaChanged },
    ]),
  ),
};

// 9. Persist manifests only after all DB writes have succeeded.
await Promise.all([
  ...nextManifests.map(({ name, manifest }) => putManifest(name, manifest, date)),
  putRunSummary(date, summary),
]);
console.log('[ingest] done');
