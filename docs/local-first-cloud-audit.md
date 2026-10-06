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

## Migration 108: retiring hosted-runtime data

Code-level removal (hosted providers, BYOK keys, ZeroClaw, the Vercel client) leaves rows in
existing databases that still point at the retired runtime. `infra/db/migrations/108_local_first_runtime_cleanup.sql`
moves them onto local Ollama:

| Before 108                                                                     | After 108                                                                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Global default slot: GPT-6 Luna primary on `builtin:provider-router:v1`        | SmolLM2 360M primary on the global `local` host (the exact rows `activateGlobalDefaultModel` writes) |
| Encrypted BYOK keys in `inference_provider_credentials`                        | Deleted (irreversible by design; nothing can read or revoke them any more)                           |
| Agents and catalog entries with `runtimeAdapterId: "zeroclaw"`                 | `grogoni` (the code also maps stored `zeroclaw` at load time)                                        |
| Hosts of type `backend`/`vercel`; models `gpt-6-luna`, `openai-*`, `qwen3-4b*` | Hosts `disabled`, models `inactive`, catalog rows `available: false` and inference disabled          |
| Shop binding whose primary used those hosts/models, with a surviving fallback  | First enabled fallback promoted to primary                                                           |
| Shop binding left with no usable primary                                       | `inactive`; the next turn provisions a fresh local binding through the zero-setup path               |

It is idempotent. Before changing anything it copies every runtime and catalog row it may touch into
`migration_108_backup` (first run only; the deleted keys are deliberately not copied). The rollback
(`infra/db/rollbacks/108_local_first_runtime_cleanup.down.sql`) restores those rows, removes the
global local rows 108 created, and drops the backup; it cannot restore the deleted keys, and it is
only valid together with reverting the application code. It assumes `PLATFORM_DEFAULT_MODEL_ID` is
`smollm2-360m` (the model `services/api/src/index.ts` registers the Ollama adapter for).

Runbook (Neon or any existing database):

1. Make sure nothing runs migrations automatically. `render.yaml` still declares an auto-deploying
   service whose build runs `pnpm db:migrate` while the previous instance keeps serving; if that
   Render service is still linked, suspend it before 108 reaches `main`.
2. Stop every API process. A running API re-saves its in-memory snapshot and would write the old
   rows back over the migration.
3. Snapshot the rows 108 touches:
   `pg_dump "$DIRECT_DATABASE_URL" --data-only -t inference_provider_credentials -t cp2_native_runtime_agents -t cp2_agent_catalog -t cp2_native_runtime_models -t cp2_native_execution_hosts -t cp2_native_model_installations -t cp2_native_runtime_bindings -t cp2_native_runtime_binding_models -t cp2_model_catalog -t cp2_external_registry_connections > /tmp/grogoni-108-snapshot.sql`
4. `PGOPTIONS='-c grogoni.allow_108=yes' pnpm db:migrate`, then start the API. Without the flag 108
   raises before changing anything (and the runner stops), so an auto-deploy or a stray
   `pnpm db:migrate` cannot run it.

Ollama model naming: the API calls Ollama with `OLLAMA_MODEL` (default `smollm2:360m`), while the
`smollm2-360m` catalog and native-runtime rows describe `smollm2:360m-instruct-q4_0`. Both tags are
SmolLM2 360M Instruct; the eval report records the `OLLAMA_MODEL` actually used.

Regression coverage: `tests/local-first-runtime-migration.test.ts` (Postgres-gated) rebuilds the
pre-108 state (GPT-6 Luna global default, a self-healed shop, a stranded shop, a ZeroClaw shop agent
and a stored key), applies 108 twice, boots a fresh store with only the Ollama adapter, sends a turn
for each shop and flushes, then applies the rollback, checks the pre-108 graph is back, boots the
current code on it (a regression for shop bindings marked isDefault, which Postgres rejects and
which used to fail every later save), and re-applies 108.

## Model quality: SmolLM2 360M fails the model-fallback eval

`pnpm eval:ai` (services/api/scripts/run-ai-eval.ts) runs the platform default on local Ollama and
grades replies with local Claude Code. On 2026-10-05 SmolLM2 360M passed 0/6 scenarios
(threshold 80%): it mostly echoed the system prompt and few-shot examples instead of answering the
merchant. Turns took 15-70s on this machine's CPU. The model is usable as a smoke test of the
runtime, not as a shop assistant; choosing a larger Ollama model is an open product decision.

Same day, qwen2.5:3b scored 3/6, but one pass copied a few-shot example: the prompt's KRA tax example
matched the eval's out-of-scope scenario almost word for word. With that example replaced (and
`tests/runtime-model-few-shot-examples.test.ts` now failing on any example that overlaps a
scenario) plus explicit "when not to call a tool / answer in the merchant's language" rules,
SmolLM2 stayed at 0/6 and qwen2.5:3b scored 1/6 (52-154s turns). Six scenarios are too few to
separate prompt effects from judge variance (one scenario flipped on an identical reply). The
platform default stays SmolLM2 360M: neither model is adequate, and SmolLM2's replies show it
treating the assembled system text as content to grade or repeat, so the next lever is how agent
instructions are placed in the prompt, then a larger eval set.

The agent's trusted instructions (platform rules, identity, business policy, personality, tools,
output rules) used to be concatenated into the user turn together with the merchant's message.
They now go in the system message (`RuntimeModelPrompt.agentInstructions`); untrusted retrieved
context, recall and memory stay in the user turn, delimited, so they never gain system authority.
With that split, qwen2.5:3b scored 2/6 (it stopped parroting few-shot reasons and now asks for
missing details) and SmolLM2 stayed at 0/6, now reciting the system prompt back: it cannot follow a
system prompt of this size. Across all three prompt versions qwen2.5:3b led (3, 1, 2 vs 0, 0, 0)
at roughly 3x the latency on this machine. Open quality gaps: it overclaims ("I can help you file
your tax returns with KRA"), ignores delivery questions, and re-asks for details already given.

`.github/workflows/ai-eval.yml` is manual-dispatch only: hosted runners have neither Ollama nor
Claude Code, so a nightly run could only skip and report green. Run `pnpm eval:ai` on a machine with
both (set `GROGONI_CLAUDE_BIN` if `claude` is not on PATH) before a ship.

## Switching models from the model tab

Every model installed in the Ollama at `OLLAMA_BASE_URL` appears in the model tab (Settings ->
Model & inference -> Open model library, and the quick switcher) as `<tag> (local)`, with id
`ollama-<tag>` (`services/api/src/inference/ollama-model-catalog.ts`). Clicking "Use with agent"
tests and activates it for that shop; there is no cost step, because local models have no usage
bill (`isPlatformIncludedModel`). The API re-reads Ollama every 30 seconds, so a model installed
with `ollama pull <tag>` shows up without a restart. The configured `OLLAMA_MODEL` keeps serving the
platform default and is not listed twice.

Before this, a Postgres-backed API forwarded only a hand-picked subset of store options, silently
dropping the local model catalog, the configured platform default runtime, the messaging channel
gateway, the connected-mailbox client and the workspace settings. It now forwards all of them
(`tests/local-model-switching.test.ts` covers this against Postgres).
