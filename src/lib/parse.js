// Parcel key field differs across files
export const PARCEL_KEY = {
  assessor:     'Parcel Number',
  sales:        'Parcel Number',
  improvements: 'ParcelNumber',
  land:         'ParcelNumber',
};

export function parsePSV(text, name) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split('|').map(h => h.trim());
  const keyField = PARCEL_KEY[name];
  const rows = lines.slice(1).map(l => {
    const vals = l.split('|');
    const row = Object.fromEntries(headers.map((h, i) => [h, vals[i]?.trim() ?? '']));
    row._id = normalizeId(row[keyField]);
    return row;
  }).filter(r => r._id);
  return { headers, rows };
}

// Strip spaces and dashes so "4182-053-085" === "4182053085"
export function normalizeId(raw) {
  return raw?.replace(/[\s\-]/g, '').trim() || null;
}

export function indexBy(rows)  { return Object.fromEntries(rows.map(r => [r._id, r])); }
export function groupBy(rows)  { return rows.reduce((a, r) => { (a[r._id] ??= []).push(r); return a; }, {}); }
