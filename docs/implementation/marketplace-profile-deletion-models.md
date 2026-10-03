# Implementation map

## Existing architecture reused

- React/Vite shell: `apps/web/src/main.tsx`, `apps/web/src/app-shell.ts`, `apps/web/src/styles.css`
- Fastify routes and domain store: `services/api/src/cp2/routes.ts`, `services/api/src/cp2/store.ts`
- PostgreSQL compatibility persistence: `services/api/src/cp2/postgres-store.ts`
- Shared contracts: `packages/shared-types/src/index.ts`
- Render services and cron jobs: `render.yaml`

No parallel application or authentication service is introduced.

## Auth flow

The initial no-shop/no-owner state no longer sets `shouldShowSignup`. Marketplace remains visible.
Selecting Sell opens the existing setup surface in this order:

1. Email verification or phone-plus-PIN account creation.
2. Passkey enrollment and four-digit owner PIN creation where required.
3. Compulsory unverified owner phone capture.
4. Business name and language.
5. Existing `POST /businesses` creation and seller-mode activation.

The account icon opens PIN login. Normal login calls `POST /auth/pin/login` directly. Email OTP is
available for email verification and recovery; phone OTP routes are rejected. First-shop phone
capture calls `PUT /account/phone` and does not send an SMS.

## Marketplace and agent profile

The intro card is inserted after the stable welcome message. Anonymous completion uses a versioned
local marker; authenticated completion is mirrored through:

- `GET /v1/marketplace-intro`
- `POST /v1/marketplace-intro/complete`

The state is included in `Cp2Snapshot` and PostgreSQL normalized persistence. The chat agent name is
a native button and routes to the existing `AgentProfileSurface`.

## AI models

The curated server registry is exposed by `GET /v1/ai-models`. Public GitHub release discovery is
exposed separately by `GET /v1/ai-models/github`; it filters for Apache-2.0 repositories and
Android-sized GGUF release assets before the frontend applies device-fit ranking. Cloud fallback
selection uses:

- `GET /businesses/:businessId/ai-model`
- `PUT /businesses/:businessId/ai-model`

Selection requires `membership:manage`, a downloaded model that has passed local test inference,
and an available hosted OpenAI profile. It records an audit event and persists separately without
replacing the device-bound model. There is no implicit OpenAI default, `CLOUD_ONLY` inputs are
normalized to `LOCAL_FIRST`, and hosted profiles remain unavailable until the server has an
allow-listed model and `OPENAI_API_KEY` configuration. Users never provide API keys.

## Deletion and restore

Deletion routes are:

- `GET /businesses/:businessId/shop-deletion/preview`
- `POST /businesses/:businessId/shop-deletion/request`
- `POST /businesses/:businessId/shop-deletion/:requestId/finalize`
- `POST /businesses/:businessId/shop-deletion/:requestId/restore`

Finalize verifies the owner PIN and places the tenant in `QUARANTINED` for 30 days. Quarantined
shops are excluded from account shop lists and business authorization returns HTTP 410. Restore
removes that guard before expiry. `pnpm db:purge-shops` permanently removes expired tenant data;
Render runs it daily as `grogoni-shop-purge`.

Migration `020_marketplace_deletion_models.sql` adds normalized persistence tables and the deletion
archive manifest table. PostgreSQL startup now requires migration 020.

## Deployment

1. Apply migrations with `pnpm db:migrate`.
2. Confirm no obsolete Firebase phone-auth variables remain on the API or web service.
3. Deploy API and web from the same commit.
4. Confirm the `grogoni-shop-purge` cron has both database URLs.
5. Smoke test anonymous Marketplace, first Sell, email signup, phone-plus-PIN login, compulsory
   phone capture, model activation, quarantine, and restore.
