export async function handleRequest(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  if (path.startsWith('/parcel/')) {
    const id = path.split('/')[2].replace(/[\s\-]/g, '');
    const card = await env.PARCEL_DB.prepare('SELECT * FROM parcel_cards WHERE parcel_id = ?').bind(id).first();
    if (!card) return json({ error: 'not found' }, { status: 404, headers });
    const [sales, improvements, land] = await Promise.all([
      env.PARCEL_DB.prepare('SELECT * FROM parcel_sales WHERE parcel_id = ? ORDER BY sale_date DESC').bind(id).all(),
      env.PARCEL_DB.prepare('SELECT * FROM parcel_improvements WHERE parcel_id = ? ORDER BY segment_id').bind(id).all(),
      env.PARCEL_DB.prepare('SELECT * FROM parcel_land_segments WHERE parcel_id = ? ORDER BY id').bind(id).all(),
    ]);
    return json({
      ...card,
      sales: sales.results ?? [],
      improvements: improvements.results ?? [],
      land_segments: land.results ?? [],
    }, { headers });
  }

  if (path === '/parcels') {
    const p = url.searchParams;
    const conditions = [];
    const bindings = [];
    const add = (clause, ...vals) => { conditions.push(clause); bindings.push(...vals); };

    if (p.get('zoning')) add('zoning = ?', p.get('zoning'));
    if (p.get('land_use_code')) add('land_use_code = ?', landUseCode(p.get('land_use_code')));
    if (p.get('situs_city')) add('situs_city = ?', norm(p.get('situs_city')));
    if (p.get('city')) add('situs_city = ?', norm(p.get('city')));
    if (p.get('street')) add('situs_street_name = ?', norm(p.get('street')));
    if (p.get('owner_state')) add('owner_state = ?', norm(p.get('owner_state')));
    if (p.get('absentee_owner')) add('absentee_owner = ?', +p.get('absentee_owner'));
    if (p.get('min_value')) add('assessed_value >= ?', +p.get('min_value'));
    if (p.get('max_value')) add('assessed_value <= ?', +p.get('max_value'));
    if (p.get('year_built_after')) add('year_built >= ?', +p.get('year_built_after'));
    if (p.get('year_built_before')) add('year_built <= ?', +p.get('year_built_before'));
    if (p.get('min_sqft')) add('sq_ft >= ?', +p.get('min_sqft'));
    if (p.get('min_acres')) add('acres >= ?', +p.get('min_acres'));
    if (p.get('bedrooms')) add('bedrooms = ?', +p.get('bedrooms'));
    if (p.get('is_vacant')) add('is_vacant = ?', +p.get('is_vacant'));
    if (p.get('is_sfr')) add('is_sfr = ?', +p.get('is_sfr'));

    if (p.get('bbox')) {
      const [x1, y1, x2, y2] = p.get('bbox').split(',').map(Number);
      add('longitude BETWEEN ? AND ?', x1, x2);
      add('latitude BETWEEN ? AND ?', y1, y2);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(+(p.get('limit') ?? 500), 2000);
    const offset = +(p.get('offset') ?? 0);
    const [rows, count] = await Promise.all([
      env.PARCEL_DB.prepare(`SELECT * FROM parcel_cards ${where} ORDER BY assessed_value DESC LIMIT ? OFFSET ?`)
        .bind(...bindings, limit, offset).all(),
      env.PARCEL_DB.prepare(`SELECT COUNT(*) as n FROM parcel_cards ${where}`).bind(...bindings).first(),
    ]);
    return json({ total: count?.n ?? 0, limit, offset, results: rows.results ?? [] }, { headers });
  }

  if (path === '/health') {
    const n = await env.PARCEL_DB.prepare('SELECT COUNT(*) as n FROM parcel_cards').first();
    return json({ ok: true, parcel_count: n?.n }, { headers });
  }

  if (path === '/admin/ingest') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, { status: 405, headers });
    return json({
      error: 'admin ingest disabled',
      message: 'Use the GitHub Actions ingest workflow. Worker-side ingest is disabled for the normalized schema.',
    }, { status: 410, headers });
  }

  if (path === '/ask' && req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, { status: 400, headers }); }
    const question = (body?.question ?? '').trim();
    if (!question) return json({ error: 'missing question' }, { status: 400, headers });

    const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
    const MODEL = 'claude-sonnet-4-20250514';
    const systemPrompt = `You are a SQL expert helping query a normalized Skagit County parcel database in SQLite / Cloudflare D1.

Use only SELECT statements. Always include LIMIT, maximum 200. Return ONLY JSON with "sql" and "reasoning".

Main table parcel_cards columns include:
parcel_id, account_number, situs_street_number, situs_street_name, situs_city, situs_state, situs_zip,
owner_name, owner_city, owner_state, owner_zip, absentee_owner,
land_use_code, land_use_description, assessed_value, taxable_value, market_value, building_value,
land_value, acres, sq_ft, bedrooms, bathrooms, garage_sq_ft, year_built, effective_year_built,
sale_date, sale_price, sale_type, sale_deed_type, days_since_last_sale,
last_valid_sale_date, last_valid_sale_price, value_per_acre, improvement_ratio,
is_vacant, is_sfr, is_recreational_land, distressed_transfer_recent,
latitude, longitude, geometry, raw_r2_key.

Child tables:
parcel_sales(parcel_id, sale_date, sale_price, sale_type, deed_type, seller_name, buyer_name, recording_number)
parcel_improvements(parcel_id, improvement_type, improvement_class, condition_code, calc_area, value, actual_year_built, effective_year_built, sketch_url)
parcel_land_segments(parcel_id, land_type, acres, square_feet, market_value)

Data rules:
- Text values are UPPERCASE. Use UPPERCASE literals.
- City names have no hyphens: SEDRO WOOLLEY, not SEDRO-WOOLLEY.
- Street names use USPS abbreviations: DR, ST, AVE, RD, LN, CT, BLVD.
- land_use_code is normalized to a numeric string such as '111' or '910'. Use equality: land_use_code = '111'.
- land_use_description contains text such as HOUSEHOLD, SFR, INSIDE CITY.
- Address searches use situs_street_name and situs_city. Do not use raw_json.
- Vacant land: is_vacant = 1.
- SFR: is_sfr = 1 or land_use_code = '111'.
- Recreational/vacant lots: is_recreational_land = 1 or land_use_code = '910'.
- Out-of-state owner: absentee_owner = 1.
- 20 years since sale means days_since_last_sale > 7300.

Example: {"sql": "SELECT parcel_id, assessed_value, situs_city FROM parcel_cards WHERE is_sfr=1 AND situs_city='SEDRO WOOLLEY' LIMIT 10", "reasoning": "Filters normalized SFR and city columns."}`;

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
      if (!sqlRes.ok) return json({ error: 'Anthropic API error (sql gen)', detail: await sqlRes.text() }, { status: 502, headers });
      const rawText = (await sqlRes.json()).content?.[0]?.text ?? '';
      const parsed = JSON.parse(rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
      sql = parsed.sql;
      reasoning = parsed.reasoning;
    } catch (e) {
      return json({ error: 'Failed to generate SQL', detail: String(e) }, { status: 500, headers });
    }

    if (!/^\s*SELECT\b/i.test(sql)) return json({ error: 'Generated SQL is not a SELECT statement', sql }, { status: 400, headers });

    let results, row_count;
    try {
      const dbRes = await env.PARCEL_DB.prepare(sql).all();
      results = dbRes.results ?? [];
      row_count = results.length;
    } catch (e) {
      return json({ error: 'SQL execution failed', detail: String(e), sql, reasoning }, { status: 400, headers });
    }

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
        body: JSON.stringify({ model: MODEL, max_tokens: 512, messages: [{ role: 'user', content: summaryPrompt }] }),
      });
      answer = answerRes.ok ? (await answerRes.json()).content?.[0]?.text ?? '(no answer returned)' : '(Could not generate summary)';
    } catch (e) {
      answer = `(Summary generation failed: ${String(e)})`;
    }

    return json({ question, sql, reasoning, row_count, answer, results }, { headers });
  }

  return json({ error: 'not found' }, { status: 404, headers });
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), init);
}

function landUseCode(value) {
  const v = String(value ?? '').trim().toUpperCase();
  const numeric = v.match(/^\(?(\d{3})\)?$/);
  return numeric ? numeric[1] : v;
}

function norm(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}
