#!/usr/bin/env node
/**
 * One-time utility — generates config/land_use_filter.json from live source data.
 *
 * Run this whenever you want to refresh the list of known land use codes:
 *   node scripts/generate-land-use-filter.js
 *
 * Then open config/land_use_filter.json, set any codes you DON'T want to false,
 * and commit. The ingest script reads this file and skips excluded codes.
 *
 * No env vars required — only downloads the public assessor ZIP.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE      = 'https://www.skagitcounty.net/Assessor/Documents/DataDownloads/SkagitAssessmentData.zip';
const OUTPUT_PATH = resolve('config/land_use_filter.json');

console.log('[generate-filter] downloading assessor zip…');
const zipRes = await fetch(SOURCE);
if (!zipRes.ok) { console.error(`Download failed: ${zipRes.status}`); process.exit(1); }
const zipBuf = Buffer.from(await zipRes.arrayBuffer());
console.log(`[generate-filter] downloaded ${(zipBuf.length / 1e6).toFixed(1)} MB`);

// Unzip and find AssessorData.txt
const unzipped = unzipSync(new Uint8Array(zipBuf));
let assessorText = null;
for (const [k, v] of Object.entries(unzipped)) {
  if (k.split('/').pop().toLowerCase() === 'assessordata.txt') {
    assessorText = strFromU8(v);
    break;
  }
}
if (!assessorText) { console.error('AssessorData.txt not found in zip'); process.exit(1); }

// Parse PSV header to find Land Use column index
const lines   = assessorText.split('\n');
const headers = lines[0].split('|').map(h => h.trim());
const luIdx   = headers.indexOf('Land Use');
const ptIdx   = headers.indexOf('PropType');

if (luIdx === -1) { console.error('Land Use column not found'); process.exit(1); }

// Collect unique codes (and PropType values for reference)
const landUseCodes = new Set();
const propTypes    = new Set();

for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split('|');
  const lu   = cols[luIdx]?.trim();
  const pt   = cols[ptIdx]?.trim();
  if (lu) landUseCodes.add(lu);
  if (pt) propTypes.add(pt);
}

console.log(`[generate-filter] found ${landUseCodes.size} unique land use codes`);
console.log(`[generate-filter] found PropTypes: ${[...propTypes].sort().join(', ')}`);

// Load existing filter so we don't reset user's false-entries
let existing = {};
if (existsSync(OUTPUT_PATH)) {
  try {
    existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
    console.log('[generate-filter] merging with existing filter (preserving your false entries)');
  } catch { /* ignore */ }
}

// Build merged filter — preserve existing false entries, add new codes as true
const sorted = [...landUseCodes].sort();
const filter = {};

// Header comment fields (underscore prefix — ignored by ingest)
filter['_instructions'] = 'Set a code to false (or delete the line) to exclude those parcels from ingest. Run generate-land-use-filter.js to refresh this list.';
filter['_prop_types_found'] = [...propTypes].sort().join(', ');

for (const code of sorted) {
  // Preserve existing value if set, otherwise default true
  filter[code] = existing[code] === false ? false : true;
}

// Make config/ dir if needed
import { mkdirSync } from 'node:fs';
mkdirSync('config', { recursive: true });

writeFileSync(OUTPUT_PATH, JSON.stringify(filter, null, 2));
console.log(`[generate-filter] written to ${OUTPUT_PATH}`);
console.log('[generate-filter] open that file and set unwanted codes to false, then commit.');
