/**
 * TakaTime stats — the ONE place this repo turns heartbeats into numbers.
 *
 * Both consumers go through here:
 *   - `src/pages/api/takatime.js`   (live SSR route)
 *   - `scripts/generate-stats.mjs`  (scheduled job -> public/coding-stats.json)
 *
 * Neither is allowed to query, normalize, or aggregate on its own. Having two
 * implementations of this drift apart is the exact failure this module exists
 * to prevent.
 *
 * Durations are NEVER computed here either — they come from `./duration.mjs`,
 * which is a verbatim copy of the tracker's canonical algorithm. This file only
 * does the three things that are genuinely website-specific:
 *
 *   1. building a query window (with the mandatory lookback buffer),
 *   2. normalizing language names for display,
 *   3. shaping the result for the chart.
 *
 * See CLAUDE.md § "Coding-stats data contract".
 */

import {
  ALGORITHM_VERSION,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_TIME_ZONE,
  computeDurations,
  dayKey,
  formatDuration,
  lookbackStart,
  rank,
} from './duration.mjs';

export { ALGORITHM_VERSION, DEFAULT_TIME_ZONE };

export const DB_NAME = 'takatime';
export const COLLECTION_NAME = 'logs';

/**
 * Display-name normalization. Purely cosmetic collapsing of names that mean the
 * same thing to a reader — it never changes how time is attributed.
 *
 * Keep in step with nothing: this map lives here and only here.
 */
export const NORMALIZE = {
  cpp: 'c++',
  jsonc: 'json',
  jsonl: 'json',
  javascriptreact: 'jsx',
  typescriptreact: 'tsx',
  shellscript: 'shell',
  'jupyter-notebook': 'python',
  unknown: 'other',
};

/**
 * Normalized display language for a heartbeat.
 *
 * The `.ipynb` special case: a run of notebook heartbeats were logged with
 * language `json` (the editor reported the file's on-disk format rather than its
 * kernel). The filename is the more reliable signal, so it wins — and then falls
 * through NORMALIZE like any other notebook, landing on `python`.
 */
export function normalizeLanguage(heartbeat) {
  let lang = String(heartbeat?.language ?? 'unknown').toLowerCase();
  const file = typeof heartbeat?.name === 'string' ? heartbeat.name.toLowerCase() : '';
  if (lang === 'json' && file.endsWith('.ipynb')) lang = 'jupyter-notebook';
  return NORMALIZE[lang] ?? lang;
}

/* -------------------------------------------------------------------------- */
/* Ranges                                                                      */
/* -------------------------------------------------------------------------- */

/** Rolling window lengths, in whole days. `alltime` is unbounded. */
export const RANGE_DAYS = { week: 7, month: 30, year: 365 };
export const RANGES = ['week', 'month', 'year', 'alltime'];

/**
 * Offset of `timeZone` from UTC at a given instant, in ms. Positive east of UTC.
 * Derived from Intl rather than hardcoded, so MST/MDT is handled automatically.
 */
function zoneOffsetMs(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(new Date(epochMs))
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - epochMs;
}

/**
 * Epoch ms of midnight starting the local day `YYYY-MM-DD` in `timeZone`.
 *
 * Two passes: the first guess uses the offset at midnight UTC, the second
 * re-resolves using that guess. This is what makes DST-transition days correct
 * instead of an hour off.
 */
export function startOfLocalDay(dayString, timeZone = DEFAULT_TIME_ZONE) {
  const [y, m, d] = dayString.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const firstPass = utcMidnight - zoneOffsetMs(utcMidnight, timeZone);
  return utcMidnight - zoneOffsetMs(firstPass, timeZone);
}

const DAY_MS = 86_400_000;

/**
 * Resolve a range name into an explicit half-open window `[start, end)`.
 *
 * Boundaries are midnight in `timeZone` — NOT UTC, and not the stored `date`
 * field. `week` means the 7 local days ending with today (today included), so
 * `end` is tomorrow's midnight.
 *
 * Returns `null` for `alltime`, which is the unbounded case.
 */
export function resolveRange(rangeName, { timeZone = DEFAULT_TIME_ZONE, now = Date.now() } = {}) {
  if (rangeName === 'alltime') return null;

  const days = RANGE_DAYS[rangeName];
  if (!days) throw new Error(`Unknown range "${rangeName}". Expected one of: ${RANGES.join(', ')}`);

  const todayStart = startOfLocalDay(dayKey(now, timeZone), timeZone);
  // Step in whole days off a local midnight, then re-anchor, so a DST shift
  // inside the window cannot smear the start boundary off midnight.
  const startDay = dayKey(todayStart - (days - 1) * DAY_MS, timeZone);
  const endDay = dayKey(todayStart + DAY_MS, timeZone);

  return {
    start: startOfLocalDay(startDay, timeZone),
    end: startOfLocalDay(endDay, timeZone),
  };
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Only what the algorithm and the display need. `duration` is deliberately NOT
 * projected — it is legacy, it must never be summed, and leaving it out of the
 * result set means it cannot be summed by accident.
 */
const PROJECTION = { _id: 0, timestamp: 1, language: 1, name: 1, configVersion: 1 };

/**
 * Fetch the heartbeats needed to answer `range`.
 *
 * The window starts one IDLE_TIMEOUT BEFORE the range start. Those extra
 * heartbeats are not counted — `computeDurations` clips them — but without them
 * a session already in progress at the boundary is misread as a fresh session
 * and wrongly credited a whole interval.
 */
export async function fetchHeartbeats(collection, range) {
  const query = range
    ? { timestamp: { $gte: new Date(lookbackStart(range.start)), $lt: new Date(range.end) } }
    : {};

  return collection.find(query).project(PROJECTION).sort({ timestamp: 1 }).toArray();
}

/* -------------------------------------------------------------------------- */
/* Shaping                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Heartbeats -> the payload the chart and the API both serve.
 *
 * Language rows keep `name` and `percent` for the existing chart, and carry
 * `ms` / `seconds` / `formatted` alongside so totals can be checked against
 * WakaTime.
 *
 * `ms` is the authoritative figure: integer milliseconds, and the only field
 * that sums to the total EXACTLY. `seconds` and `percent` are rounded for
 * display, so summing either can land a hair off the total — read `ms` when the
 * arithmetic has to close.
 */
export function summarize(heartbeats, range, { timeZone = DEFAULT_TIME_ZONE } = {}) {
  // Normalization is applied to a shallow copy: the algorithm attributes time to
  // whatever `language` it is handed, so normalizing first keeps the additivity
  // invariant intact (merged names merge their milliseconds exactly).
  const normalized = heartbeats.map((hb) => ({ ...hb, language: normalizeLanguage(hb) }));

  const result = computeDurations(normalized, {
    ...(range ? { range } : {}),
    timeZone,
    groupBy: ['language', 'day'],
  });

  const languages = rank(result.groups.language, result.totalMs).map((row) => ({
    name: row.key,
    percent: Number((row.share * 100).toFixed(1)),
    ms: row.ms,
    seconds: Math.round(row.ms / 1000),
    formatted: row.formatted,
  }));

  return {
    languages,
    totalMs: result.totalMs,
    totalSeconds: Math.round(result.totalMs / 1000),
    totalFormatted: result.formatted,
    days: Object.fromEntries(
      Object.entries(result.groups.day)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, ms]) => [day, Math.round(ms / 1000)]),
    ),
    /** Exact integer milliseconds per day; `days` above is rounded for display. */
    daysMs: Object.fromEntries(
      Object.entries(result.groups.day).sort(([a], [b]) => a.localeCompare(b)),
    ),
    meta: {
      algorithmVersion: result.algorithmVersion,
      idleTimeoutSeconds: result.idleTimeoutSeconds,
      timeZone: result.timeZone,
      sessionCount: result.sessionCount,
      countedHeartbeats: result.countedHeartbeats,
      contextHeartbeats: result.contextHeartbeats,
      /** Expected 0. Non-zero means a tracker is writing unstamped heartbeats. */
      unstampedHeartbeats: result.unstampedHeartbeats,
      inexactIntervalHeartbeats: result.inexactIntervalHeartbeats,
      rangeStart: range ? new Date(range.start).toISOString() : null,
      rangeEnd: range ? new Date(range.end).toISOString() : null,
    },
  };
}

/**
 * The whole pipeline for one range: resolve -> fetch -> compute -> shape.
 */
export async function getStats(collection, rangeName, options = {}) {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const range = resolveRange(rangeName, { timeZone, now: options.now ?? Date.now() });
  const heartbeats = await fetchHeartbeats(collection, range);
  return { range: rangeName, ...summarize(heartbeats, range, { timeZone }) };
}

export { DEFAULT_IDLE_TIMEOUT_SECONDS, formatDuration };
