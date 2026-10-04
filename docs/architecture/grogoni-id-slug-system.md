# Canonical Store Slug System — Extending `grogoniId`

Status: complete, with two explicit gaps named in §7 rather than silently skipped.

## 1. Why this doesn't build a new `Store`/`slug` system from scratch

The original request assumed Prisma, a `Store` model, and subdomain-based routing. None of that
exists in this codebase. What actually exists:

- No Prisma anywhere in the monorepo. Persistence is a hand-rolled `Cp2Store` class
  (`services/api/src/cp2/store.ts`) backed by Postgres via a generic envelope-table mechanism
  (`entity_id, business_id, account_id, user_id, parent_id, record jsonb, updated_at`), not an ORM.
- The entity is `Business` (`BusinessSummary`), not `Store`.
- A canonical, unique, DB-enforced, pinned-by-default store identifier **already exists**:
  `business.grogoniId`, generated once at creation by `Cp2Store`'s private `createGlobalShopId`
  (`store.ts`, format `grogoni.<handle>`), with numeric-suffix collision handling already implemented
  (`grogoni.mama-mboga`, `grogoni.mama-mboga-2`, ...) - exactly the disambiguation strategy this task
  asked for.
- The web app and API share the **same Fastify service** on Render (`render.yaml`, `grogoni`,
  `runtime: node`). Fastify can inspect `Host` before serving the SPA, and the service owns both
  `grogoni` and `*.grogoni.com`.

Building a parallel Prisma-shaped `slug`/`SlugHistory` system alongside `grogoniId` would have left
two competing canonical identifiers in the codebase - exactly what the original brief itself warned
against. Per direct confirmation from Julien, this phase **extends `grogoniId` in place** instead.

## 2. What was added, mapped to the original deliverable list

| Deliverable                              | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration for the history/cooldown table | `infra/db/migrations/062_grogoni_id_history.sql` + `infra/db/rollbacks/062_grogoni_id_history.down.sql` - `cp2_grogoni_id_history`, additive only, no change to any existing table (`business.grogoniId` already existed and needed no schema change).                                                                                                                                                                                                                                                                                                                        |
| `slugify()` + tests                      | Already existed as `createGrogoniHandle` (`services/api/src/cp2/text-normalization.ts`) - **unchanged**, since it already does everything the brief's `slugify()` asked for (NFKD normalize, strip marks, lowercase, collapse non-alnum runs to one hyphen, trim edge hyphens, 48-char cap - safely under the 63-char DNS limit). Tests: `tests/grogoni-id-slug-system.test.ts` ("createGrogoniHandle - the slugify function" suite), covering every case the brief named (`Mama's Kitchen`, `Café Nyayo`, `Duka la Simu #2`, all-symbols/empty, over-length, reserved-word). |
| Reserved word blocklist                  | `reservedGrogoniHandles`/`isReservedGrogoniHandle` (`text-normalization.ts`) - derived from real routes found in this repo (every top-level `services/api` and `apps/web` path segment, `api`/`www`, and the new `s` short-link prefix itself), not guessed.                                                                                                                                                                                                                                                                                                                  |
| Collision/disambiguation + tests         | Already existed (numeric suffix, `createGlobalShopId`) - extended to also reject reserved handles and enforce a minimum length (`minimumGrogoniHandleLength = 2`), and to treat an in-cooldown history entry as unavailable. Tests: "grogoniId generation and collisions" suite, including the literal "3rd Mama Mboga" case.                                                                                                                                                                                                                                                 |
| `resolveStoreBySlug()` + tests           | `Cp2Store.resolveBusinessByGrogoniId()` (`store.ts`) - the one shared resolver. Returns `{status:"active", business}` / `{status:"stale", business, redirectTo}` / `null`, exactly the brief's three-state contract (renamed to this codebase's vocabulary: `business` not `store`). Tests: "resolveBusinessByGrogoniId" suite - active, stale, released-then-reclaimed, never-existed.                                                                                                                                                                                       |
| Web middleware wired to the resolver     | See §4 - genuinely blocked on infra, not skipped silently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Telegram bot wired to the resolver       | See §7.1 - deliberately not done this phase, with a precise reason and integration point named.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `getStoreLinks()`                        | `packages/shared-types/src/store-links.ts` - pure, takes explicit `{webOrigin, telegramBotUsername}` rather than reading `process.env`/`window.location` itself, so it runs identically on the API and the web app.                                                                                                                                                                                                                                                                                                                                                           |
| Rename endpoint + cooldown job           | `PUT /businesses/:businessId/grogoni-id` (`services/api/src/cp2/routes.ts`) + `Cp2Store.renameGrogoniId()`; cooldown job is `services/api/src/cp2/grogoniid-cooldown-runner.ts`, mirroring the existing `notification-delivery-runner.ts` pattern exactly (plain `setInterval`, no new scheduler infra).                                                                                                                                                                                                                                                                      |
| Migration/backfill plan                  | See §6 - there is nothing to backfill, confirmed rather than assumed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 3. The shared resolver and where it's used

`Cp2Store.resolveBusinessByGrogoniId(grogoniId)` is the one place every channel resolves a grogoniId:

- `GET /s/:slug` (the new universal fallback route, `routes.ts`) calls it directly.
- The rename endpoint calls it (equality check to allow a no-op "rename" to the current handle).
- Any future channel adapter (Telegram, WhatsApp) is expected to call it too - see §7.1 for why
  Telegram isn't wired yet.

**What was _not_ converged onto it, and why**: `requirePublicStorefrontBusiness`
(`services/api/src/cp2/storefront-access.ts`) is a pre-existing, separate, active-only lookup used
by 5 internal call sites (`store.ts`, `sales/store.ts` ×2, `messaging/store.ts` ×2) for the
already-established public storefront product/customer-care/order endpoints. It was **not**
refactored onto the new resolver. Reasoning: those call sites are internal API endpoints serving an
already-resolved path, not new channel entry points in the sense this task's brief meant (web
subdomain, Telegram, future channels); they have no need for stale/cooldown awareness (a request to
a retired grogoniId there should keep 404ing, exactly as before); and converging them would require
threading a `grogoniIdHistory` reference through `sales`/`messaging` domain `Deps` interfaces across
multiple files - a broader, separately-reviewable change than this task's actual scope. Flagging
this explicitly rather than silently leaving "two versions" unremarked: there are now two
lookups (`requirePublicStorefrontBusiness`, unchanged, active-only; `resolveBusinessByGrogoniId`, new,
active+stale-aware) serving genuinely different call sites with genuinely different needs, not one
lookup accidentally duplicated.

## 4. Web subdomain support: code is done, one real infra step remains

`getStoreLinks().web` produces `https://{handle}.grogoni.com` (the underlying grogoniId's `grogoni.`
prefix is stripped here specifically - `grogoni.mama-mboga` becomes `mama-mboga.grogoni.com`, not
`grogoni.mama-mboga.grogoni.com`). `services/api/src/app.ts` has a root-level `onRequest` hook that
resolves that Host to a business via the same `resolveBusinessByGrogoniId` every channel uses and
302-redirects to the real storefront (`https://grogoni.com/agent/{grogoniId}`), 404ing for a handle
that never existed. It excludes `grogoni`, `api.grogoni.com`, and `www.grogoni.com`, this
deployment's fixed domains. Tests: `tests/store-subdomain-redirect.test.ts`, simulating the real traffic by
setting the `Host` header directly on `app.inject()` calls (active handle, retired/in-cooldown
handle, never-existed handle, and confirming the apex/`api`/`www`/unrelated hosts are left alone).

**What still doesn't work in production, and why it's not something this repo can fix alone**:
`render.yaml` registers both `grogoni` and `*.grogoni.com` on `grogoni`. The remaining
cutover step is DNS: point the wildcard record at Render and complete custom-domain verification.
Until that happens, `GET /s/:slug` remains the universal fallback for QR codes and flyers.

## 5. Rename flow and cooldown

`renameGrogoniId` (`store.ts`) validates the new handle (length, charset, reserved-word check, then
`hasGlobalShopId` which also checks in-cooldown history), moves the old `grogoniId` into
`grogoniIdHistory` with `releasedAt: null`, and updates `business.grogoniId`. `grogoniid-cooldown-runner.ts`
periodically (default hourly, `GROGONI_ID_COOLDOWN_RUNNER_INTERVAL_MS`) calls
`releaseExpiredGrogoniIds({cooldownMs})` (default 30 days, `GROGONI_ID_COOLDOWN_MS` - the brief's own
proposed default, used since nothing more specific was given), which sets `releasedAt` on any
history entry old enough, freeing the handle. Both runner settings and the runner itself can be
disabled via `ENABLE_GROGONI_ID_COOLDOWN_RUNNER=false`, matching the existing runners' convention
exactly.

While in cooldown (`releasedAt === null`), the old grogoniId resolves as `"stale"` with a
`redirectTo` pointing at the business's current grogoniId - `GET /s/:slug` turns this into a 410 with
the new location in the body (not a silent 404), matching the brief's explicit instruction.

## 6. Migration/backfill: there is nothing to backfill

Every business has always had a `grogoniId` - `createGlobalShopId` runs unconditionally inside
`createBusiness`, so no business created before this phase lacks one. This phase adds no new
required field to `BusinessSummary` itself (only a new, empty-by-default history table), so there
is no existing-row migration to run, dry or otherwise. Confirmed directly, not assumed: every
existing business's `grogoniId` continues to resolve exactly as it did before this phase, and the new
`cp2_grogoni_id_history` table starts and stays empty until the first real rename happens.

## 7. Test results

New/extended files: `tests/grogoni-id-slug-system.test.ts` (25 tests: slugify cases, reserved words,
generation/collision including "3rd Mama Mboga", the shared resolver's three states, rename
validation, cooldown release, idempotency), `tests/grogoni-id-routes.test.ts` (6 tests: the universal
redirect route's active/stale/never-existed responses over real HTTP via `buildApi`, the rename
endpoint's success/conflict/authorization-failure responses), `tests/grogoni-id-history-migration.test.ts`
(3 tests: additive-only SQL, scoped rollback, generic-mechanism registration), `tests/grogoniid-cooldown-runner.test.ts`
(3 tests, mirroring `notification-delivery-runner.test.ts`'s exact pattern), `tests/store-links.test.ts`
(5 tests: link shapes, empty-telegram-when-unconfigured, trailing-slash handling, consistent
encoding, no whatsapp field). All 42 pass.

```
npx vitest run tests/grogoni-id-slug-system.test.ts tests/grogoni-id-routes.test.ts \
  tests/grogoni-id-history-migration.test.ts tests/grogoniid-cooldown-runner.test.ts tests/store-links.test.ts
Test Files  5 passed (5)
     Tests  42 passed (42)
```

Full repo suite was run for regression-checking. This working tree currently has substantial
unrelated, uncommitted, in-progress work from a separate session (an MCP integration feature,
touching many domain-store files) - two things worth stating plainly rather than glossing over:

- `tests/user-purge-script.test.ts` currently fails, but not because of this phase: the other
  session added a `cp2_native_runtime_agents` collection to `postgres-store.ts`'s
  `normalizedCollections` without adding a purge-manifest classification for it. This phase's own
  new table (`cp2_grogoni_id_history`) **is** correctly classified (`scripts/purge-all-users.sql`) and
  the test's hardcoded counts were updated to match (159→160, 154→155) - confirmed by re-running
  the test and seeing the failure name the other session's table, not this phase's.
- A full project-wide `tsc --noEmit` currently reports 2 errors in `services/api/src/cp2/domains/native-runtime/store.ts`,
  also from that same in-progress, uncommitted work - unrelated to any file this phase touched.
  Every file this phase actually modified typechecks clean in isolation.

## 8. Explicit gaps (named, not silently skipped)

1. **Telegram `/start` deep-link resolution is not wired up.** `TelegramChannelAdapter.normalizeInbound`
   (`services/api/src/messaging/channel-gateway.ts:524`) already parses `/start <param>` - but the
   captured value (`linkToken`) is consumed by a _different_, security-sensitive, pre-existing
   feature: a per-customer, single-use, hashed, expiring channel-identity-link grant
   (`services/api/src/cp2/domains/messaging/store.ts:1877-1910`, `channelIdentityLinkGrants`) for
   linking an _already-known_ customer's Telegram account to an existing conversation - not for a
   stranger discovering a business by its public handle. The existing token length constraint
   (`{16,200}` chars) doesn't reliably distinguish "real link token" from "grogoniId handle" (handles
   can legitimately exceed 16 chars), so safely disambiguating the two at the parsing layer is a
   real design decision, not a mechanical wiring change - and building a _new_ "anonymous stranger
   starts a fresh conversation with business X" bootstrap flow (what a cold `/start <handle>` would
   actually need to do something more useful than an acknowledgement reply) is its own
   product-and-security-sensitive feature. Rather than rush a change into that specific
   grant-consumption code path under this task's time budget, the exact integration point is named
   precisely: extend `normalizeInbound`'s regex to also capture a shorter grogoniId-shaped param
   distinctly from `linkToken`, then in `messaging/store.ts`'s `ingestChannelWebhook` (right where
   the `grant === undefined` 401 currently throws), fall back to
   `store.resolveBusinessByGrogoniId(...)` before failing, and reply via the channel gateway's
   `sendMessage` rather than creating a channel link. `getStoreLinks().telegram` (the _generation_
   side) is done and tested; this is only the _receiving_ side.
2. **`getStoreLinks().web` (the `{handle}.grogoni.com` subdomain) doesn't resolve today** - see §4.
   The API-side resolve-and-redirect hook is implemented and tested; what's missing is a real
   production DNS/Render custom-domain change outside this repository, not a code gap.
