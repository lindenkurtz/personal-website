# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Linden Kurtz's personal website/portfolio, built with Astro 6 + Tailwind CSS 4. Hosted at lindenkurtz.com (see `CNAME`). Content includes a project portfolio (Astro content collections) and a "Now" section showing live coding-activity stats pulled from a MongoDB-backed WakaTime-style tracker ("takatime").

## Commands

- `npm run dev` — start the Astro dev server (localhost:4321)
- `npm run build` — build the production site to `./dist/`
- `npm run preview` — build, then run `wrangler dev` to preview the Cloudflare Worker locally
- `npm run deploy` — build, then `wrangler deploy` to Cloudflare
- `npm run generate-types` — regenerate `worker-configuration.d.ts` via `wrangler types`
- `npm run astro -- check` — type-check `.astro` files (uses `astro/tsconfigs/strict`)
- `node scripts/generate-stats.mjs` — regenerate `public/coding-stats.json` from MongoDB (requires `MONGO_URI` env var)

There is no test suite configured.

## Architecture

### Deployment is dual-target
- **Cloudflare Workers** (primary, via `wrangler.jsonc`/`wrangler.toml` + `@astrojs/cloudflare`). The adapter in `astro.config.mjs` is only enabled when `NODE_ENV === 'production'` — local `dev` runs without it.
- **GitHub Pages** (via `.github/workflows`, using `withastro/action`), triggered on push to `main`.

A separate scheduled workflow (`.github/workflows`, cron every 6 hours) runs `scripts/generate-stats.mjs` and commits the regenerated `public/coding-stats.json` back to the repo.

### Content collections
Projects live as MDX files in `src/content/projects/*.mdx`, with frontmatter schema defined in `src/content.config.ts` (`title`, `date`, `description`, `thumbnail`, `tags`, `order`). Pages sort projects by `order` (default 99 if unset):
- `src/pages/index.astro` — home page, shows the top projects via `ProjectFeatured.astro`. Hero section includes a headshot at `public/images/headshot.jpeg`.
- `src/pages/projects/index.astro` — full project grid
- `src/pages/projects/[slug].astro` — per-project detail page, renders MDX body via `render(entry)`
- `src/pages/contact.astro` — simple contact page (email, LinkedIn, GitHub, resume links), no form

### Coding-stats pipeline ("WakaChart")
There are two parallel implementations of the same language-aggregation query against the MongoDB `takatime.logs` collection:
1. `src/pages/api/takatime.js` — a live SSR API route (`prerender = false`) that queries MongoDB directly via `MONGO_URI`, supports `?range=week|alltime`.
2. `scripts/generate-stats.mjs` — a standalone script (run by the scheduled GitHub Action) that writes a static `public/coding-stats.json` with both `week` and `alltime` results.

`src/components/WakaChart.astro` fetches `/coding-stats.json` (the static file, not the API route) and renders a D3 sunburst chart per range. Both backends apply the same language-name normalization (e.g. `cpp` → `c++`, `jsonl`/`jsonc` → `json`) — if you change the normalization map in one, update the other (`NORMALIZE` in `generate-stats.mjs` vs the inline `$switch` in `takatime.js`).

The sunburst's color/grouping logic in `WakaChart.astro` is driven by the `FAMILIES` map (systems, data_science, frontend, scripting, config, data, markup, jvm_mobile, dotnet) — each language is bucketed into a family for the inner ring, with per-language colors on the outer ring. Languages not found in any family fall into "Other".

Because `mongodb` is a Node-only package, it's externalized in `astro.config.mjs` (`vite.ssr.external` and `vite.optimizeDeps.exclude`).

### Styling
Tailwind v4 via `@tailwindcss/vite` + `@tailwindcss/typography`. The custom theme (colors, fonts) is defined in `src/styles/index.css` under `@theme` — palette names: `primary`/`primary-dark` (teal), `accent`/`accent-light` (coral/peach), `base`/`base-dark` (off-white/sand), `ink`. Fonts: `Space Grotesk` for headings, `Outfit` for body.

### Layout
`src/layouts/Layout.astro` wraps every page with `Navbar` and `Footer` and imports the global stylesheet. Home page sections (`#home`, `#projects`, `#now`) are anchor targets for the nav links in `Navbar.astro`.

### Contact info
Email, LinkedIn, and GitHub links are duplicated in both `src/components/Footer.astro` (icon-only social links) and `src/pages/contact.astro` (full contact cards) — update both if these change.

## Environment

`MONGO_URI` is required for both `src/pages/api/takatime.js` and `scripts/generate-stats.mjs`. Locally this goes in `.env`/`.dev.vars` (gitignored); in CI it's provided via the `MONGO_URI` GitHub Actions secret.
