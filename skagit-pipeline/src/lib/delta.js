// Stores lightweight manifests in R2 (just id→hash) instead of full files
// so we don't need to hold two copies of 80k rows in memory

export function computeDelta(prevManifest, currRows, currHeaders) {
  const prev = prevManifest ?? {};
  const schemaChanged = prev._headers
    ? JSON.stringify(prev._headers) !== JSON.stringify(currHeaders)
    : false;

  const added = [], modified = [], deleted = [];
  const currManifest = { _headers: currHeaders };

  for (const row of currRows) {
    const hash = simpleHash(JSON.stringify(row));
    currManifest[row._id] = hash;
    if (!prev[row._id])            added.push(row._id);
    else if (prev[row._id] !== hash) modified.push(row._id);
  }
  const currIds = new Set(currRows.map(r => r._id));
  for (const k of Object.keys(prev)) {
    if (k !== '_headers' && !currIds.has(k)) deleted.push(k);
  }

  return { delta: { schemaChanged, added, modified, deleted }, manifest: currManifest };
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return h.toString(36);
}
