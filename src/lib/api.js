import { runIngest } from './ingest.js';
export async function handleRequest(req, env, ctx) {
  const url  = new URL(req.url);
  const path = url.pathname;

  // CORS
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

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
    if (p.get('land_use_code'))     add('land_use_code = ?',         p.get('land_use_code'));
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
    ctx.waitUntil(runIngest(env));
    return new Response(JSON.stringify({ ok: true, message: 'ingest started, watch wrangler tail' }), { headers });
  }
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
}
