import { runGeoEnrich }  from './lib/geo.js';
import { handleRequest } from './lib/api.js';

export default {
  // HTTP API — all query endpoints + /admin/ingest emergency fallback
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') {
      const assetUrl = new URL('/index.html', req.url);
      return env.ASSETS.fetch(new Request(assetUrl, req));
    }

    return handleRequest(req, env, ctx);
  },

  // Cron triggers
  // Note: ingest runs in GitHub Actions (scripts/ingest-node.js), NOT here.
  async scheduled(event, env, ctx) {
    if (event.cron === '30 11 * * *') {
      ctx.waitUntil(runGeoEnrich(env));  // backfill lat/lon for new parcels
    }
  },
};
