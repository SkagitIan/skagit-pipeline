import { runIngest } from './ingest.js';
export async function handleRequest(req, env, ctx) {
  const url  = new URL(req.url);
  const path = url.pathname;

  // CORS
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  // GET /parcel/:id
  if (path.startsWith('/parcel/')) {
    const id  = path.split('/')[2].replace(/[\s\-]/g, '');
    const row = await env.PARCEL_DB.prepare(
      'SELECT * FROM parcel_cards WHERE parcel_id = ?'
    ).bind(id).first();
    if (!row) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
    return new Response(JSON.stringify(row), { headers });
  }

  // GET /parcels?zoning=R1&min_value=200000&max_value=600000&year_built_after=1990
  //             &min_acres=0.5&bbox=minLon,minLat,maxLon,maxLat&limit=500&offset=0
  if (path === '/parcels') {
    const p = url.searchParams;
    const conditions = [], bindings = [];

    const add = (clause, ...vals) => { conditions.push(clause); bindings.push(...vals); };

    if (p.get('zoning'))            add('zoning = ?',                p.get('zoning'));
    if (p.get('land_use_code'))     add('land_use_code LIKE ?',      landUsePattern(p.get('land_use_code')));
    if (p.get('min_value'))         add('assessed_value >= ?',       +p.get('min_value'));
    if (p.get('max_value'))         add('assessed_value <= ?',       +p.get('max_value'));
    if (p.get('year_built_after'))  add('year_built >= ?',           +p.get('year_built_after'));
    if (p.get('year_built_before')) add('year_built <= ?',           +p.get('year_built_before'));
    if (p.get('min_sqft'))          add('sq_ft >= ?',                +p.get('min_sqft'));
    if (p.get('min_acres'))         add('acres >= ?',                +p.get('min_acres'));
    if (p.get('bedrooms'))          add('bedrooms = ?',              +p.get('bedrooms'));

    if (p.get('bbox')) {
      const [x1, y1, x2, y2] = p.get('bbox').split(',').map(Number);
      add('longitude BETWEEN ? AND ?', x1, x2);
      add('latitude  BETWEEN ? AND ?', y1, y2);
    }

    const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit  = Math.min(+(p.get('limit')  ?? 500), 2000);
    const offset = +(p.get('offset') ?? 0);

    const [rows, count] = await Promise.all([
      env.PARCEL_DB.prepare(`SELECT * FROM parcel_cards ${where} LIMIT ? OFFSET ?`)
        .bind(...bindings, limit, offset).all(),
      env.PARCEL_DB.prepare(`SELECT COUNT(*) as n FROM parcel_cards ${where}`)
        .bind(...bindings).first(),
    ]);

    return new Response(JSON.stringify({
      total: count?.n ?? 0,
      limit, offset,
      results: rows.results,
    }), { headers });
  }

  // GET /health
  if (path === '/health') {
    const n = await env.PARCEL_DB.prepare('SELECT COUNT(*) as n FROM parcel_cards').first();
    return new Response(JSON.stringify({ ok: true, parcel_count: n?.n }), { headers });
  }
  // Temporary manual trigger — remove after first successful remote ingest
  if (path === '/admin/ingest') {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
    }
    if (!(await isAuthorizedAdmin(req, env))) {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers });
    }
    ctx.waitUntil(runIngest(env));
    return new Response(JSON.stringify({ ok: true, message: 'ingest started, watch wrangler tail' }), { headers });
  }
  // POST /ask  — natural language → SQL → answer
  if (path === '/ask' && req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400, headers }); }
    const question = (body?.question ?? '').trim();
    if (!question) return new Response(JSON.stringify({ error: 'missing question' }), { status: 400, headers });

    const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
    const MODEL = 'claude-sonnet-4-20250514';

    const systemPrompt = `You are a SQL expert helping query a Skagit County parcel database (SQLite / Cloudflare D1).

SCHEMA:
CREATE TABLE parcel_cards (
  parcel_id             TEXT PRIMARY KEY,
  updated_date          TEXT,
  assessed_value        INTEGER,
  land_value            INTEGER,
  improvement_value     INTEGER,
  year_built            INTEGER,
  sq_ft                 INTEGER,
  bedrooms              INTEGER,
  bathrooms             REAL,
  land_use_code         TEXT,
  zoning                TEXT,
  acres                 REAL,
  improvements          TEXT,  -- JSON array of improvement segments
  sales_history         TEXT,  -- JSON array of sales records
  latitude              REAL,
  longitude             REAL,
  geometry              TEXT,  -- GeoJSON polygon
  absentee_owner        INTEGER,  -- 1 = owner mailing address is out-of-state (motivated seller signal)
  days_since_last_sale  INTEGER,
  raw_json              TEXT   -- full denormalized snapshot
);

DATA FORMAT — CRITICAL:
- ALL text values in this database are UPPERCASE. Always write string literals in UPPERCASE.
- Never search for "Sedro-Woolley" — it is stored as "SEDRO WOOLLEY" (no hyphen, no mixed case).
- Street names use USPS abbreviations: DR (not DRIVE), ST (not STREET), AVE (not AVENUE),
  RD (not ROAD), LN (not LANE), CT (not COURT), WAY, BLVD, PL, etc.
  Example: "CULTUS MOUNTAIN DR" not "CULTUS MOUNTAIN DRIVE"
- City names never contain hyphens: "SEDRO WOOLLEY", "MOUNT VERNON", "BURLINGTON", etc.

FIELD NOTES:
- land_use_code: stores full descriptive strings with a numeric code prefix.
  Actual stored examples:
    "(111) HOUSEHOLD, SFR, INSIDE CITY"    → single family residential
    "(910) RECREATIONAL LOTS"              → recreational/vacant lots
    "(910) VACANT LAND"                    → vacant land
  ALWAYS filter with LIKE, e.g.: land_use_code LIKE '%(111)%'
  NEVER use land_use_code = '111' — exact equality will return zero rows.

- absentee_owner=1 means owner mailing address is out of state — strong motivated-seller signal

- days_since_last_sale: values 5000+ mean property hasn't sold in decades.
  To convert years to days, multiply by 365 (e.g., 20 years = 7300 days).

- improvement_value=0 OR improvement_value IS NULL means vacant/unimproved land.
  Always check BOTH conditions for vacant land queries.

- assessed_value is county assessed value in whole dollars.

- raw_json structure: a JSON object with exactly these top-level keys:
    "assessor"     — object: the full row from AssessorData.txt (PSV headers as keys)
    "land"         — object: the row from Land.txt for this parcel
    "improvements" — array of improvement segment objects
    "sales"        — array of sale record objects

  Key fields inside raw_json.assessor (PSV column names, exact case):
    "Situs Street Number"  — e.g. "813"
    "Situs Street Name"    — e.g. "CULTUS MOUNTAIN DR"  (ALL CAPS, USPS abbreviated)
    "Situs City State Zip" — e.g. "SEDRO WOOLLEY, WA 98284"  (no hyphen in city name)
    "Owner Name"           — e.g. "YOUNG KATHERINE"
    "Owner City"           — e.g. "MARBLEMOUNT"
    "Owner State"          — e.g. "WA"  (absentee_owner=1 when not "WA")
    "Land Use"             — same value as land_use_code column
    "Building Value"       — building improvement value (string)
    "Assessed Value"       — total assessed value (string)
    "Acres"                — parcel acreage (string)
    "Year Built"           — year built (string)
    "Living Area"          — sq ft (string)
    "Number of Bedrooms"   — bedrooms (string)
    "Neighborhood Code"    — e.g. "(20SWNTOWN) SEDRO WOOLLEY RESIDENTIAL NORTH TOWN"
    "City District"        — e.g. "Sedro Woolley"
    "School District"      — e.g. "SD101"
    "PropType"             — "R"=residential, "C"=commercial, "P"=personal property
    "Sale Date"            — most recent sale date (string, may be empty)
    "Sale Price"           — most recent sale price (string)
    "Legal Description"    — full legal description text

- For address searches, always use raw_json LIKE on the whole blob — it is simpler and reliable:
    raw_json LIKE '%CULTUS MOUNTAIN DR%'
  NEVER search for unabbreviated street types — the data always uses USPS abbreviations.
  NEVER include a hyphen in city names — "SEDRO WOOLLEY" not "SEDRO-WOOLLEY".

- sales_history is a JSON array of sale objects. Each sale has:
    "sale date", "sale price", "sale type", "buyer name", "seller name", "Deed Type"
  Use json_each(sales_history) to query inside it.

- improvements is a JSON array of building segments.
  Use json_each(improvements) or json_extract() to inspect.

SQLITE RULES (this is NOT PostgreSQL):
- Use SQLite syntax only
- To query inside JSON arrays use json_each() or json_extract()
- You MAY use LIKE on plain TEXT columns (land_use_code, zoning, raw_json, etc.)
- Always include LIMIT, maximum 200
- Only SELECT statements are allowed — no INSERT, UPDATE, DELETE, DROP, CREATE, or any DDL/DML

COMMON INVESTOR QUERIES:
- absentee_owner=1 (out-of-state owner)
- days_since_last_sale > 7300 (hasn't sold in 20+ years)
- improvement_value=0 OR improvement_value IS NULL (vacant land)
- land_use_code LIKE '%(910)%' (recreational/vacant lots)
- low assessed_value relative to acres (value per acre)

Return ONLY a JSON object with exactly two keys: "sql" and "reasoning".
Example: {"sql": "SELECT parcel_id, assessed_value FROM parcel_cards WHERE absentee_owner=1 LIMIT 10", "reasoning": "Filtering for out-of-state owners as a motivated seller signal."}
Do not include markdown, code fences, or any text outside the JSON object.`;

    // Step 1: generate SQL
    let sql, reasoning;
    try {
      const sqlRes = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: question }],
        }),
      });
      if (!sqlRes.ok) {
        const err = await sqlRes.text();
        return new Response(JSON.stringify({ error: 'Anthropic API error (sql gen)', detail: err }), { status: 502, headers });
      }
      const sqlData = await sqlRes.json();
      const rawText = sqlData.content?.[0]?.text ?? '';
      // Strip any accidental markdown fences
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      sql = parsed.sql;
      reasoning = parsed.reasoning;
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Failed to generate SQL', detail: String(e) }), { status: 500, headers });
    }

    // Guard: only allow SELECT
    if (!/^\s*SELECT\b/i.test(sql)) {
      return new Response(JSON.stringify({ error: 'Generated SQL is not a SELECT statement', sql }), { status: 400, headers });
    }

    // Step 2: run the SQL against D1
    let results, row_count;
    try {
      const dbRes = await env.PARCEL_DB.prepare(sql).all();
      results = dbRes.results ?? [];
      row_count = results.length;
    } catch (e) {
      return new Response(JSON.stringify({
        error: 'SQL execution failed',
        detail: String(e),
        sql,
        reasoning,
      }), { status: 400, headers });
    }

    // Step 3: natural language answer over results
    let answer;
    try {
      const summaryPrompt = `The user asked: "${question}"

The SQL that was run:
${sql}

It returned ${row_count} rows. Here is a sample (up to 20 rows):
${JSON.stringify(results.slice(0, 20), null, 2)}

Write a concise, investor-focused answer summarizing what was found. Mention counts, notable values, and any patterns. Be direct and practical. 3-5 sentences max.`;

      const answerRes = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 512,
          messages: [{ role: 'user', content: summaryPrompt }],
        }),
      });
      if (!answerRes.ok) {
        answer = '(Could not generate summary — Anthropic API error on second call)';
      } else {
        const answerData = await answerRes.json();
        answer = answerData.content?.[0]?.text ?? '(no answer returned)';
      }
    } catch (e) {
      answer = `(Summary generation failed: ${String(e)})`;
    }

    return new Response(JSON.stringify({ question, sql, reasoning, row_count, answer, results }), { headers });
  }

  return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
}

function landUsePattern(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (!v) return '%';
  const numeric = v.match(/^\(?(\d{3})\)?$/);
  return numeric ? `%(${numeric[1]})%` : `%${v}%`;
}

async function isAuthorizedAdmin(req, env) {
  const expected = env.ADMIN_INGEST_TOKEN;
  const supplied = req.headers.get('X-Admin-Token') ?? '';
  if (!expected || !supplied) return false;

  const encoder = new TextEncoder();
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
  ]);

  const a = new Uint8Array(expectedHash);
  const b = new Uint8Array(suppliedHash);
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
