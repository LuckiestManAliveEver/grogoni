# Local-First Cloud Audit

Status: implementation inventory for `GROGONI_RUNTIME_MODE=local`.

## KEEP_REQUIRED

- Neon Postgres: `DATABASE_URL`/`DIRECT_DATABASE_URL`; durable catalogue, accounts, runtime metadata, and business state remain Postgres-backed.
- GitHub: source control only, not an application runtime dependency.

## KEEP_OPTIONAL

- Local computer/browser automation can be reintroduced later as a localhost-only process. No remote computer runtime is supported.

## REPLACE_LOCAL

- Vercel inference: previous `VERCEL_INFERENCE_URL`/`GROGONI_INFERENCE_SERVICE_TOKEN` API-to-ai-runtime path is replaced in local mode by direct Ollama access.
- Hosted/model object storage: `NEON_MODEL_STORAGE_*` is bypassed in local mode; Ollama owns local model files.
- Redis/render key-value: replaced by process memory for local rate-limit and transient inference counters with `LOCAL_CACHE_MODE=memory`.
- OCR worker runtime: removed from API infrastructure. OCR may return later only as a model/tool capability that supplies trusted extracted text.

## REMOVE

- Runtime support for Render services, Render private hostnames, Render deploy webhooks, hosted Redis, hosted OCR, local OCR worker, hosted ZeroClaw, Vercel AI runtime, remote inference relay, Neon model object storage, OpenAI, Anthropic, Z.ai, Gemini, Hugging Face hosted inference, hosted llama.cpp, and paid/provider-routed cloud inference.
- Cloud/provider env vars now fail fast at API boot instead of being interpreted as optional integrations.
- Failed Ollama inference reports local unavailability rather than falling back to any hosted provider.

## HISTORICAL_ONLY

- `render.yaml`, `deployment.md`, `.do/inference.yaml`, `docs/deployment/**`, `docs/runtime/vercel-inference-audit.md`, and `services/ai-runtime/**` are historical/retired artifacts and are no longer part of the active workspace or local runtime.

## Findings By Area

- Boot-time cloud dependencies: `services/api/src/config.ts` previously made `VERCEL_INFERENCE_URL` canonical when `INFERENCE_REQUIRED=true`, required `NEON_MODEL_STORAGE_*` when Vercel was configured, and defaulted Redis in non-production. Local mode now makes Ollama the only inference provider and memory the only cache mode.
- Runtime cloud dependencies: provider integrations are removed from API startup. `OPENAI_*`, `ANTHROPIC_*`, `ZAI_*`, `HF_*`, `VERCEL_*`, `ZEROCLAW_*`, `REDIS_URL`, Render webhook, and remote computer runtime variables are rejected.
- Build-time cloud dependencies: Vercel/Render docs and scripts remain historical/production. Local build should not require cloud credentials.
- Health/readiness dependencies: readiness may require inference only when `INFERENCE_REQUIRED=true`; local inference health checks Ollama `/api/tags`.
- Frontend dependencies: development should use localhost API configuration or Vite proxy; hard-coded `grogoni` references are brand/public URL defaults and production docs unless used for runtime API calls.
- Inference dependencies: local runtime uses `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, and `LOCAL_INFERENCE_TIMEOUT_MS`; Vercel and Neon artifact storage are not part of local mode.
- Authentication dependencies: localhost origins must be allowed through `WEB_ORIGINS`; cookies should use `COOKIE_SECURE=false` in local env.
- OCR dependencies: no OCR worker is configured or started by the API. Receipt/product tools can still use caller-supplied extracted text.
- Caching/rate-limit dependencies: `LOCAL_CACHE_MODE=memory` avoids Redis for local startup.
- Object-storage dependencies: conversation/file storage remains separate; model artifact object storage is bypassed locally.
- Agent-runtime dependencies: built-in Grogoni runtime remains available; ZeroClaw is optional.

## Boot time and write amplification against Neon

Local mode keeps Neon as the only remote dependency, so every database round trip at boot pays
the full network latency (~350ms per round trip measured to `us-east-2`). Measured boot to
`Server listening` (`pnpm dev:local`, 2026-10-02):

| Step                                 | Before                                   | After                                                                                                                                               |
| ------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized collections (~147 tables) | one query per table, ~50s                | one `union all` of `jsonb_agg(record order by entity_id)`, ~3.5s                                                                                    |
| Relational core (~24 tables)         | sequential, ~7s                          | concurrent over the pool, ~2-4s                                                                                                                     |
| Pool connections                     | opened one by one as queries needed them | a short-lived boot pool is warmed concurrently, used for the migration check and snapshot load, then closed, so no extra idle connections stay open |
| Fulfillment schema check             | after store hydration                    | alongside store hydration                                                                                                                           |
| Total                                | ~90s                                     | ~24-29s                                                                                                                                             |

What remains is mostly fixed cost: ~7.5s of `tsx` compile in dev, ~5s of inference schema check
and provider refresh, and one TLS connection setup per pool.

Persistence re-sends whole collections on every save. Every hot-path upsert in
`services/api/src/cp2/postgres-store.ts` now ends with `where (...) is distinct from (excluded...)`,
so unchanged rows produce no new row version. Before that guard, `account_sync_changes` had
22,248 inserts and 584 million updates, and its heap grew to 379 MB for ~15 MB of live data;
`sessions` had 10 million updates on 703 rows. Session retention triggers still apply because they
fire `before insert or update` and stamp the proposed row; the guard ignores the trigger's revocation
timestamp once both the stored and proposed rows carry the `expired` revocation, otherwise every
expired session would be rewritten on every save.

The guard stops new bloat but does not return space already used. `VACUUM FULL
account_sync_changes` reclaims it, and it takes an exclusive lock on the table while it runs.

Regression coverage: `tests/normalized-snapshot-sql.test.ts` (gate) and the Postgres-gated cases in
`tests/cp2-postgres-store.test.ts` (single-query load parity, unchanged sync rows keep their `xmin`,
expired sessions revoked once and then left alone).

## Session retention followed the access token, not the refresh lifetime

Migration 038's retention trigger revoked a session on any write once `expires_at` had passed.
Since 036/045 that column is the ~15 minute access token; a session stays refreshable until the
earliest of `refresh_expires_at`, `inactivity_expires_at` and `absolute_expires_at` (30 days of
inactivity by default). Because persistence rewrote sessions on every save, each session was
stored as revoked shortly after its access token expired. Running processes kept the in-memory
copy, so nothing looked wrong until a restart: sessions then loaded as revoked and
`/auth/session/refresh` answered `auth_refresh_revoked`. On 2026-10-02 the Neon database had
0 of 418 sessions unrevoked, so every restart signed everyone out.

Migration `106_session_retention_uses_refresh_lifetime.sql` makes both retention triggers use the
refreshable lifetime and restores sessions the old trigger revoked while still refreshable
(76 sessions across 36 accounts in Neon, plus their `cp2_sessions` compatibility rows). The API
refuses to boot until 106 is applied. The rollback restores the old functions and never
re-revokes restored sessions.

## Normalized collection saves are batched

`saveCollectionRecords` sent one `insert ... on conflict` per record, so saving a large
collection cost one round trip per row (`cp2_audit_events`, ~1,400 rows, is minutes at ~350ms
per round trip). It now sends one multi-row upsert per 1,000 rows. A plain `VALUES` list lets
Postgres type each parameter from its target column. Repeated entity ids are collapsed to the
last record first, matching the old loop's last-write-wins behavior, since a multi-row upsert
rejects repeats.
