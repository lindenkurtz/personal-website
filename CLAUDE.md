# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Linden Kurtz's personal website/portfolio, built with Astro 6 + Tailwind CSS 4. Hosted at lindenkurtz.com (see `CNAME`). Content includes a project portfolio (Astro content collections) and a "Now" section showing live coding-activity stats pulled from a MongoDB-backed WakaTime-style tracker ("takatime").

The tracker lives in a **separate repo (TakaTime)**, which owns the duration algorithm. This repo vendors a verbatim copy of it — see "Coding-stats data contract" below before changing anything that turns heartbeats into numbers.

## Commands

- `npm run dev` — start the Astro dev server (localhost:4321)
- `npm run build` — build the production site to `./dist/`
- `npm run preview` — build, then run `wrangler dev` to preview the Cloudflare Worker locally
- `npm run deploy` — build, then `wrangler deploy` to Cloudflare
- `npm run generate-types` — regenerate `worker-configuration.d.ts` via `wrangler types`
- `npm run astro -- check` — type-check `.astro` files (uses `astro/tsconfigs/strict`)
- `node scripts/generate-stats.mjs` — regenerate `public/coding-stats.json` from MongoDB (requires `MONGO_URI` env var)
- `npm test` — run the duration-algorithm calibration and stats tests (`node --test`, no deps, no database)

## Architecture

### Deployment is dual-target
- **Cloudflare Workers** (primary, via `wrangler.jsonc` + `@astrojs/cloudflare`). The adapter in `astro.config.mjs` is only enabled when `NODE_ENV === 'production'` — local `dev` runs without it. lindenkurtz.com is served by Cloudflare.
- **GitHub Pages** (via `.github/workflows`, using `withastro/action`), triggered on push to `main`.

A separate scheduled workflow (`.github/workflows`, cron every 6 hours) runs `scripts/generate-stats.mjs` and commits the regenerated `public/coding-stats.json` back to the repo.

**Two wrangler configs exist and only one is used.** Wrangler loads `wrangler.jsonc`; `wrangler.toml` is dead and its `nodejs_compat` flag has no effect. Confirm with `npx wrangler deploy --dry-run`, which prints the config it selected.

**The `mongodb` driver cannot run on Cloudflare Workers.** It needs raw TCP (`node:net`) wrapped in `node:tls`, plus `node:dns` SRV/TXT lookups for `mongodb+srv://`. Workers implements `node:tls` and `node:dns` only partially, and the SRV lookups are not among the implemented parts — so this is not something `nodejs_compat` fixes. In the built Worker the route fails at module load, before any query, with `No such module "chunks/timers"`. Consequences:

- Anything importing `src/lib/mongo.mjs` is Node-only: `astro dev`, `node scripts/generate-stats.mjs`, GitHub Actions.
- The live chart does not depend on it — it reads the static `public/coding-stats.json`.
- Making `/api/takatime` work in production would mean serving it from the static JSON, putting Mongo behind an HTTP data layer, or moving to a Node runtime. Adding `nodejs_compat` alone will not do it.

### Content collections
Projects live as MDX files in `src/content/projects/*.mdx`, with frontmatter schema defined in `src/content.config.ts` (`title`, `date`, `description`, `thumbnail`, `tags`, `order`). Pages sort projects by `order` (default 99 if unset):
- `src/pages/index.astro` — home page, shows the top projects via `ProjectFeatured.astro`. Hero section includes a headshot at `public/images/headshot.jpeg`.
- `src/pages/projects/index.astro` — full project grid
- `src/pages/projects/[slug].astro` — per-project detail page, renders MDX body via `render(entry)`
- `src/pages/contact.astro` — simple contact page (email, LinkedIn, GitHub, resume links), no form

## Coding-stats data contract

Read this before touching anything that produces a number from `takatime.logs`.

### Heartbeats are observations, not durations

A heartbeat records *"this file was being edited at this instant"*. It is a point in time, not a span.

**Never sum the `duration` field.** It exists only on pre-v3 records, and it holds the tracker's *throttle interval frozen at write time* — an interpretation baked into the raw log, not measured time. The throttle changed on 2026-04-23 (120s per-file → 300s global), so summing it mixes two incompatible regimes. Against WakaTime ground truth it undercounts by ~18% and materially skews per-language shares. `test/duration.test.mjs` asserts that summing it stays wrong, so the mistake cannot quietly return.

The field is not projected out of MongoDB at all (see `PROJECTION` in `src/lib/takatime-stats.mjs`) — it cannot be summed by accident because it never reaches the application.

### Durations come only from the shared module

Durations are derived at **query time** from timestamps, so historical data stays valid across future config changes.

- `src/lib/duration.mjs` — **vendored, do not edit.** A verbatim copy of the canonical algorithm from the TakaTime repo (`analytics/duration.mjs`). Pure, zero-dependency ESM. Sessionizes heartbeats on a 900s idle timeout, credits each gap to the earlier heartbeat, and credits each session head one `intervalSeconds` resolved from its `configVersion`.
- `src/lib/takatime-stats.mjs` — the only place this repo queries, normalizes, and shapes. Range resolution, the `NORMALIZE` map, and result shaping all live here.
- `src/lib/mongo.mjs` — connection handling, with a module-scoped cached client.

Both consumers are thin wrappers over `getStats()` and compute nothing themselves:

1. `src/pages/api/takatime.js` — live SSR route (`prerender = false`), `?range=week|month|year|alltime`. **Cannot run on the deployed Cloudflare Worker** (see below); works under `astro dev` and any Node target.
2. `scripts/generate-stats.mjs` — run by the scheduled GitHub Action on Node, writes `public/coding-stats.json`. **This is the path that actually feeds the live chart.**

If you need a new statistic, add it to `takatime-stats.mjs`. Do not write a second aggregation — two implementations drifting apart is the failure this structure exists to prevent.

### Rules that are easy to get wrong

- **Always fetch with the lookback buffer.** Build range queries with `lookbackStart(range.start)`, never `range.start`. A session straddling the boundary otherwise reads as a fresh session and is wrongly credited a whole extra interval. `fetchHeartbeats()` handles this; the test pins the behaviour.
- **Never use the stored `date` field for filtering or bucketing.** It was written in whatever local zone the machine happened to be in. Use `timestamp` with explicit `America/Denver` boundaries via `resolveRange()` / `startOfLocalDay()`. (The pre-2026-08 bug: a UTC `toISOString()` cutoff compared against a local-time `date` string.)
- **`ms` is the authoritative unit.** Integer milliseconds are what make additivity exact — per-language and per-day `ms` sum to `totalMs` bit-for-bit. `seconds` and `percent` are display roundings and may each land a hair off; read `ms` when the arithmetic has to close.
- **Do not filter out markdown, json, or config languages.** The data layer stays complete; filtering is a downstream/presentation concern.

### Syncing the vendored algorithm

`src/lib/duration.mjs` is a copy, and a copy goes stale silently. The header carries the upstream sha256 of everything below it.

```sh
tail -n +19 src/lib/duration.mjs | shasum -a256   # must equal...
shasum -a256 <takatime>/analytics/duration.mjs    # ...this
```

**If the tracker's `ALGORITHM_VERSION` changes, refresh the copy here.** Procedure:

1. Re-copy `analytics/duration.mjs` verbatim, keeping the vendoring header on top.
2. Re-copy `analytics/fixtures/calibration-2026-08.json` to `test/fixtures/`.
3. Update the sha256 and version in the header.
4. Bump the pinned version in `test/duration.test.mjs` (the `ALGORITHM_VERSION` test fails deliberately until you do — that is the drift alarm).
5. Run `npm test`. If calibration now fails, the website and tracker disagree — fix that before shipping, do not relax the thresholds.

Record `ALGORITHM_VERSION` next to any derived stat that gets persisted; `public/coding-stats.json` carries it under `meta.algorithmVersion`. Currently pinned to **1.0.0**. Upstream also publishes the config table to a `takatime.configs` collection, but `CONFIG_REGISTRY` inside the module is the source of truth — never read the collection instead.

`meta.unstampedHeartbeats` should always be `0`. Non-zero means a tracker is writing heartbeats without a `configVersion` and part of the result rests on a date-based guess; `generate-stats.mjs` warns when this happens.

### Chart rendering

`src/components/WakaChart.astro` fetches `/coding-stats.json` (the static file, not the API route) and renders a D3 sunburst per range. It reads `name` and `percent` only and computes no durations — its `groupSmall()` merely buckets sub-0.5% languages into "Other" for display.

The sunburst's color/grouping logic is driven by the `FAMILIES` map (systems, data_science, frontend, scripting, config, data, markup, jvm_mobile, dotnet) — each language is bucketed into a family for the inner ring, with per-language colors on the outer ring. Languages not found in any family fall into "Other". Note that `FAMILIES` lists a few names that normalization means it will never see (`jupyter-notebook`, `javascriptreact`, `typescriptreact`); they are harmless fallbacks, and their normalized forms (`python`, `jsx`, `tsx`) are mapped.

Because `mongodb` is a Node-only package, it's externalized in `astro.config.mjs` (`vite.ssr.external` and `vite.optimizeDeps.exclude`).

### Styling
Tailwind v4 via `@tailwindcss/vite` + `@tailwindcss/typography`. The custom theme (colors, fonts) is defined in `src/styles/index.css` under `@theme` — palette names: `primary`/`primary-dark` (teal), `accent`/`accent-light` (coral/peach), `base`/`base-dark` (off-white/sand), `ink`. Fonts: `Space Grotesk` for headings, `Outfit` for body.

### Layout
`src/layouts/Layout.astro` wraps every page with `Navbar` and `Footer` and imports the global stylesheet. Home page sections (`#home`, `#projects`, `#now`) are anchor targets for the nav links in `Navbar.astro`.

### Contact info
Email, LinkedIn, and GitHub links are duplicated in both `src/components/Footer.astro` (icon-only social links) and `src/pages/contact.astro` (full contact cards) — update both if these change.

## Environment

`MONGO_URI` is required for both `src/pages/api/takatime.js` and `scripts/generate-stats.mjs`. Locally this goes in `.env`/`.dev.vars` (gitignored); in CI it's provided via the `MONGO_URI` GitHub Actions secret.

`npm test` needs neither — the calibration fixture in `test/fixtures/` carries real heartbeats with WakaTime ground truth embedded, so the algorithm is verified without database access.
