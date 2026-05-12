// Worker-side ingest is intentionally disabled for the normalized schema.
// Use scripts/ingest-node.js from GitHub Actions so full repairs can use D1 SQL import.

export async function runIngest() {
  throw new Error('Worker-side ingest is disabled. Use the GitHub Actions ingest workflow.');
}
