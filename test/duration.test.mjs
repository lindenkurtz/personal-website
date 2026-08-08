/**
 * Calibration regression for the vendored duration algorithm.
 *
 * This exists so THIS repo independently verifies it computes the same numbers
 * as the tracker, without needing database access. The fixture is real
 * heartbeats with WakaTime ground truth embedded, copied from the TakaTime repo
 * alongside `src/lib/duration.mjs`.
 *
 * If these fail after refreshing the vendored copy, the website and the tracker
 * disagree — fix that before shipping, do not adjust the thresholds.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALGORITHM_VERSION,
  computeDurations,
  formatDuration,
  lookbackStart,
} from '../src/lib/duration.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'calibration-2026-08.json'), 'utf8'),
);

const S = 1000;
const drift = (actual, expected) => (actual / expected - 1) * 100;

/** WakaTime only ever saw VS Code, so comparisons must filter to that editor. */
const wakaTimeOnly = (h) => fixture.groundTruth.coversEditors.includes(h.editor);

const calibrated = () =>
  computeDurations(fixture.heartbeats, {
    range: fixture.range,
    timeZone: fixture.timeZone,
    filter: wakaTimeOnly,
  });

/* -------------------------------------------------------------------------- */
/* Ground truth                                                                */
/* -------------------------------------------------------------------------- */

test('7-day total tracks WakaTime within 10%', () => {
  const truth = fixture.groundTruth.rangeTotalSeconds;
  const result = calibrated();
  const d = drift(result.totalSeconds, truth);

  console.log(
    `    total: ${formatDuration(result.totalMs)} vs WakaTime ${formatDuration(truth * S)}  (${d.toFixed(2)}%)`,
  );
  assert.ok(
    Math.abs(d) <= 10,
    `drifted ${d.toFixed(2)}% from WakaTime (limit ±10%): got ${formatDuration(result.totalMs)}, expected ~${formatDuration(truth * S)}`,
  );
});

test('each ground-truth day lands within 20%', () => {
  const result = calibrated();

  for (const [day, truthSeconds] of Object.entries(fixture.groundTruth.daySeconds)) {
    const actualMs = result.groups.day[day] ?? 0;
    const d = drift(actualMs / S, truthSeconds);
    console.log(
      `    ${day}: ${formatDuration(actualMs)} vs WakaTime ${formatDuration(truthSeconds * S)}  (${d >= 0 ? '+' : ''}${d.toFixed(1)}%)`,
    );
    assert.ok(Math.abs(d) <= 20, `${day} drifted ${d.toFixed(1)}% (limit ±20%)`);
  }
});

test('summing the legacy `duration` field is materially wrong', () => {
  // The reason this whole migration happened. If this ever starts agreeing with
  // ground truth, the meaning of `duration` has changed and the data contract in
  // CLAUDE.md needs revisiting.
  const inRange = fixture.heartbeats.filter((h) => {
    const t = Date.parse(h.timestamp);
    return t >= Date.parse(fixture.range.start) && t < Date.parse(fixture.range.end) && wakaTimeOnly(h);
  });

  const legacy = inRange.reduce((a, h) => a + (h.duration ?? 0), 0);
  const truth = fixture.groundTruth.rangeTotalSeconds;

  assert.ok(legacy < truth, 'legacy duration sum is expected to undercount');
  assert.ok(Math.abs(drift(legacy, truth)) > 10, 'legacy sum is supposed to be materially wrong');
});

/* -------------------------------------------------------------------------- */
/* Invariants the website relies on                                            */
/* -------------------------------------------------------------------------- */

test('language buckets sum to exactly the grand total', () => {
  // Exact, not approximate — percentages on the chart are only trustworthy
  // because the underlying integer milliseconds partition the total precisely.
  const result = computeDurations(fixture.heartbeats, {
    range: fixture.range,
    timeZone: fixture.timeZone,
    groupBy: ['language', 'day'],
  });

  for (const dim of ['language', 'day']) {
    const sum = Object.values(result.groups[dim]).reduce((a, b) => a + b, 0);
    assert.equal(sum, result.totalMs, `group "${dim}" summed to ${sum}, expected ${result.totalMs}`);
  }
});

test('the lookback buffer prevents a spurious head credit at the boundary', () => {
  // A session straddling the range start must not be re-read as a fresh session.
  const rangeStart = '2026-05-02T00:00:00Z';
  const t0 = Date.parse(rangeStart);
  const range = { start: rangeStart, end: '2026-05-03T00:00:00Z' };
  const hb = (t) => ({ timestamp: new Date(t).toISOString(), language: 'javascript', configVersion: 2 });

  const withContext = computeDurations([hb(t0 - 200 * S), hb(t0 + 100 * S)], { range });
  assert.equal(withContext.contextHeartbeats, 1);
  assert.equal(withContext.totalMs, 0, 'the in-range heartbeat is mid-session and earns nothing');

  const withoutContext = computeDurations([hb(t0 + 100 * S)], { range });
  assert.equal(withoutContext.totalMs, 300 * S, 'without context it is wrongly credited a full interval');
});

test('lookbackStart offsets by the idle timeout', () => {
  const start = '2026-08-02T00:00:00Z';
  assert.equal(lookbackStart(start), Date.parse(start) - 900 * S);
});

test('every fixture heartbeat is config-stamped', () => {
  const result = computeDurations(fixture.heartbeats, {
    range: fixture.range,
    timeZone: fixture.timeZone,
  });
  assert.equal(result.unstampedHeartbeats, 0, 'a stamped dataset should need no date fallback');
  assert.equal(result.inexactIntervalHeartbeats, 0, 'no session head interval should be estimated');
});

/* -------------------------------------------------------------------------- */
/* Vendoring                                                                   */
/* -------------------------------------------------------------------------- */

test('vendored ALGORITHM_VERSION is the one this repo was calibrated against', () => {
  // Pinned deliberately. If refreshing the copy from upstream trips this, the
  // numbers may have moved: re-read the upstream changelog, confirm the
  // calibration above still passes, then bump this pin in the same commit.
  assert.equal(
    ALGORITHM_VERSION,
    '1.0.0',
    `vendored duration.mjs is v${ALGORITHM_VERSION}, this repo is pinned to v1.0.0`,
  );
});
