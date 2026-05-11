import { runIngest }     from './lib/ingest.js';
import { runGeoEnrich }  from './lib/geo.js';
import { handleRequest } from './lib/api.js';

export default {
  // HTTP API
  async fetch(req, env) {
    return handleRequest(req, env);
  },

  // Cron triggers
  async scheduled(event, env, ctx) {
    if (event.cron === '0 10 * * *') {
      ctx.waitUntil(runIngest(env));
    }
    if (event.cron === '30 11 * * *') {
      ctx.waitUntil(runGeoEnrich(env));
    }
  },
};
