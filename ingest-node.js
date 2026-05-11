// scripts/ingest-node.js
// Runs in GitHub Actions (7GB RAM, no timeout).
// Downloads Skagit zip, parses 4 PSV files, writes parcel cards to D1 via REST API.

import { unzipSync, strFromU8 } from 'fflate';

const SOURCE       = 'https://www.skagitcounty.net/Assessor/Documents/DataDownloads/SkagitAssessmentData.zip';
const CF_ACCOUNT   = process.env.CF_ACCOUNT_ID;
const CF_TOKEN     = process.env.CF_API_TOKEN;
const DB_ID        = process.env.D1_DATABASE_ID;
const DATE         = new Date().toISOString().slice(0, 10);
const D1_URL       = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${DB_ID}/query`;

// Map zip filenames → internal names (case-insensitive match)
const FILE_MAP = {
  'AssessorData.txt': 'assessor',
  'Improvements.txt': 'improvements',
  'Land.txt':         'land',
  'Sales.txt':        'sales',
};

// Parcel key field name per file
const PARCEL_KEY = {
  assessor:     'Parcel Number',
  sales:        'Parcel Number',
  improvements: 'ParcelNumber',
  land:         'ParcelNumber',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeId(raw) {
  return raw?.replace(/[\s\-]/g, '').trim() || null;
}

function parsePSV(text, name) {
  const lines = text.split('\n');
  const headers = lines[0].split('|').map(h => h.trim());
  const keyField = PARCEL_KEY[name];
  return lines.slice(1).filter(Boolean).map(l => {
    const vals = l.split('|');
    const row = Object.fromEntries(headers.map((h, i) => [h, vals[i]?.trim() ?? '']));
    row._id = normalizeId(row[keyField]);
    return row;
  }).filter(r => r._id);
}

function indexBy(rows)  { return Object.fromEntries(rows.map(r => [r._id, r])); }
function groupBy(rows)  { return rows.reduce((a, r) => { (a[r._id] ??= []).push(r); return a; }, {}); }

const num = v => (v != null && v !== '') ? (+v || null) : null;

function esc(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return isNaN(v) ? 'NULL' : String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function buildInsert(id, a, l, imps, sales) {
  // Derive absentee owner flag: mailing address differs from situs state/city
  const mailingState = a?.['Mailing State'] ?? a?.MailingState ?? '';
  const absentee = mailingState && mailingState.trim().toUpperCase() !== 'WA' ? 1 : 0;

  // Days since last sale
  const lastSaleDate = sales?.[0]?.['Sale Date'] ?? sales?.[0]?.SaleDate ?? null;
  const daysSinceLastSale = lastSaleDate
    ? Math.floor((Date.now() - new Date(lastSaleDate).getTime()) / 86400000)
    : null;

  const vals = [
    esc(id),
    esc(DATE),
    esc(num(a?.['Total Value']      ?? a?.TotalValue)),
    esc(num(a?.['Land Value']       ?? a?.LandValue)),
    esc(num(a?.['Impr Value']       ?? a?.ImprValue)),
    esc(num(a?.['Year Built']       ?? a?.YearBuilt)),
    esc(num(a?.['Sq Ft Lot']        ?? a?.SqFtLot ?? a?.SquareFeet)),
    esc(num(a?.Bedrooms)),
    esc(num(a?.Bathrooms)),
    esc(l?.['Land Use Code']        ?? l?.LandUseCode ?? null),
    esc(l?.Zoning                   ?? null),
    esc(num(l?.Acres)),
    esc(JSON.stringify(imps)),
    esc(JSON.stringify(sales)),
    'NULL', 'NULL', 'NULL',          // latitude, longitude, geometry — filled by geo worker
    esc(absentee),
    esc(daysSinceLastSale),
    esc(JSON.stringify({ assessor: a, land: l, improvements: imps, sales })),
  ].join(',');

  return `INSERT OR REPLACE INTO parcel_cards VALUES (${vals})`;
}

// ── D1 REST API ───────────────────────────────────────────────────────────────

async function d1Batch(statements) {
  const res = await fetch(D1_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(statements.map(sql => ({ sql }))),
  });
  const data = await res.json();
  if (!data.success) {
    console.error('D1 batch error:', JSON.stringify(data.errors));
    throw new Error(`D1 batch failed: ${data.errors?.[0]?.message}`);
  }
  return data;
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (!CF_ACCOUNT || !CF_TOKEN || !DB_ID) {
  console.error('Missing env: CF_ACCOUNT_ID, CF_API_TOKEN, D1_DATABASE_ID');
  process.exit(1);
}

console.log(`[ingest] ${DATE} — downloading...`);
const buf = await fetch(SOURCE).then(r => {
  if (!r.ok) throw new Error(`Download failed: ${r.status}`);
  return r.arrayBuffer();
});
console.log(`[ingest] downloaded ${(buf.byteLength / 1e6).toFixed(1)}MB`);

const unzipped = unzipSync(new Uint8Array(buf));
const files = {};
for (const [k, v] of Object.entries(unzipped)) {
  const base = k.split('/').pop();
  const name = Object.keys(FILE_MAP).find(f => f.toLowerCase() === base.toLowerCase());
  if (name) files[FILE_MAP[name]] = strFromU8(v);
}
console.log('[ingest] files:', Object.keys(files).join(', '));

if (!files.assessor) {
  console.error('[ingest] FATAL: assessor file not found. Check FILE_MAP filenames.');
  console.error('[ingest] Found:', Object.keys(unzipped).map(k => k.split('/').pop()).join(', '));
  process.exit(1);
}

const assessorRows     = parsePSV(files.assessor,     'assessor');
const landRows         = parsePSV(files.land,         'land');
const improvementRows  = parsePSV(files.improvements, 'improvements');
const salesRows        = parsePSV(files.sales,        'sales');

const assessorIdx  = indexBy(assessorRows);
const landIdx      = indexBy(landRows);
const impsIdx      = groupBy(improvementRows);
const salesIdx     = groupBy(salesRows);

const ids = Object.keys(assessorIdx);
console.log(`[ingest] ${ids.length} parcels, ${improvementRows.length} improvements, ${salesRows.length} sales`);

const BATCH = 50;
let written = 0;
let errors  = 0;

for (let i = 0; i < ids.length; i += BATCH) {
  const chunk = ids.slice(i, i + BATCH);
  const stmts = chunk.map(id =>
    buildInsert(id, assessorIdx[id], landIdx[id], impsIdx[id] ?? [], salesIdx[id] ?? [])
  );
  try {
    await d1Batch(stmts);
    written += chunk.length;
  } catch (e) {
    console.error(`[ingest] batch error at ${i}:`, e.message);
    errors++;
    if (errors > 10) { console.error('[ingest] too many errors, aborting'); process.exit(1); }
  }
  if (written % 5000 === 0) console.log(`[ingest] ${written} / ${ids.length}`);
}

console.log(`[ingest] ✓ wrote ${written} parcel cards (${errors} batch errors)`);
