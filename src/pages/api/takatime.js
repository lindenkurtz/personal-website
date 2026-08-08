/**
 * Live coding-stats API.
 *
 *   GET /api/takatime?range=week|month|year|alltime   (default: alltime)
 *
 * All numbers come from `src/lib/takatime-stats.mjs`, which derives durations
 * with the tracker's canonical algorithm. This route computes nothing itself and
 * must never sum the legacy `duration` field. See CLAUDE.md § "Coding-stats data
 * contract".
 *
 * HEADS UP: this route cannot run on the deployed Cloudflare Worker — the mongodb
 * driver needs Node TCP/TLS/DNS that Workers does not provide. It works under
 * `astro dev` and any Node deploy target. The production chart does not depend on
 * it; it reads the static `public/coding-stats.json` built by
 * `scripts/generate-stats.mjs` in GitHub Actions. See `src/lib/mongo.mjs`.
 */

export const prerender = false;

import { getLogsCollection } from '../../lib/mongo.mjs';
import { RANGES, getStats } from '../../lib/takatime-stats.mjs';

export async function GET({ request }) {
  try {
    const uri = import.meta.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI is not defined');

    const requested = new URL(request.url).searchParams.get('range') ?? 'alltime';
    if (!RANGES.includes(requested)) {
      return json({ error: `Invalid range "${requested}". Expected one of: ${RANGES.join(', ')}` }, 400);
    }

    const collection = await getLogsCollection(uri);
    const stats = await getStats(collection, requested);

    // The client is pooled and intentionally left open for reuse across requests.
    return json({ data: stats });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
