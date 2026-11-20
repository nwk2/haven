# Haven

One household app — a progressive web app (PWA) shell with pluggable modules.
The Weekly Cook Board is module 1, as one Kitchen module (Plan / Today / Shop /
Recipes / Pantry).

Specs (frozen, for review): Haven spec v0.15 and Cook Board spec v0.14, in
`~/workspace/goals/shared-shopping-list/files/`. The build plan (8 batches 0–7)
is `haven-build-plan.pdf` next to them; batch progress is tracked in
`STATUS.md` in the same folder — the plan PDF is the frozen approved snapshot
and is not rebuilt per batch.

## Status

**Batch 0 — scaffold + prove the deploy loop: DONE.** **Batch 1 — shell,
Editorial tokens, home screen: in progress.** See `STATUS.md` for the live
state. Each batch gets its own go-ahead before it is pushed; a push needs
Wai's tap, and nothing pushes while he is away.

## Layout (spec §11)

```
shell/                  The shell: Worker entry, SPA, shell migrations.
  src/index.ts          Worker entry — serves the SPA + /api/* routes.
  public/               Shell static assets (assembled into dist/ by the build).
  migrations/           Shell D1 migrations (users, sessions, households,
                        household_members, modules registry,
                        push_subscriptions, events).
modules/kitchen/        Module 1: Kitchen. Client routes, server routes and
  client/               migrations live together in the module's folder.
  server/
  migrations/           Kitchen migrations land here in Batch 3.
shared/                 Shared tokens and components (Batch 1):
                        tokens.css, components.css, components.js
                        (sheet + confirm prompt), shell-logic.js
                        (pure, Node-tested helpers: theme, greeting,
                        tiles, widgets).
scripts/build.mjs       Assembles dist/ from shell/public + shared/* +
                        every modules/*/client chunk (generic — adding a
                        module needs no build change).
scripts/smoke-test.mjs  Node tests for the pure shell logic; with
                        --modules-url also checks a running server's
                        registry + chunks.
wrangler.toml           One Worker (haven), one D1 (haven), assets in dist/.
```

One Worker serves the SPA and the API. One D1 database, prefixed tables per
module (`cook_*`, `shop_*`), per-module migrations. A module earns its own
Worker only on load, isolation or deploy-risk grounds.

## Run locally

```text
npm install
npm run typecheck
npm run build        # assembles dist/
npm run test         # Node smoke tests for the pure shell logic
```

Local dev needs the shell and kitchen migrations in the local D1 first
(wrangler dev does not apply them on its own):

```text
npx wrangler d1 migrations apply haven-apac --local -y
npx wrangler d1 execute haven-apac --local --file modules/kitchen/migrations/0001_kitchen.sql
npm run dev          # wrangler dev --local (local D1, no remote state)
```

Then open http://localhost:8787 — `/api/health` returns
`{"ok":true,"service":"haven","version":"0.1.2"}` and the home screen
renders its tiles from `/api/modules`.

## Deploy loop (Don't Ngiao precedent)

Push to `main` → Workers Builds deploys → check the deployment actually
advanced (`cf.py deployments` / `cf.py versions`: latest `created_on` after
the push, version numbers incrementing) → apply migrations in the agreed
order → verify live.

Migration sequencing: adding a column — migration first, then code that uses
it; removing a column — code first, deploy, then drop it. Migrations are
applied with the Cloudflare helper (it replicates
`wrangler d1 migrations apply --remote`):

```text
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py \
  --account 6439147f0ae67010881c1eaac02aca30 \
  --db <haven-d1-uuid> --migrations-dir shell/migrations migrations-apply
```

Per-module migrations are applied the same way with that module's
`--migrations-dir`, after the shell migrations, in dependency order.

## Dashboard steps only Wai can do

1. **Create the D1 database** — done 2026-11-20 (`haven`,
   `6e60ddbf-ad98-4a12-ac7f-1d4d3f38af15`).
2. **Connect the repo to Workers Builds** — done 2026-11-20 (build
   `npm ci && npm run build`, deploy `npx wrangler deploy`).
3. **Google OAuth client + consent screen** — before Batch 2 (create during
   Batches 0–1; review can take time). Client created 2026-11-20; the
   secret goes in as a Worker secret (`GOOGLE_CLIENT_SECRET`) in Batch 2.
4. **R2 activation (billing profile / card on file)** — before Batch 6.

## Rules carried across batches

- No login in Batch 0 — a temporary local-only bypass, removed in Batch 2.
  No auth, no user data yet; the shell page and `/api/health` are public.
- Never commit secrets. Worker secrets go through the proper secret flow,
  never files.
- Authenticated endpoints get probed on every live verification (Dispatch
  lesson). iOS behaviour is proven on a real iPhone, never from Safari or
  a desktop check.
- Free tier only. Household-scoped queries with `household_id` leading
  composite indexes keep D1 rows-read cheap.
