# Haven

One household app: a PWA console with pluggable modules. Module 1 is Meals & Groceries.
Spec: the "Haven — PRD" doc (Product and design · Technical spec · Privacy · Terms).
Mockups: the "Haven — Mockups" canvas.

This replaces the 0.4.0 MVP (decision, Nov 2026: MVP data is throwaway).

## Layout

| Path | What |
| --- | --- |
| `worker/` | One codebase, two Workers. Hono API, Google sign-in (PKCE), sessions, households, invites, rate limits, Household Durable Object (ordered sync, dedupe, versioning, presence, admin signals), admin API with passkeys, crons. |
| `worker/migrations/` | `0002_drop_mvp.sql` removes the MVP tables; `0003_init.sql` creates Haven v1. (`0001_shell.sql` is the MVP's, already recorded as applied in `haven-apac`.) |
| `apps/web/` | The household app (PWA). |
| `apps/admin/` | The admin site. |
| `modules/meals/` | Meals & Groceries screens. |
| `packages/meals-core/` | Shopping windows, scaling, units, rounding, list states, ingredient parser (28 tests). |
| `packages/sync/`, `packages/ui/`, `packages/tokens/` | Sync client, components, theme tokens. |
| `wrangler.toml` | App Worker `haven` → haven.wk-io.workers.dev |
| `wrangler.admin.toml` | Admin Worker `haven-admin` → haven-admin.wk-io.workers.dev |

## Run locally

```text
npm install
npm run build
npm test
npm run typecheck
npm run db:migrate:local
cp worker/.dev.vars.example .dev.vars    # GOOGLE_CLIENT_SECRET, and ADMIN_EMAIL / ADMIN_SETUP_CODE for admin
npm run dev                               # app on http://localhost:8787
npm run dev:admin                         # admin on http://localhost:8788
```

## Go live (one time)

1. **Google Cloud Console** › the existing OAuth client › add redirect URI `https://haven-admin.wk-io.workers.dev/`. (The app keeps `https://haven.wk-io.workers.dev/`; sign-in still returns to `/`.)
2. **Push** this branch to `main`. Workers Builds runs `npm run build` and deploys `haven` (now with Durable Objects).
3. **Migrate** right after the deploy: `npm run db:migrate` (applies 0002 then 0003 to `haven-apac`). Between deploy and migrate the app errors; everyone signs in again afterwards.
4. **Admin Worker**: Workers & Pages › Create › connect this repo again; build command `npm run build`, deploy command `npx wrangler deploy -c wrangler.admin.toml`. Set its secrets in the dashboard: `GOOGLE_CLIENT_SECRET` (same value as the app), `ADMIN_EMAIL`, `ADMIN_SETUP_CODE` (long random code). Optional: `CF_API_TOKEN` (Account Analytics: Read) and `CF_ACCOUNT_ID` for usage figures.
5. Open https://haven-admin.wk-io.workers.dev, sign in with Google, enter the setup code, create a passkey; add a second passkey from Account.

## Switched off for now

- **Recipe photos** (decision, Nov 2026): enable R2, `npx wrangler r2 bucket create haven-photos`, then uncomment the `[[r2_buckets]]` block in `wrangler.toml` (and add it to `wrangler.admin.toml` if wanted). The app shows the photo field only when the binding exists.
- **Email** for feedback and usage alerts (decision, Nov 2026): needs a domain on Cloudflare (Email Routing). Until then both show in admin.

## Known gaps

- The usage cron's GraphQL query hasn't run against the live account yet; check admin Health after the first 12:00/20:00 UTC run.
- Health shows D1-based counts; the PRD's percentage metrics need reading Analytics Engine via its SQL API (events are already written).
- Ingredient reordering uses ↑/↓ buttons instead of drag; the unit hint names the usual unit without suggesting an amount.
- Launch checklist items still open: accessibility and real-device passes, legal placeholders.
