#!/usr/bin/env node

import { unzipSync, strFromU8 } from 'fflate';
import { createWriteStream, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePSV, indexBy, groupBy } from '../src/lib/parse.js';
import { computeDelta } from '../src/lib/delta.js';
import {
  PARCEL_CARD_COLUMNS,
  SALE_COLUMNS,
  IMPROVEMENT_COLUMNS,
  LAND_SEGMENT_COLUMNS,
  buildCard,
  buildSalesRows,
  buildImprovementRows,
  buildLandSegmentRows,
  rowFromObject,
} from '../src/lib/card.js';

const SOURCE = 'https://www.skagitcounty.net/Assessor/Documents/DataDownloads/SkagitAssessmentData.zip';
const FILE_MAP = {
  'AssessorData.txt': 'assessor',
  'Improvements.txt': 'improvements',
  'Land.txt': 'land',
  'Sales.txt': 'sales',
};

const {
  CF_ACCOUNT_ID = '',
  CF_API_TOKEN = '',
  D1_DATABASE_ID = 'bd1fd2cb-9d82-4068-a79a-de55c83cc981',
  FORCE_FULL_REINGEST = '',
  OUTPUT_SQL_FILE = '',
} = process.env;

const forceFull = FORCE_FULL_REINGEST === '1' || FORCE_FULL_REINGEST.toLowerCase() === 'true';
const outputSqlFile = OUTPUT_SQL_FILE.trim();

if (outputSqlFile && !forceFull) {
  console.error('ERROR: OUTPUT_SQL_FILE mode requires FORCE_FULL_REINGEST=1');
  process.exit(1);
}
if (!outputSqlFile && (!CF_ACCOUNT_ID || !CF_API_TOKEN)) {
  console.error('ERROR: CF_ACCOUNT_ID and CF_API_TOKEN must be set');
  process.exit(1);
}

const FILTER_PATH = resolve('config/land_use_filter.json');
const landUseFilter = existsSync(FILTER_PATH)
  ? JSON.parse(readFileSync(FILTER_PATH, 'utf8'))
  : null;
if (landUseFilter) {
  const excluded = Object.entries(landUseFilter)
    .filter(([key, value]) => !key.startsWith('_') && value === false)
    .length;
  console.log(`[ingest] land use filter loaded - ${excluded} codes excluded`);
} else {
  console.log('[ingest] no land use filter found - all codes allowed');
}

const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}`;
const authHeader = { Authorization: `Bearer ${CF_API_TOKEN}` };
const date = new Date().toISOString().slice(0, 10);

const CARD_UPSERT_SQL = upsertSql('parcel_cards', PARCEL_CARD_COLUMNS, 'parcel_id');
const SALE_INSERT_SQL = insertSql('parcel_sales', SALE_COLUMNS);
const IMPROVEMENT_INSERT_SQL = insertSql('parcel_improvements', IMPROVEMENT_COLUMNS);
const LAND_INSERT_SQL = insertSql('parcel_land_segments', LAND_SEGMENT_COLUMNS);

console.log(`[ingest] starting ${date}`);
if (forceFull) console.log('[ingest] FORCE_FULL_REINGEST enabled - rebuilding clean SQL import');
if (outputSqlFile) console.log(`[ingest] SQL import file mode enabled: ${outputSqlFile}`);

const parsed = await loadSourceData();
const deltas = {};
const nextManifests = [];
for (const name of Object.keys(parsed)) {
  const prevManifest = forceFull || outputSqlFile ? null : await getManifest(name);
  const { delta, manifest } = computeDelta(prevManifest, parsed[name].rows, parsed[name].headers);
  deltas[name] = delta;
  nextManifests.push({ name, manifest });
  console.log(`[ingest] ${name} delta: +${delta.added.length} ~${delta.modified.length} -${delta.deleted.length} schema_changed=${delta.schemaChanged}`);
}

const assessorIdx = indexBy(parsed.assessor?.rows ?? []);
const landIdx = groupBy(parsed.land?.rows ?? []);
const improvementsIdx = groupBy(parsed.improvements?.rows ?? []);
const salesIdx = groupBy(parsed.sales?.rows ?? []);

const dirtyIds = new Set([
  ...(deltas.assessor?.added ?? []),
  ...(deltas.assessor?.modified ?? []),
  ...(deltas.land?.added ?? []),
  ...(deltas.land?.modified ?? []),
  ...(deltas.improvements?.added ?? []),
  ...(deltas.improvements?.modified ?? []),
  ...(deltas.sales?.added ?? []),
  ...(deltas.sales?.modified ?? []),
]);
if (forceFull || deltas.assessor?.schemaChanged) {
  for (const id of Object.keys(assessorIdx)) dirtyIds.add(id);
}

const idsToWrite = [...dirtyIds].filter(shouldWriteParcel);
const deletedIds = deltas.assessor?.deleted ?? [];
console.log(`[ingest] parcels to write: ${idsToWrite.length} of ${Object.keys(assessorIdx).length} total`);

const summary = {
  date,
  force_full_reingest: forceFull,
  parcels_written: idsToWrite.length,
  parcels_deleted: deletedIds.length,
  total_in_assessor: Object.keys(assessorIdx).length,
  deltas: Object.fromEntries(
    Object.entries(deltas).map(([name, delta]) => [
      name,
      {
        added: delta.added.length,
        modified: delta.modified.length,
        deleted: delta.deleted.length,
        schema_changed: delta.schemaChanged,
      },
    ]),
  ),
};

if (outputSqlFile) {
  await writeFullImportSql(outputSqlFile, idsToWrite, nextManifests, summary);
  console.log(`[ingest] wrote SQL import file ${outputSqlFile}`);
  console.log('[ingest] done');
  process.exit(0);
}

await ensureMetadataTables();
await writeIncremental(idsToWrite, deletedIds);
await Promise.all([
  ...nextManifests.map(({ name, manifest }) => putManifest(name, manifest)),
  putRunSummary(summary),
]);
console.log('[ingest] done');

async function loadSourceData() {
  console.log('[ingest] downloading source zip...');
  const zipRes = await fetch(SOURCE);
  if (!zipRes.ok) throw new Error(`Download failed: ${zipRes.status}`);
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  console.log(`[ingest] downloaded ${(zipBuf.length / 1e6).toFixed(1)} MB`);

  const unzipped = unzipSync(new Uint8Array(zipBuf));
  const fileIndex = {};
  for (const [key, value] of Object.entries(unzipped)) {
    const base = key.split('/').pop();
    const sourceName = Object.keys(FILE_MAP).find(file => file.toLowerCase() === base.toLowerCase());
    if (sourceName) fileIndex[FILE_MAP[sourceName]] = strFromU8(value);
  }
  console.log(`[ingest] found files: ${Object.keys(fileIndex).join(', ')}`);

  const out = {};
  for (const [name, text] of Object.entries(fileIndex)) {
    out[name] = parsePSV(text, name);
    console.log(`[ingest] ${name}: ${out[name].rows.length} rows`);
  }
  return out;
}

function shouldWriteParcel(id) {
  const assessor = assessorIdx[id];
  if (!assessor) return false;
  if (toNumber(assessor['Assessed Value']) <= 0) return false;
  if (assessor.PropType === 'P') return false;
  if (landUseFilter) {
    const code = String(assessor['Land Use'] ?? '').trim();
    if (code && landUseFilter[code] === false) return false;
  }
  return true;
}

function buildParcelSet(id) {
  const card = buildCard(
    id,
    assessorIdx[id],
    landIdx[id] ?? [],
    improvementsIdx[id] ?? [],
    salesIdx[id] ?? [],
    date,
  );
  return {
    card,
    sales: buildSalesRows(id, salesIdx[id] ?? []),
    improvements: buildImprovementRows(id, improvementsIdx[id] ?? []),
    landSegments: buildLandSegmentRows(id, landIdx[id] ?? []),
  };
}

async function writeIncremental(ids, deleted) {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const data = buildParcelSet(id);
    await d1Query({ sql: CARD_UPSERT_SQL, params: rowFromObject(data.card, PARCEL_CARD_COLUMNS) });
    await replaceChildRows('parcel_sales', id, SALE_INSERT_SQL, SALE_COLUMNS, data.sales);
    await replaceChildRows('parcel_improvements', id, IMPROVEMENT_INSERT_SQL, IMPROVEMENT_COLUMNS, data.improvements);
    await replaceChildRows('parcel_land_segments', id, LAND_INSERT_SQL, LAND_SEGMENT_COLUMNS, data.landSegments);
    if ((i + 1) % 500 === 0 || i + 1 === ids.length) console.log(`[ingest] wrote ${i + 1} / ${ids.length}`);
  }

  for (const id of deleted) {
    await deleteParcel(id);
  }
}

async function replaceChildRows(table, parcelId, insert, columns, rows) {
  await d1Query({ sql: `DELETE FROM ${table} WHERE parcel_id = ?`, params: [parcelId] });
  for (const row of rows) {
    await d1Query({ sql: insert, params: rowFromObject(row, columns) });
  }
}

async function deleteParcel(id) {
  await d1Query({ sql: 'DELETE FROM parcel_cards WHERE parcel_id = ?', params: [id] });
  await d1Query({ sql: 'DELETE FROM parcel_sales WHERE parcel_id = ?', params: [id] });
  await d1Query({ sql: 'DELETE FROM parcel_improvements WHERE parcel_id = ?', params: [id] });
  await d1Query({ sql: 'DELETE FROM parcel_land_segments WHERE parcel_id = ?', params: [id] });
}

async function writeFullImportSql(path, ids, manifests, runSummary) {
  const stream = createWriteStream(path, { encoding: 'utf8' });
  await writeSchemaSql(stream);

  const cardBatch = [];
  const salesBatch = [];
  const improvementsBatch = [];
  const landBatch = [];

  for (let i = 0; i < ids.length; i++) {
    const data = buildParcelSet(ids[i]);
    await addSqlRow(stream, 'parcel_cards', PARCEL_CARD_COLUMNS, cardBatch, rowFromObject(data.card, PARCEL_CARD_COLUMNS));
    for (const sale of data.sales) await addSqlRow(stream, 'parcel_sales', SALE_COLUMNS, salesBatch, rowFromObject(sale, SALE_COLUMNS));
    for (const improvement of data.improvements) await addSqlRow(stream, 'parcel_improvements', IMPROVEMENT_COLUMNS, improvementsBatch, rowFromObject(improvement, IMPROVEMENT_COLUMNS));
    for (const land of data.landSegments) await addSqlRow(stream, 'parcel_land_segments', LAND_SEGMENT_COLUMNS, landBatch, rowFromObject(land, LAND_SEGMENT_COLUMNS));
    if ((i + 1) % 5000 === 0 || i + 1 === ids.length) console.log(`[ingest] SQL rows staged: ${i + 1} / ${ids.length}`);
  }

  await flushSqlBatch(stream, 'parcel_cards', PARCEL_CARD_COLUMNS, cardBatch);
  await flushSqlBatch(stream, 'parcel_sales', SALE_COLUMNS, salesBatch);
  await flushSqlBatch(stream, 'parcel_improvements', IMPROVEMENT_COLUMNS, improvementsBatch);
  await flushSqlBatch(stream, 'parcel_land_segments', LAND_SEGMENT_COLUMNS, landBatch);

  await writeSqlLine(stream, `DELETE FROM ingest_manifests;`);
  await writeSqlLine(stream, `INSERT OR REPLACE INTO ingest_runs (run_date, summary_json) VALUES (${sqlLiteral(date)}, ${sqlLiteral(JSON.stringify(runSummary))});`);
  await new Promise((resolve, reject) => stream.end(error => error ? reject(error) : resolve()));
}

async function writeSchemaSql(stream) {
  const schema = readFileSync(resolve('schema.sql'), 'utf8');
  for (const line of schema.split(/\r?\n/)) await writeSqlLine(stream, line);
}

async function addSqlRow(stream, table, columns, batch, values) {
  const row = `(${values.map(sqlLiteral).join(',')})`;
  const prefix = `INSERT INTO ${table} (${columns.join(',')}) VALUES `;
  const next = prefix.length + batch.join(',').length + row.length + 2;
  if (batch.length && next > 80_000) await flushSqlBatch(stream, table, columns, batch);
  batch.push(row);
}

async function flushSqlBatch(stream, table, columns, batch) {
  if (!batch.length) return;
  await writeSqlLine(stream, `INSERT INTO ${table} (${columns.join(',')}) VALUES ${batch.join(',')};`);
  batch.length = 0;
}

function sqlLiteral(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function writeSqlLine(stream, line) {
  return new Promise((resolve, reject) => stream.write(`${line}\n`, error => error ? reject(error) : resolve()));
}

function insertSql(table, columns) {
  return `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
}

function upsertSql(table, columns, pk) {
  const updates = columns
    .filter(column => column !== pk)
    .map(column => `${column}=excluded.${column}`)
    .join(',');
  return `${insertSql(table, columns)} ON CONFLICT(${pk}) DO UPDATE SET ${updates}`;
}

async function ensureMetadataTables() {
  const statements = readFileSync(resolve('schema.sql'), 'utf8')
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean)
    .filter(statement => !/^DROP TABLE/i.test(statement));
  for (const sql of statements) await d1Query({ sql, params: [] });
}

async function getManifest(name) {
  const row = await d1First('SELECT manifest_json FROM ingest_manifests WHERE name = ?', [name]);
  return row?.manifest_json ? JSON.parse(row.manifest_json) : null;
}

async function putManifest(name, manifest) {
  await d1Query({
    sql: 'INSERT OR REPLACE INTO ingest_manifests (name, updated_date, manifest_json) VALUES (?, ?, ?)',
    params: [name, date, JSON.stringify(manifest)],
  });
}

async function putRunSummary(runSummary) {
  await d1Query({
    sql: 'INSERT OR REPLACE INTO ingest_runs (run_date, summary_json) VALUES (?, ?)',
    params: [date, JSON.stringify(runSummary)],
  });
}

async function d1First(sql, params = []) {
  const result = await d1Query({ sql, params });
  return result?.[0]?.results?.[0] ?? null;
}

async function d1Query(statement) {
  const res = await fetch(`${CF_BASE}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(statement),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`D1 query failed: ${JSON.stringify(data.errors ?? data)}`);
  return data.result;
}

function toNumber(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}
