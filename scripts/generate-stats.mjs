/**
 * Regenerate `public/coding-stats.json` from MongoDB.
 *
 * Run by `.github/workflows/update-stats.yml` every 6 hours, on Node — which is
 * why this, and not the SSR API route, is what actually feeds the live chart.
 *
 *   MONGO_URI=... node scripts/generate-stats.mjs
 *
 * Every number here comes from `src/lib/takatime-stats.mjs`, the same module the
 * API route uses. This script derives nothing on its own and must never sum the
 * legacy `duration` field. See CLAUDE.md § "Coding-stats data contract".
 */

import { writeFileSync } from 'node:fs';

import { closeClient, getLogsCollection } from '../src/lib/mongo.mjs';
import { ALGORITHM_VERSION, getStats } from '../src/lib/takatime-stats.mjs';

const OUT = 'public/coding-stats.json';

const collection = await getLogsCollection(process.env.MONGO_URI);

const [week, alltime] = await Promise.all([
  getStats(collection, 'week'),
  getStats(collection, 'alltime'),
]);

await closeClient();

// `week` and `alltime` stay top-level arrays of `{ name, percent, ... }` so the
// existing chart keeps working untouched; `seconds`/`formatted` ride along, and
// everything non-chart lives under `meta`.
writeFileSync(
  OUT,
  JSON.stringify(
    {
      week: week.languages,
      alltime: alltime.languages,
      meta: {
        algorithmVersion: ALGORITHM_VERSION,
        generatedAt: new Date().toISOString(),
        week: summaryOf(week),
        alltime: summaryOf(alltime),
      },
    },
    null,
    2,
  ) + '\n',
);

// `totalMs` is carried through because it is the only exact figure — the
// per-language `ms` values sum to it precisely, `totalSeconds` is a rounding.
function summaryOf({ totalMs, totalSeconds, totalFormatted, days, meta }) {
  return { totalMs, totalSeconds, totalFormatted, days, ...meta };
}

const report = (label, s) =>
  `  ${label.padEnd(8)} ${s.totalFormatted.padStart(10)}  (${s.languages.length} languages, ${s.meta.sessionCount} sessions)`;

console.log(`Stats written to ${OUT}  [algorithm v${ALGORITHM_VERSION}]`);
console.log(report('week', week));
console.log(report('alltime', alltime));

for (const [label, s] of [
  ['week', week],
  ['alltime', alltime],
]) {
  if (s.meta.unstampedHeartbeats > 0) {
    console.warn(
      `WARNING: ${label} contains ${s.meta.unstampedHeartbeats} heartbeat(s) with no configVersion ` +
        `(${s.meta.inexactIntervalHeartbeats} of them session heads, where it affects the total). ` +
        `A tracker is misconfigured — see METHODOLOGY.md.`,
    );
  }
}
