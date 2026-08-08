/**
 * Tests for this repo's own glue around the vendored algorithm: language
 * normalization, range boundaries, and result shaping.
 *
 * The algorithm itself is covered by `duration.test.mjs`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NORMALIZE,
  RANGES,
  normalizeLanguage,
  resolveRange,
  startOfLocalDay,
  summarize,
} from '../src/lib/takatime-stats.mjs';

const DENVER = 'America/Denver';
const iso = (ms) => new Date(ms).toISOString();

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

test('documented language aliases collapse', () => {
  const cases = {
    cpp: 'c++',
    javascriptreact: 'jsx',
    typescriptreact: 'tsx',
    shellscript: 'shell',
    unknown: 'other',
    'jupyter-notebook': 'python',
    jsonc: 'json',
    jsonl: 'json',
  };
  for (const [from, to] of Object.entries(cases)) {
    assert.equal(normalizeLanguage({ language: from, name: '/a/b.txt' }), to, `${from} -> ${to}`);
  }
});

test('language names are matched case-insensitively', () => {
  assert.equal(normalizeLanguage({ language: 'CPP' }), 'c++');
});

test('an unrecognised language passes through untouched', () => {
  assert.equal(normalizeLanguage({ language: 'rust' }), 'rust');
});

test('a missing language becomes "other", not a crash', () => {
  assert.equal(normalizeLanguage({}), 'other');
  assert.equal(normalizeLanguage({ language: null }), 'other');
});

test('.ipynb logged as json is corrected via the file extension', () => {
  // Some notebook heartbeats recorded the on-disk format instead of the kernel.
  // The extension is the more reliable signal, and it then normalizes to python.
  assert.equal(normalizeLanguage({ language: 'json', name: '/w/Untitled.ipynb' }), 'python');
  assert.equal(normalizeLanguage({ language: 'json', name: '/w/UPPER.IPYNB' }), 'python');
});

test('the .ipynb correction does not touch genuine json files', () => {
  assert.equal(normalizeLanguage({ language: 'json', name: '/w/package.json' }), 'json');
  assert.equal(normalizeLanguage({ language: 'json', name: '/w/site.webmanifest' }), 'json');
  assert.equal(normalizeLanguage({ language: 'json', name: undefined }), 'json');
});

test('markdown, json and config languages are NOT filtered out', () => {
  // Filtering happens downstream; the data layer stays complete.
  for (const lang of ['markdown', 'json', 'yaml', 'dotenv', 'plaintext', 'toml']) {
    assert.ok(normalizeLanguage({ language: lang }), `${lang} should survive normalization`);
  }
  assert.ok(!('markdown' in NORMALIZE), 'markdown must not be remapped or dropped');
});

/* -------------------------------------------------------------------------- */
/* Range boundaries                                                            */
/* -------------------------------------------------------------------------- */

test('local midnight is resolved in Denver, not UTC', () => {
  // 2026-08-01 in Denver (MDT, UTC-6) starts at 06:00Z.
  assert.equal(iso(startOfLocalDay('2026-08-01', DENVER)), '2026-08-01T06:00:00.000Z');
  // In January, Denver is MST (UTC-7), so midnight is 07:00Z.
  assert.equal(iso(startOfLocalDay('2026-01-15', DENVER)), '2026-01-15T07:00:00.000Z');
});

test('local midnight is correct across the DST transitions', () => {
  // Spring forward 2026-03-08, fall back 2026-11-01. Midnight is unaffected by
  // both (the shift happens at 02:00), so these must still be clean midnights.
  assert.equal(iso(startOfLocalDay('2026-03-08', DENVER)), '2026-03-08T07:00:00.000Z');
  assert.equal(iso(startOfLocalDay('2026-03-09', DENVER)), '2026-03-09T06:00:00.000Z');
  assert.equal(iso(startOfLocalDay('2026-11-01', DENVER)), '2026-11-01T06:00:00.000Z');
  assert.equal(iso(startOfLocalDay('2026-11-02', DENVER)), '2026-11-02T07:00:00.000Z');
});

test('week is 7 local days ending with today, on midnight boundaries', () => {
  // Late evening Denver on 2026-08-08 — still 2026-08-08 locally, though it is
  // already 2026-08-09 in UTC. This is exactly what the old toISOString() cutoff
  // got wrong.
  const now = Date.parse('2026-08-09T03:30:00Z');
  const r = resolveRange('week', { timeZone: DENVER, now });

  assert.equal(iso(r.start), '2026-08-02T06:00:00.000Z');
  assert.equal(iso(r.end), '2026-08-09T06:00:00.000Z');
  assert.equal((r.end - r.start) / 86_400_000, 7, 'week must span exactly 7 days');
});

test('a UTC-day rollover does not shift the local week', () => {
  // 21:00 and 23:00 Denver on the same local day sit in different UTC days, and
  // must still produce an identical window.
  const a = resolveRange('week', { timeZone: DENVER, now: Date.parse('2026-08-09T03:00:00Z') });
  const b = resolveRange('week', { timeZone: DENVER, now: Date.parse('2026-08-09T05:00:00Z') });
  assert.deepEqual(a, b);
});

test('month and year are rolling windows of whole local days', () => {
  const now = Date.parse('2026-08-08T18:00:00Z');
  for (const [name, days] of [
    ['month', 30],
    ['year', 365],
  ]) {
    const r = resolveRange(name, { timeZone: DENVER, now });
    assert.equal((r.end - r.start) / 86_400_000, days, `${name} must span ${days} days`);
  }
});

test('alltime is unbounded and every documented range resolves', () => {
  assert.equal(resolveRange('alltime'), null);
  for (const name of RANGES) assert.doesNotThrow(() => resolveRange(name));
});

test('an unknown range is rejected', () => {
  assert.throws(() => resolveRange('fortnight'), /Unknown range/);
});

/* -------------------------------------------------------------------------- */
/* Shaping                                                                     */
/* -------------------------------------------------------------------------- */

const hb = (isoTs, language, name = '/a/b') => ({
  timestamp: isoTs,
  language,
  name,
  configVersion: 2,
});

test('summarize reports absolute seconds alongside percentages', () => {
  const out = summarize(
    [
      hb('2026-08-05T16:00:00Z', 'python'),
      hb('2026-08-05T16:04:00Z', 'rust'),
    ],
    null,
    { timeZone: DENVER },
  );

  // python: 300s head credit + the 240s gap it owns. rust is last, so it earns
  // nothing. Total 540s.
  assert.equal(out.totalSeconds, 540);
  assert.equal(out.totalFormatted, '0h09m00s');

  const python = out.languages.find((l) => l.name === 'python');
  assert.equal(python.seconds, 540);
  assert.equal(python.percent, 100);
});

test('per-language `ms` sums to the total exactly, and rows are ranked', () => {
  const out = summarize(
    [
      hb('2026-08-05T16:00:00Z', 'python'),
      hb('2026-08-05T16:05:00Z', 'javascript'),
      hb('2026-08-05T16:07:00Z', 'javascript'),
    ],
    null,
    { timeZone: DENVER },
  );

  // Exact equality. `seconds` and `percent` are display roundings and may each
  // drift by less than a unit, which is why `ms` is the field that must close.
  const ms = out.languages.reduce((a, l) => a + l.ms, 0);
  assert.equal(ms, out.totalMs, 'per-language ms must sum to the total exactly');

  for (let i = 1; i < out.languages.length; i++) {
    assert.ok(out.languages[i - 1].ms >= out.languages[i].ms, 'must be descending');
  }
});

test('day buckets in `daysMs` also sum to the total exactly', () => {
  const out = summarize(
    [
      hb('2026-08-05T16:00:00Z', 'python'),
      hb('2026-08-06T16:05:00Z', 'javascript'),
      hb('2026-08-06T16:07:00Z', 'javascript'),
    ],
    null,
    { timeZone: DENVER },
  );
  const ms = Object.values(out.daysMs).reduce((a, b) => a + b, 0);
  assert.equal(ms, out.totalMs);
});

test('normalization is applied before attribution, so merged names merge exactly', () => {
  const out = summarize(
    [
      hb('2026-08-05T16:00:00Z', 'cpp', '/a/x.cpp'),
      hb('2026-08-05T16:04:00Z', 'c++', '/a/y.cpp'),
      hb('2026-08-05T16:08:00Z', 'c++', '/a/z.cpp'),
    ],
    null,
    { timeZone: DENVER },
  );

  assert.equal(out.languages.length, 1, 'cpp and c++ must be one row');
  assert.equal(out.languages[0].name, 'c++');
  assert.equal(out.languages[0].seconds, out.totalSeconds);
});

test('day buckets are cut at Denver midnight and sum to the total', () => {
  // 05:30Z on 2026-08-07 is still 23:30 on 2026-08-06 in Denver.
  const out = summarize([hb('2026-08-07T05:30:00Z', 'python')], null, { timeZone: DENVER });
  assert.deepEqual(Object.keys(out.days), ['2026-08-06']);

  assert.equal(Object.values(out.daysMs).reduce((a, b) => a + b, 0), out.totalMs);
});

test('the stored `date` field is ignored in favour of the timestamp', () => {
  const out = summarize(
    [{ ...hb('2026-08-07T05:30:00Z', 'python'), date: '1999-12-31' }],
    null,
    { timeZone: DENVER },
  );
  assert.deepEqual(Object.keys(out.days), ['2026-08-06']);
});

test('summarize reports algorithm provenance and stamping diagnostics', () => {
  const out = summarize([hb('2026-08-05T16:00:00Z', 'python')], null, { timeZone: DENVER });
  assert.equal(out.meta.algorithmVersion, '1.0.0');
  assert.equal(out.meta.timeZone, DENVER);
  assert.equal(out.meta.unstampedHeartbeats, 0);
});

test('an unstamped heartbeat is surfaced rather than silently estimated', () => {
  const { configVersion, ...unstamped } = hb('2026-08-05T16:00:00Z', 'python');
  const out = summarize([unstamped], null, { timeZone: DENVER });
  assert.equal(out.meta.unstampedHeartbeats, 1);
  assert.equal(out.meta.inexactIntervalHeartbeats, 1);
});

test('empty input yields zeroes, not a crash', () => {
  const out = summarize([], null, { timeZone: DENVER });
  assert.equal(out.totalSeconds, 0);
  assert.deepEqual(out.languages, []);
});
