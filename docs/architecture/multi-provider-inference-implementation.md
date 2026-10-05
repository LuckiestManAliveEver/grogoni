# Multi-provider inference: implementation report

> **Historical.** The hosted providers, BYOK keys and Grogoni Cloud described here were removed
> with the local-first runtime ([docs/local-first-cloud-audit.md](../local-first-cloud-audit.md)).
> Only the device-local provider and the router's budgets, fallback policy and run telemetry remain.

This change lets Grogoni agents run on models from OpenAI, Anthropic, Z.ai (GLM), Grogoni-hosted
llama.cpp, any other OpenAI-compatible server, or the device itself. It does this without new
agents, without vendor branches in agent code, and without a second model registry. The Phase 0
audit that shaped these decisions is
[multi-provider-inference-audit.md](./multi-provider-inference-audit.md).

```text
                        GROGONI CHAT
                            │
                            ▼
                       GROGONI AGENT            (pi / grogoni AgentRuntimeAdapter - unchanged)
                            │
                            ▼
                    AGENT MODEL BINDING      (cp2_native_runtime_bindings - unchanged)
                            │
                            ▼
                    INFERENCE ROUTER         (services/api/src/inference/providers)
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
          ▼                 ▼                  ▼
    REMOTE APIs        GROGONI-HOSTED          LOCAL
          │                 │                  │
   ┌──────┼──────┐     llama.cpp          Browser /
   │      │      │         │              Device
 OpenAI Claude  GLM     Qwen/SLM              │
                                               ▼
                                             SLM
```

The hierarchy is preserved: Agent → Model Binding → Model → Provider → Execution Target →
Execution Host. No layer is merged into another.

## 1. Repository audit findings

See the [audit](./multi-provider-inference-audit.md). In short, the repository already had most of
the structure the brief asks for:

- a provider-neutral native graph of agents, bindings, models, hosts and installations;
- one model-execution seam, `ModelRuntimeAdapter`, looked up by `executionTarget:modelId`;
- an operator-editable DB catalog (`cp2_model_catalog`);
- encrypted credential storage (`ExternalConnectionsDomain`);
- a structured tool-proposal protocol with confirmation gates;
- the RuntimeHandoff checkpoint protocol.

What was missing:

- a provider layer for hosted APIs (the old OpenAI adapter had been deleted);
- BYOK for anything except Hugging Face;
- usage and cost telemetry, budgets, and an explicit fallback policy;
- an SSRF policy for model endpoints;
- a provider settings UI.

No agent called a vendor directly, so no agent code needed to be removed.

## 2. Architecture implemented

| Layer              | Where                                                                         | Notes                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical contract | `inference/providers/contract.ts`                                             | Implements the brief's `InferenceRequest`, `InferenceResponse`, `InferenceChunk`, `InferenceProvider`, `ProviderHealth` and `ModelDefinition`. Target/capability/pricing types live in `@grogoni/shared-types`. |
| Normalized errors  | `inference/providers/errors.ts`                                               | `InferenceError` extends the existing `ModelRuntimeError`, so the chat pipeline handles it unchanged. Codes are registered in `normalizeInferenceErrorCode`.                                                    |
| Provider adapters  | `openai-compatible-provider.ts`, `anthropic-provider.ts`, `local-provider.ts` | Covered in §4.                                                                                                                                                                                                  |
| Provider registry  | `provider-registry.ts`, `environment.ts`                                      | The one map from provider _type_ to adapter. Config merge order: built-ins < `inference_providers` rows < environment.                                                                                          |
| Model registry     | `AiModelSummary.inference` in `cp2_model_catalog`                             | `model-definitions.ts` projects a catalog row into a `ModelDefinition`. There is no second registry.                                                                                                            |
| Credentials        | `credentials.ts`, `connections.ts`, `cp2/secret-box.ts`                       | Covered in §5–6.                                                                                                                                                                                                |
| Router             | `inference-router.ts`                                                         | Runs the 13-step resolution sequence, fallback policy, budgets, per-provider circuit breaker, usage recording and metrics.                                                                                      |
| Agent integration  | `routed-model-adapter.ts`, `platform.ts`, `Cp2Store`                          | The router is exposed as a `ModelRuntimeAdapter` on the `backend` target. `Cp2Store` composes it after any adapter from `modelRuntimeAdapterResolver`.                                                          |
| HTTP API           | `cp2/domains/inference-providers/routes.ts`                                   | Covered in §13 (API).                                                                                                                                                                                           |
| UI                 | `apps/web/src/AiProvidersPanel.tsx`, `ai-providers-view.ts`                   | Settings → AI providers. Lazy-loaded.                                                                                                                                                                           |

### Why providers are reached through a `ModelRuntimeAdapter`

The whole chat path already works through `ModelRuntimeAdapter`: native binding resolution, the
agent adapters, fallback roles, the handoff swaps, and activation health checks. The router plugs
in as one more adapter (`createRoutedModelRuntimeAdapter`), so none of those had to change. The
adapter:

- turns `RuntimeModelPrompt` into canonical chat messages (the system instructions are the same
  `buildInferenceInstructions` every other model gets);
- calls `router.generate`;
- turns the canonical output back into the runtime's JSON text.

### Resolution sequence (`InferenceRouter.resolveInferenceTarget` + `generate`)

1. Validate agent.
2. Use the binding's model id, or `INFERENCE_DEFAULT_MODEL`.
3. Resolve the model from the catalog.
4. Check the model is enabled.
5. Resolve the provider.
6. Check the provider is enabled.
7. Check required capabilities (tools, structured output, vision).
8. Resolve the credential.
9. Resolve the execution target (client-only targets stop here).
10. Check runtime availability (the provider's circuit breaker is not open).
11. Execute.
12. Normalize (inside the adapter).
13. Record usage and metrics.

Each step fails with its own code before any network call. The model is never changed silently.

## 3. Database migrations

`infra/db/migrations/101_multi_provider_inference.sql` is purely additive. It uses
`create table if not exists` and `create ... index if not exists`, so it is idempotent. Rollback
is `infra/db/rollbacks/101_multi_provider_inference.down.sql`.

| Table                            | Purpose                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inference_providers`            | Operator overrides and extra provider instances. `credential_ref` is checked to be `env:NAME` or `secret://<uuid>`, never a raw secret.                                                                            |
| `inference_provider_credentials` | BYOK and platform credentials. Owner-scope check. A partial unique index allows one ACTIVE key per owner and provider. A check allows only the encrypted-envelope format. A `REVOKED` row must have a null secret. |
| `inference_runs`                 | Usage telemetry: tokens, cost, latency, status, fallback. There are no prompt or output columns.                                                                                                                   |
| `inference_policies`             | Budgets, per-minute and per-request limits, and the explicit fallback policy, at global, tenant or user scope.                                                                                                     |

The four brief-suggested model columns (`provider_id`, `provider_model_id`, `execution_target`,
`capabilities_json`, `pricing_json`, `enabled`) did not need a DDL change. They live in the
catalog row's JSON record as the `inference` block, and older builds ignore that block.

The owner columns have no foreign keys on purpose: CP2 business and account rows are written by
the asynchronous snapshot flusher. Instead, account and shop deletion call
`InferencePlatform.purgeOwner`.

## 4. Provider adapters added

| Adapter                          | Wire protocol                                                      | Notes                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createOpenAiCompatibleProvider` | `POST {base}/chat/completions`, `GET {base}/models`, SSE streaming | Serves llama.cpp, vLLM, LocalAI, SGLang and gateways. Handles tool calls (names are encoded `products.list` ↔ `products__list`), `response_format`, usage including cached tokens, request id, timeout, cancellation. |
| `createOpenAiProvider`           | same                                                               | Differs only in configuration: the default base URL and `max_completion_tokens`. No model ids appear in code.                                                                                                         |
| `createZaiProvider`              | same                                                               | Defaults to the general endpoint `https://api.z.ai/api/paas/v4`. Verifies keys with a 1-token completion.                                                                                                             |
| `createAnthropicProvider`        | `POST {base}/messages`, `GET {base}/models`, SSE events            | All Anthropic semantics stay inside the adapter: top-level `system`, `tool_use`/`tool_result` blocks, `input_schema`, role-alternation merging, `x-api-key`, `anthropic-version`, stop-reason mapping.                |
| `createLocalInferenceProvider`   | none                                                               | Server-side placeholder for client-executed models. `generate()` always refuses with `LOCAL_EXECUTION_REQUIRED`.                                                                                                      |

Provider-specific response objects never leave the adapters.

The official REST APIs are called with `fetch`-style transport, not vendor SDKs. There are three
reasons:

- one SSRF-guarded transport covers every provider;
- no new supply-chain dependencies are added to the Render API;
- the audit (§3.4) found no SDK already in the repository.

## 5. Credential architecture

- **Storage:** credentials are encrypted with AES-256-GCM using the API's existing envelope and key
  (`AUTH_TOKEN_ENCRYPTION_KEY` / `OAUTH_TOKEN_ENCRYPTION_KEY`). The helpers moved from `oauth.ts`
  to `cp2/secret-box.ts`, and `oauth.ts` re-exports them unchanged, so there is still a single
  secret subsystem. `key_version` is stored for future rotation.
- **In memory:** a decrypted key lives only inside `SecretValue`, which prints `[REDACTED]` for
  `String()`, `JSON.stringify` and `util.inspect`. The only place it is revealed is where an adapter
  builds a request header.
- **Grogoni-managed keys:** read from the environment once at boot into `managedSecrets`, and
  referenced by `credentialRef: "env:NAME"`. They can also be platform-scoped encrypted rows
  (`secret://<id>`).
- **Precedence** (`CredentialResolver`, deterministic):

  ```text
  explicit request scope → tenant BYOK → user BYOK → Grogoni-managed
  ```

  An explicit scope never falls through to another payer. Tenant and user lookups are exact-owner
  SQL matches, so one tenant can never resolve another's key. Tenant means business (`shopId`);
  user means account (`accountId`), which matches how existing external connections are scoped.

## 6. BYOK flow

1. The owner opens Settings → AI providers and clicks Connect. They choose "This shop" (tenant;
   needs `membership:manage`) or "Just me" (user).
2. `POST /v1/ai/provider-connections` validates the key's format. It validates any custom endpoint
   with the strict SSRF policy, and only for providers configured to allow per-key endpoints.
3. The key is verified with the provider's cheapest safe check: `GET /models` for OpenAI,
   Anthropic and llama.cpp, or a 1-token completion for Z.ai. A key the provider rejects is never
   stored.
4. Any previous ACTIVE key for the same owner and provider is revoked (ciphertext erased), then the
   new key is stored encrypted. The response contains only `{providerId, connected, status,
secretHint: "x7K2", ...}`.
5. The next agent turn resolves the credential by precedence, and the run records
   `credential_scope`.
6. Disconnect sets `REVOKED` and nulls the ciphertext. Test re-verifies the key and marks it
   `INVALID` if the provider now rejects it.

The pre-existing Hugging Face BYOK path (`external-connections` + `billingMode: "own-account"`) is
unchanged.

## 7. Model-selection flow

1. An operator registers a model once, as catalog data, with the existing endpoint:

   ```http
   PUT /v1/platform/model-catalog/claude-sonnet
   {
     "id": "claude-sonnet", "label": "Claude Sonnet", "provider": "anthropic",
     "description": "Anthropic Claude via the Messages API", "capabilities": ["chat"],
     "available": true, "source": "hosted", "format": "remote", "license": null,
     "licenseUrl": null, "modelCardUrl": null, "downloadUrl": null, "fileName": null,
     "fileSizeBytes": null, "minimumMemoryGb": null, "recommended": false, "contextWindow": 200000,
     "inference": {
       "providerId": "anthropic", "providerModelId": "<vendor model id>",
       "executionTarget": "remote-inference",
       "capabilities": { "text": true, "tools": true, "structuredOutput": false, "streaming": true },
       "maxOutputTokens": 4096, "enabled": true,
       "pricing": { "inputPerMillionTokens": 0, "outputPerMillionTokens": 0, "currency": "USD" }
     }
   }
   ```

   Set pricing to the vendor's published prices. Omit it and cost is recorded as `null`, never
   guessed.

2. `GET /v1/ai-models` now returns `hostedExecutionTarget: "backend"` for this model. The composer
   switcher and the model panel activate on that target instead of a hardcoded `"vercel"`.
3. Activation (`POST /api/agents/:agentId/models/:modelId/activate`) health-checks the provider with
   the caller's effective credential, then rewrites the primary role of the shop's binding. The
   binding id, the agent and the conversation are all kept.
4. Mid-task switching goes through the existing `POST /v1/runtime/:taskId/swaps/model`, and the
   checkpoint is carried forward. This is proven in
   `tests/multi-provider-inference-integration.test.ts`.

## 8. llama.cpp configuration

Run `llama-server` anywhere (Render, Hetzner, Oracle, RunPod, own hardware):

```bash
llama-server -m qwen3-4b-q4_k_m.gguf --alias qwen3-4b --api-key "$GROGONI_LLAMA_API_KEY" --host 0.0.0.0 --port 8080
```

Then configure the API:

```env
GROGONI_LLAMA_BASE_URL=https://inference.grogoni.com/v1
GROGONI_LLAMA_API_KEY=...
```

Register a catalog model with `inference.providerId: "grogoni-llama"`,
`providerModelId: "qwen3-4b"` (the `--alias`) and `executionTarget: "remote-inference"`.

Nothing in the code knows which host serves the model. Moving hosts means changing the URL.

A llama-server on a private network next to the API needs `GROGONI_LLAMA_ALLOW_PRIVATE_NETWORK=true`
(and `GROGONI_LLAMA_ALLOW_HTTP=true` for plain http). These are operator-only switches. Additional
compatible hosts are rows in `inference_providers` (`provider_type = 'openai-compatible'`) and need
no code.

## 9. Fallback behavior

- **The default is `NONE`.** A failed provider returns a normalized error, and the conversation and
  its history are untouched. Nothing is sent to another provider.
- **`SAME_PROVIDER`:** the request may move to the listed `fallbackModelIds` of the same provider
  id. `zai-general` and `zai-coding` are different ids, so they are never substitutes for each
  other.
- **`APPROVED_PROVIDERS`:** the request may also move to listed models whose provider is in
  `approvedProviderIds`.

Only provider-side, retryable failures trigger fallback. A policy rejection never does: budget,
rate policy, capability, rejected key, missing key, forbidden endpoint, or a local-only model.

Every attempt is a separate `inference_runs` row, and the fallback run records
`fallback_from_provider_id`. Each attempt is re-admitted against budgets, so a fallback can never
exceed a budget. Policies live in `inference_policies`, scoped tenant, then user, then global.

The native binding's own fallback roles are unchanged and remain explicit, user-configured
activation settings. `POLICY_REJECTED` is a new non-retryable error category, so budget stops and
local-only models never trigger those native fallbacks either.

## 10. Security controls

- Keys are never sent to the browser. Every route returns redacted summaries, and tests assert that
  no response body contains the key, the ciphertext, or the managed key.
- Keys never enter model context. Prompts are built only from the agent's instructions and history;
  credentials travel only in headers, and `request.metadata` is stripped before a provider call.
- Keys never appear in logs, telemetry or errors:
  - `SecretValue` redacts on serialization;
  - `redactSecrets` removes known keys and common key patterns from diagnostics;
  - `redactRecord` is applied to every router log line;
  - `InferenceError.toJSON` omits diagnostics;
  - user-facing messages are fixed strings.
- Tenant isolation: connection ids owned by another tenant or user return 404, so they can't be
  probed. Tenant keys require `membership:manage` on that exact business.
- Provider tool calls are converted to Grogoni's JSON proposal. Only tools the agent offered are
  accepted, and every proposal goes through `parseRuntimeModelOutput`, validation, permission and
  confirmation. Providers never execute anything; tests show a provider-native `product.update`
  stopping at `needs_confirmation`.
- Consumer-session reuse is not supported. There is no code path for ChatGPT/Claude.ai/Z.ai web
  sessions or cookies; only documented API keys and configured compatible endpoints are accepted.
- Metrics labels are only `provider`, `model`, `execution_target`, `status`, `code` and
  `currency`, never user, tenant, prompt or key.

## 11. SSRF protections

Implemented in `endpoint-policy.ts` and `http-transport.ts`.

**Static checks** run at configuration time and again on every request:

- https only;
- no userinfo, query or fragment;
- ports for common internal services (SSH, SMTP, Redis, Postgres, Docker, Kubelet, …) are blocked;
- the hostnames `localhost`, `metadata`, `metadata.google.internal`, `instance-data`, `kubernetes`
  and suffixes like `*.internal`, `*.local`, `*.svc`, `*.cluster.local` are blocked;
- single-label hosts are blocked;
- literal IPs in blocked ranges are rejected. WHATWG URL parsing normalizes decimal and hex forms
  such as `2130706433` and `0x7f000001` first.

**Blocked address ranges:**

- IPv4: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`,
  `198.18/15`, documentation ranges, multicast, reserved;
- IPv6: `::`, `::1`, `fc00::/7`, `fe80::/10`, multicast, documentation;
- IPv4-mapped, IPv4-compatible and NAT64 forms, judged by the IPv4 address they carry.

**Connect-time DNS pinning:** the production transport is `node:https` with a `lookup` that
resolves every address and fails if any is blocked. The address that is checked is the address that
is dialed, which closes DNS rebinding.

**Redirects** are never followed. Any 3xx is `ENDPOINT_FORBIDDEN`.

**BYOK custom endpoints** always use the strict policy. `allowPrivateNetwork` exists only for
operator-configured providers (from the environment or `inference_providers`), and no API route can
set it.

## 12. Usage and cost tracking

- Every attempt writes one `inference_runs` row: request id, conversation, agent, tenant, user,
  model, provider, credential scope, execution target, tokens (including cached input), estimated
  cost, currency, latency, first-token time, status (`succeeded`, `failed` or `rejected`), error
  code, and fallback source. Prompts and outputs are never stored.
- **Cost** is `estimateCost()`: uncached input tokens at the input rate, cached input tokens at the
  cached rate (or the input rate if none is set), and output tokens at the output rate, all from
  catalog pricing.
- **Budgets** come in two independent kinds; both must pass:
  - **Grogoni's caps** (environment and the global policy row): a daily budget per shop and per
    person, and provider monthly ceilings. They apply only to Grogoni-funded requests, measured
    against Grogoni-funded spend. A shop paying with its own key is not limited by them.
  - **A shop's or person's own caps** (their policy row, set in Settings): a daily budget over all
    of their spend, including their own keys.
  - A per-minute request limit per shop and person: the strictest defined value wins. It is
    shared across API instances through Redis, falling back to in-process counters if Redis is
    down.
  - A per-request token ceiling, clamped to the strictest of the request, the model, the policies
    and `INFERENCE_MAX_OUTPUT_TOKENS`.

  Exceeding a limit rejects the request with `BUDGET_EXCEEDED` or `RATE_LIMITED`. It never
  reroutes to another model.

- **Metrics:** `inference_requests_total`, `inference_errors_total`, `inference_latency_ms`,
  `inference_first_token_ms`, `inference_input_tokens`, `inference_output_tokens`,
  `inference_estimated_cost`, `provider_rate_limits`, `provider_fallbacks`.
- **Health:** each provider reports its own status (`AVAILABLE`, `DEGRADED`, `UNAVAILABLE`,
  `MISCONFIGURED`, `RATE_LIMITED`, `CREDENTIAL_INVALID`). A per-provider circuit breaker counts
  only provider-side faults. An outage at one provider never marks the agent, or any other provider
  or model, unavailable.

## 13. Tests added

| File                                                 | What it covers                                                                                                                                                                                                                                                                                                                    | Count |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| `tests/inference-provider-adapters.test.ts`          | OpenAI, Anthropic, Z.ai and llama.cpp adapters against mocked HTTP: translation in both directions, streaming normalization, 401/429/5xx/context errors, `Retry-After`, timeout, cancellation, key verification, capability gating                                                                                                |    20 |
| `tests/inference-router.test.ts`                     | Provider selection, per-step resolution errors, default model, local target never forwarded, credential precedence, BYOK isolation, ciphertext-only storage, replace/revoke, Z.ai billing separation, all fallback modes, pricing, budgets, ceilings, rate limits, token clamping, independent health, circuit breaker, streaming |    23 |
| `tests/inference-provider-security.test.ts`          | 29 SSRF vectors, DNS-rebinding pin, redirect blocking, BYOK endpoint SSRF, `SecretValue`, redaction, no keys in logs or errors, no keys in any API response, cross-tenant read/test/delete/connect denial, auth required                                                                                                          |    41 |
| `tests/multi-provider-inference-integration.test.ts` | Real HTTP chat → agent → binding → router → mocked provider → chat. Covers Qwen → GLM → Claude → GPT in one conversation, provider failure without losing history or switching providers, native tool calls stopping at confirmation, a RuntimeHandoff swap across providers, and tenant BYOK taking over and reverting           |     5 |
| `tests/multi-provider-inference-migration.test.ts`   | Migration is additive and idempotent, has no plaintext or prompt columns, and the rollback is exact                                                                                                                                                                                                                               |     3 |
| `tests/inference-postgres-repositories.test.ts`      | Real PostgreSQL: exact-owner lookup, one active key per owner, envelope/revocation/owner/https constraints, cost sums, purge, policies, provider rows, `credential_ref` constraint                                                                                                                                                |     4 |
| `tests/ai-providers-panel.test.tsx`                  | Settings UI: provider states, masked key hint only, connect, test, disconnect, typed key forgotten after submit, local reply normalization                                                                                                                                                                                        |     5 |

## 14. Commands executed

```bash
pnpm install --frozen-lockfile
pnpm -r --filter "./packages/**" --if-present build
pnpm --filter @grogoni/api typecheck && pnpm --filter @grogoni/web typecheck
pnpm typecheck
pnpm lint
npx prettier --check .
pnpm check:boundaries && pnpm check:esm-relative-imports && pnpm check:shellview-boundary
pnpm check:retired-runtime-references && pnpm check:retired-device-model-references
pnpm check:render-inference-boundaries
pnpm build:production && node scripts/check-web-bundle-budgets.mjs
pnpm test
# Throwaway PostgreSQL 16 cluster:
DATABASE_URL=postgres://grogoni@127.0.0.1:55432/grogoni_test pnpm db:migrate
DATABASE_URL=... pnpm db:verify-schema
psql -f infra/db/migrations/101_multi_provider_inference.sql   # re-apply: idempotent
psql -f infra/db/rollbacks/101_multi_provider_inference.down.sql && psql -f .../101_...sql
CP2_POSTGRES_TEST_DATABASE_URL=... node scripts/run-postgres-tests.mjs
# Boot proof with no provider keys:
DATABASE_URL=... CP2_STORE=postgres node services/api/dist/index.js  # GET /health/ready -> 200
```

## 15. Build and test results

- `pnpm typecheck`, `pnpm lint`, `prettier --check`: pass.
- All guard scripts, `pnpm build:production` and the web bundle budgets: pass. The AI providers
  panel is lazy-loaded, so it is outside the owner route chunk.
- `pnpm test`: 314 files passed, 1895 tests passed, 117 skipped, 1 failed. The failure is
  `tests/computer-runtime-browser.integration.test.ts`, and it fails the same way without this
  change: the container ships Playwright Chromium build 1194 while the repository pins 1228
  (`Executable doesn't exist .../chromium_headless_shell-1228`). It is environmental and unrelated.
- The PostgreSQL suite (`run-postgres-tests.mjs`) passes: 12 files, 133 tests, including the new
  repository test, `cp2-postgres-store`, fulfillment, and runtime-handoff persistence.
- Migrations 000–101 apply on PostgreSQL 16. `db:verify-schema` passes. 101 is idempotent on
  re-apply, and rollback followed by re-apply is clean.
- The compiled API boots with no provider keys, and `/health/ready` returns 200.

## 16. Unresolved issues and follow-ups

Every follow-up from the first iteration is resolved in §20. What remains:

- **Z.ai verification** still uses a 1-token completion (minimal cost), because no free
  key-verification endpoint is relied on.
- **Commercial vendor models are not seeded.** Vendor ids and prices change and must be verified
  by the operator (§7). The on-device models and a disabled Grogoni Cloud entry are seeded
  (migration 102).
- **The device broker and turn streams are in-process,** like the owner-node broker, which
  matches the single-writer API deployment. A multi-writer deployment would need Redis pub/sub for
  both. Rate limits are already shared.
- **Public storefront replies cannot use an on-device model** (there is no member device to
  delegate to). Shops that want storefront replies keep a hosted model.
- **The chat composer shows a live preview.** The validated reply from the turn response replaces
  it. Tool proposals are never previewed.

## 17. Deployment and environment variables

| Variable                                                                                                                                                                                                    | Meaning                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`                                                                                                                                                                         | Grogoni-managed OpenAI key and optional base URL                                                |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`                                                                                                                                                                   | Grogoni-managed Anthropic key and optional base URL                                             |
| `ZAI_API_KEY`, `ZAI_BASE_URL` (default general endpoint)                                                                                                                                                    | Z.ai general API                                                                                |
| `ZAI_CODING_BASE_URL`, `ZAI_CODING_API_KEY`                                                                                                                                                                 | Optional separate `zai-coding` provider (a distinct billing product; no BYOK, never a fallback) |
| `GROGONI_LLAMA_BASE_URL`, `GROGONI_LLAMA_API_KEY`                                                                                                                                                           | Grogoni-hosted llama.cpp or other OpenAI-compatible server (`grogoni-llama`)                    |
| `GROGONI_LLAMA_ALLOW_PRIVATE_NETWORK`, `GROGONI_LLAMA_ALLOW_HTTP`                                                                                                                                           | Operator-only switches for a private-network llama-server                                       |
| `INFERENCE_DEFAULT_PROVIDER`, `INFERENCE_DEFAULT_MODEL`                                                                                                                                                     | Used only when a binding names no model. There is no built-in commercial default.               |
| `INFERENCE_REQUEST_TIMEOUT_MS` (60000), `INFERENCE_MAX_OUTPUT_TOKENS` (1024)                                                                                                                                | Request deadline and global output ceiling                                                      |
| `INFERENCE_BUDGET_CURRENCY`, `INFERENCE_TENANT_DAILY_BUDGET`, `INFERENCE_USER_DAILY_BUDGET`, `INFERENCE_PROVIDER_MONTHLY_CEILINGS`, `INFERENCE_MAX_REQUESTS_PER_MINUTE`, `INFERENCE_MAX_TOKENS_PER_REQUEST` | Cost controls. Blank means unlimited.                                                           |
| `DB_INFERENCE_POOL_MAX` (2)                                                                                                                                                                                 | Size of the inference module's own Postgres pool                                                |
| `INFERENCE_CREDENTIAL_KEYS`                                                                                                                                                                                 | Versioned BYOK encryption keys (`2:<secret>,3:<secret>`); rotated at boot                       |

Deploy order:

1. `pnpm db:migrate`, which applies 101 and 102 (catalog seeds). The API asserts the tables exist at boot, like
   fulfillment does.
2. Deploy the API and web.
3. Set whichever keys you want Grogoni to fund.
4. Register catalog models.

With no keys set, providers are BYOK-only and nothing else changes.

## 18. Rollback procedure

1. Redeploy the previous application build. The old build ignores the catalog `inference` blocks
   and never reads the new tables. Any binding whose primary model is provider-routed reports
   `RUNTIME_UNAVAILABLE` (no adapter). Reactivate a Vercel-served model for those shops, the same
   as any unavailable-model case.
2. Optionally run `pnpm db:rollback` for `101_multi_provider_inference.sql`. This drops the four
   tables, which deletes connected BYOK keys and usage telemetry, so export `inference_runs` first
   if it is needed.
3. `cp2/secret-box.ts` is a pure move with re-exports, so no OAuth data or format changes and
   there is nothing to roll back for OAuth tokens.

## 19. Files changed

**Added:**

- `services/api/src/inference/providers/`:
  - `contract.ts`, `errors.ts`, `redaction.ts`, `secret-value.ts`
  - `endpoint-policy.ts`, `http-transport.ts`, `sse.ts`, `tool-names.ts`, `provider-call.ts`
  - `provider-config.ts`, `environment.ts`, `provider-registry.ts`
  - `openai-compatible-provider.ts`, `anthropic-provider.ts`, `local-provider.ts`
  - `model-definitions.ts`, `credentials.ts`, `connections.ts`, `usage-policy.ts`
  - `inference-router.ts`, `routed-model-adapter.ts`, `platform.ts`
  - `repositories.ts`, `postgres-repositories.ts`
- `services/api/src/cp2/secret-box.ts`
- `services/api/src/cp2/domains/inference-providers/routes.ts`
- `apps/web/src/AiProvidersPanel.tsx`, `apps/web/src/ai-providers-view.ts`
- `apps/web/src/inference/local-inference-response.ts`
- `infra/db/migrations/101_multi_provider_inference.sql`
- `infra/db/rollbacks/101_multi_provider_inference.down.sql`
- `docs/architecture/multi-provider-inference-audit.md`, this report
- Tests: the seven files in §13, plus `tests/fixtures/inference-provider-fakes.ts`

**Modified:**

- `packages/shared-types/src/index.ts`: `AiModelSummary.inference` and `hostedExecutionTarget`,
  provider/connection DTOs, new error-code categories, the `POLICY_REJECTED` category.
- `packages/observability/src/index.ts`: `recordInference` and the inference metrics.
- `services/api/src/index.ts`: platform wiring, own pool, schema assert.
- `services/api/src/cp2/store.ts`: `inferencePlatform` option, adapter composition, API methods,
  purge on deletion.
- `services/api/src/cp2/postgres-store.ts`: option passthrough.
- `services/api/src/cp2/routes.ts`: route registration.
- `services/api/src/cp2/oauth.ts`: re-exports from `secret-box.ts`.
- `services/api/src/cp2/domains/agent-runtime/store.ts`: `hostedExecutionTarget`, account id in
  health checks.
- `services/api/src/cp2/domains/agent-runtime/route-body-parsers.ts`: validated `inference` block
  on catalog PUT.
- `services/api/src/cp2/domains/agent-runtime/native-runtime-routing.ts`: account id and binding id
  in the adapter context.
- `services/api/src/inference/model-runtime.ts`: `buildInferenceInstructions`, exported
  `normalizeModelText`, `accountId` in the context.
- `services/api/scripts/verify-db-schema.mjs`: new tables.
- `apps/web/src/AgentProfileSurface.tsx`: the Settings group.
- `apps/web/src/QuickRuntimeSwitcher.tsx`, `apps/web/src/AgentModelPanel.tsx`: activate on the
  model's hosted target.
- `.env.example`, `render.yaml`.
- `docs/architecture/provider-neutral-runtime.md`, `docs/architecture/inference-runtime.md`:
  cross-links.

## 20. Follow-up: device-local models and closed gaps

### 20.1 Device-local models are an option again

Decided in [ADR-explicit-device-local-models.md](../adr/ADR-explicit-device-local-models.md).

```text
member's chat ──POST /v1/messages (x-grogoni-turn-id)──► Grogoni API: binding → router → local provider
      │                                                       │ builds prompt, then waits
      │ GET /v1/ai/device-inference/jobs/next?turnId=… ◄──────┘ DeviceInferenceBroker
      ▼
 WebLLM on this device (origin-pinned) ──POST …/jobs/:id/result {one-time token, text}──► API
                                                                     parse · validate · confirm
```

- `ModelExecutionTarget` again includes `browser-local` and `installed-app`. Catalog models with
  those targets are served by the `local` provider through `browser-local:<id>` /
  `installed-app:<id>` adapters. Activation accepts them only for models declared on-device
  (`MODEL_RUNTIME_INCOMPATIBLE` otherwise), and never together with `CLOUD_ONLY`.
- **Where it shows in the UI:**
  - The composer's model switcher lists the seeded on-device models (SmolLM2 360M, Qwen2.5 0.5B,
    Qwen3 1.7B), marks them "on this device · free", and disables them where WebGPU is missing.
  - Choosing one confirms the one-time download size, downloads, then activates.
  - Settings → AI providers → On-device models downloads or removes models on this device.
- **Safety properties** (all tested):
  - jobs are account-scoped, model-scoped, runtime-scoped and turn-scoped;
  - results need a one-time token and are capped at 64 KB;
  - there is no fallback when no device answers (`LOCAL_DEVICE_UNAVAILABLE` after 20 s);
  - a device model's tool proposals still stop at confirmation;
  - anonymous callers are refused;
  - nothing is sent to any cloud provider;
  - usage is recorded at zero cost.

### 20.2 Streaming to the chat UI

Every hosted model now streams reply text to the chat: the router (via the provider's native
stream) and the Vercel adapter.

1. The client names its turn with `x-grogoni-turn-id`.
2. `app.ts` runs the request inside an `AsyncLocalStorage` turn context.
3. Adapters publish to `TurnStreamHub`, keyed by account and turn.
4. `GET /v1/ai/turn-stream/:turnId` serves server-sent events.

`createRuntimeReplyTextStream` (`@grogoni/tool-core`) streams only the `message` text of a JSON reply.
It never streams JSON syntax or a tool proposal. On an explicit-policy fallback, the preview is
reset so two models' output is never spliced together.

The chat hook wraps its three agent-turn calls with `withAgentTurnPreview`. That shows a live
bubble while the turn runs and runs this device's on-device job for the turn. The validated reply
replaces the bubble.

### 20.3 Policy and provider management APIs and UI

| Route                                      | Who                                   |
| ------------------------------------------ | ------------------------------------- |
| `GET/PUT /v1/ai/policies/shop/:businessId` | owners/managers (`membership:manage`) |
| `GET/PUT /v1/ai/policies/me`               | any signed-in person                  |
| `GET/PUT /v1/platform/ai/policy`           | platform operators                    |
| `GET /v1/platform/ai/providers`            | platform operators                    |
| `PUT/DELETE /v1/platform/ai/providers/:id` | platform operators                    |

Inputs are validated:

- a shop cannot set provider ceilings, since those cap Grogoni-funded spend;
- fallback models must be router models, and approved providers must exist;
- provider URLs go through the SSRF policy at save time;
- `credentialRef` must be `env:` or `secret://`, never a key.

Settings → AI providers gains a **Spending and fallback** card with a daily budget, a
messages-per-minute limit, and the fallback mode with its approved providers and ordered fallback
models.

### 20.4 Shared rate limits

`createRedisRequestRateLimiter` keeps fixed-window counters in the API's existing Redis, so every
instance shares one limit. On a Redis error it falls back to in-process counters, the same
skip-on-error stance as the HTTP rate limiter.

### 20.5 Credential key rotation

- `INFERENCE_CREDENTIAL_KEYS` adds versioned keys. Version 1 remains the shared envelope key.
- New credentials use the highest version.
- `rotateCredentialKeys()` runs at every boot, off the startup path. It re-encrypts rows on older
  versions and reports `{rotated, failed}`, so an operator knows when an old key can be removed.
- The envelope helpers moved to `encryptSecretEnvelope` / `decryptSecretEnvelope`. OAuth tokens
  are unchanged.

### 20.6 Also fixed along the way

- **Budget precedence.** A shop's policy row can no longer _raise_ Grogoni's daily budget. The two
  kinds of budget are now independent (§12).
- **SSE header flush.** Node sends no headers until the first write, so the turn stream sends an
  initial comment frame. Without it a client would see nothing until the first token.
- **Migration quoting.** The 102 seed escapes apostrophes. Real PostgreSQL caught this.

### 20.7 Verification results (this iteration)

- `pnpm lint`, `prettier --check`, `pnpm typecheck`: pass.
- `pnpm build:production`, including every guard script: pass.
- Web bundle budgets: pass. The owner route is 168.9 KiB of 170 KiB; the baseline before this
  work was 167.6 KiB. The companion and the on-device engine load lazily.
- `pnpm test`: 317 files, 1918 tests passed, 123 skipped, 1 failed. The failure is the same
  environmental Playwright browser test as before (the container has Chromium build 1194; the repo
  pins 1228).
- PostgreSQL 16:
  - migrations 000–102 apply;
  - 102 re-applies safely, and rolls back and re-applies cleanly;
  - `db:verify-schema` passes;
  - the Postgres suite passes, 12 files and 135 tests.
- The compiled API boots with `INFERENCE_CREDENTIAL_KEYS` set: `/health/ready` returns 200, and
  anonymous `/v1/ai/turn-stream` returns 401.

### 20.8 Tests added in this iteration

| File                                                      | Covers                                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/device-inference-and-streaming.test.ts`            | Broker scoping, tokens, timeouts and cancel; reply extractor across chunk splits; hub isolation; Redis limiter and fallback; key rotation                                            |
| `tests/device-local-and-policy-integration.test.ts`       | Real chat → device job → reply; confirmation gate for device tool calls; no-device failure; live SSE over real HTTP; policy API and validation; operator provider API; budget scopes |
| `tests/agent-turn-companion.test.ts`                      | Client preview, device job run/result/failure, no claims without installed models                                                                                                    |
| `tests/inference-router.test.ts` (updated)                | Device execution only for identified members                                                                                                                                         |
| `tests/inference-postgres-repositories.test.ts` (updated) | Provider upsert/remove, rotation listing, spend by payer, migration 102 seeds                                                                                                        |

Existing tests updated because the product decision changed:

- `model-activation-runtime`: device targets are now 409 for hosted models instead of 400;
- `native-runtime-execution-target-resolution`: five targets;
- `platform-catalog`: the seeded ids;
- `retired-device-model-references`: the engine file is permitted;
- `fresh-shop-hosted-first-chat` and `local-runtime-boundary`: the turn-stream request and the
  preview wrapper.

## 21. Follow-up: Shopkeeper on ZeroClaw with GPT-6 Luna as the platform default

Decision record: [ADR-zeroclaw-default-agent-runtime.md](../adr/ADR-zeroclaw-default-agent-runtime.md).

- **Default runtime.** `repositoryDefaultRuntimePolicy` is now
  `builtin:shopkeeper:v1` / `Shopkeeper` / engine `zeroclaw` / `gpt-6-luna` / target `backend`.
  `platformSharedModelId` is `gpt-6-luna`: it is the only platform-included model, and every other
  model is merchant-funded. Migration 103 (with rollback) makes these changes in existing
  databases:
  - seeds the catalog row;
  - switches the `builtin:shopkeeper` definition to ZeroClaw;
  - adds `builtin:shopkeeper-grogoni` (Shopkeeper on Grogoni's engine);
  - rewrites the global default binding slot in place.
- **ZeroClaw engine.** `agent-harness/zeroclaw-agent-runtime-adapter.ts` is always registered.
  - It calls the ZeroClaw gateway's `POST /webhook` with one fresh session per turn.
  - It rejects replies from any model other than the bound one.
  - It returns plain text, which Grogoni parses and approval-gates like any other model output.
- **Delegated runs.** `InferenceRouter.delegate` covers a model call made by an external runtime
  that holds Grogoni's platform key. It resolves the model (without a credential lookup), admits the
  call against budgets and rate limits, and runs it behind its own `delegated:<provider>` circuit.
  It records a `credentialScope: "platform"` run, with token counts estimated from text length
  because the gateway reports none.
- **No gateway.** ZeroClaw is resolved to the `grogoni` engine once, at configuration time. This
  covers both the default policy and any agent definition that names `zeroclaw`, and it is logged
  as `runtime.default_engine_resolved`.
- **Fixed along the way.** The zero-setup repair no longer attaches a hosted fallback behind an
  on-device primary model. With a cloud default, that fallback would have sent on-device
  conversations to the cloud when no device was online.
- **Deployment.** `render.yaml` adds the private `grogoni-zeroclaw` service:
  - image `ghcr.io/zeroclaw-labs/zeroclaw:v0.8.5`;
  - `readonly` risk profile with all tools denied, and no session persistence;
  - generated webhook secret shared with the API.
    It also points the API's `PLATFORM_DEFAULT_*` variables at the new default. Set `OPENAI_API_KEY`
    on the API and `ZEROCLAW_providers__models__openai__default__api_key` on the ZeroClaw service.
- **Tests.** `tests/zeroclaw-agent-runtime.test.ts` covers:
  - the webhook contract;
  - model identity checks;
  - error mapping;
  - budget admission;
  - configuration parsing;
  - resolution to the `grogoni` engine.
    Existing zero-setup, effective-runtime, catalog and switcher tests now assert the new default.
