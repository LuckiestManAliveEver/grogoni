# Native agent/model runtime

> **Partially superseded.** The zero-setup hosted-first description below still holds. The
> `browser-local` and `installed-app` execution targets it references were retired — see
> ADR-device-independent-runtime-and-registry-discovery.md. `ModelExecutionTarget` is now
> `"backend" | "remote-shop-device"` only; `remote-shop-device` means a shop-owned machine
> registered as an execution host, never the currently-open browser/device. Kept as historical
> record where it describes the retired paths.

Grogoni AI is zero-setup for an eligible signed-in shop when at least one server-reachable inference
adapter is configured. A merchant can open chat and send a first message without installing an
agent, downloading a model, or activating a binding. A shop-registered execution host remains an
optional optimization; a private per-device model copy is not part of the architecture.

## Runtime graph

```mermaid
flowchart TD
  U[Merchant] --> C[Conversation]
  C --> A[Agent: instructions, tools, policy]
  A --> B[Native runtime binding]
  B --> MR[Compatible model ranking]
  MR --> HR[Execution host ranking]
  HR --> BL[Browser local]
  HR --> IA[Installed app]
  HR --> RD[Remote shop device]
  HR --> BE[Grogoni hosted backend]
  BL --> P[Server-authorized tool/output pipeline]
  IA --> P
  RD --> P
  BE --> P
  P --> R[Persisted response]
```

The durable graph lives in `cp2_native_runtime_agents`, `cp2_native_runtime_models`,
`cp2_native_execution_hosts`, `cp2_native_model_installations`,
`cp2_native_runtime_bindings`, and `cp2_native_runtime_binding_models`. A conversation references
the binding, not a permanently fixed model. `NativeRuntimeBindingStore` is the in-process graph
authority and `resolveNativeRuntimeModelProvider` is the adapter boundary.

An **agent** owns instructions, capabilities, tools, and business behavior. A **model** is an
independently swappable inference artifact or service model. A **runtime binding** stores the
relationship, preference, ordered fallbacks, and execution policy. An **execution host** is an
authorized location that can run an installed/available model. An **inference adapter** hides the
engine or vendor implementation behind `ModelRuntimeAdapter`. A **conversation** retains the
binding while the selected model and host may change on each attempt.

## Model and agent catalog

The catalog of _what models and agent templates exist_ is DB-hosted, not code-hosted. Two tables
(`infra/db/migrations/071_platform_catalog.sql`) hold it:

- `cp2_model_catalog` — every entry `GET /v1/ai-models` can return (`Cp2Store.listModelCatalog`).
- `cp2_agent_catalog` — every built-in agent fallback template (`Cp2Store.listAgentCatalog`),
  distinct from the external GitHub/Hugging Face agent marketplace discovered live, which this
  catalog does not affect.

Both are seeded by the migration with today's exact bootstrap content (the former hardcoded
`aiModelRegistry` array and `defaultAgentDefinition` constant, still present in
`services/api/src/cp2/domains/agent-runtime/model-catalog.ts` and `@grogoni/shared-types` as the
_bootstrap default_, not the runtime source of truth). `Cp2Store.seedCatalogDefaultsIfEmpty`
supplies those same constants in memory whenever it finds either loaded collection empty, so a
fresh test store or recovery from an unexpectedly empty table is never stranded.
`purge-all-users.sql` explicitly preserves both global catalog tables because operator edits are
deployment configuration, not registered-user data.

Any device reaches the live catalog through the same `GET /v1/ai-models` (and
`GET /v1/platform/agent-catalog`) every existing client already calls; there is no separate
per-device copy to keep in sync. `apps/web/src/ai-model-manager.ts`'s `defaultOfflineAiModels`
remains only as the chat UI's bare-minimum offline fallback when that fetch fails outright - it is
deliberately no longer merged into a _successful_ fetch's result, since doing so let its
hand-maintained, already-stale copy silently override the live catalog's label/description/
capabilities for the two model ids it duplicates.

**Editing the catalog** requires platform-operator authority
(`PlatformOperatorGrant`/`cp2_platform_operators`), a deployment-level concept distinct from every
shop-scoped `BusinessRole` in this codebase - it is not obtainable through any API route, only by
running `services/api/scripts/grant-platform-operator.mjs` directly against the database:

```sh
DATABASE_URL=... pnpm db:grant-platform-operator -- --phone=+254700000000 --granted-by=julien
DATABASE_URL=... pnpm db:grant-platform-operator -- --account-id=<uuid> --revoke
```

The API caches grants at startup. Restart every API instance after a grant or revocation; this is
especially important for revocation, so no running instance retains stale authority.

`Cp2Store.requirePlatformOperator` gates `PUT`/`DELETE /v1/platform/model-catalog/:modelId` and the
`/v1/platform/agent-catalog/:agentDefinitionId` equivalents. `qwen2.5-0.5b-android` (the zero-setup
default model), `grogoniclaw-local` (the deterministic compatibility fallback), and
`builtin:shopkeeper` (the default agent fallback) cannot be removed through these routes - required
runtime fallbacks, protected even from an operator, though still editable. `AgentDefinitionId` now
accepts any `builtin:<slug>`, not only the one hardcoded id, so an operator can add a second
built-in agent template without a code change.

## First-chat provisioning

`AgentRuntimeDomain.ensureDefaultRuntimeForTurn` runs inside the authenticated chat path:

1. Preserve an already resolvable or explicitly active shop binding.
2. Rank the profile preference, shop preference, repository default, and compatible catalog
   models without branching on provider identity.
3. Consider only server-reachable targets for a server request. Browser and installed-app targets
   are eligible only through the current-device client protocol.
4. Ask each generic adapter whether it can run the model.
5. Pass verified candidates to `NativeRuntimeBindingStore.ensureDefaultRuntimeBinding`.
6. Upsert a deterministic shop/account/agent binding, scoped hosts, installations, a primary, and
   an optional fallback; then attach the conversation.
7. Resolve and execute normally.

The operation is safe to call repeatedly. Binding, host, installation, and role IDs derive from
their scope and identities. Migration 070 adds one active tenant-default constraint, so concurrent
first chats converge. No unavailable adapter is persisted as a healthy host.

Lazy provisioning is also the existing-user migration strategy. Existing active bindings are
preserved. Users with no usable native graph are normalized on their next chat; stale activation
flags do not create the default. Explicit `LOCAL_ONLY` remains strict.

## Resolution and fallback

Model compatibility uses the agent runtime-contract version and required model capabilities.
Within a binding, the primary precedes fallbacks by persisted priority. A role is eligible only
when its model is active, its installation is usable, its host is usable, and global/account/shop
scope authorization succeeds.

For a fresh browser request, server provisioning considers `backend`; it never pretends a browser
model or installed bridge is available. A configured local client prefers its current local route.
If that route cannot execute, chat falls back to the server unless the merchant explicitly chose
`LOCAL_ONLY`.

Each server attempt records a key made from model, host, and execution target. Timeout,
unreachable-engine, loading/unavailable-model, rate-limit, and provider-operation failures may try
the next candidate. Authentication, invalid tool calls, malformed model output, aborted requests,
and unknown failures are not retried. Attempted keys prevent loops. The runtime trace records the
binding, resolved model, host, target, resolution source, fallback index/reason, duration, and
result without logging prompts or credentials.

## Execution targets

| Target               | Location and trust                                        | Availability                                                               | Fallback                          |
| -------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------- |
| `backend`            | Grogoni/server-reachable inference through a generic adapter | Adapter `canRun` plus execution result                                     | Next compatible binding candidate |
| `browser-local`      | Current authenticated browser only                        | Cached model and ready browser runtime in the current session              | Backend unless `LOCAL_ONLY`       |
| `installed-app`      | Trusted `window.GrogoniAgentModelRuntime` bridge             | Bridge, ready assignment, matching model/runtime, and authenticated device | Backend unless `LOCAL_ONLY`       |
| `remote-shop-device` | Authorized same-tenant owner/shop device                  | Existing owner-node presence/heartbeat and model support                   | Next client route or backend      |

Provider names are not execution targets. `backend` can be implemented by the private inference
service or an optional provider adapter; changing that implementation does not change agents,
conversations, bindings, models, hosts, or API target contracts.

## Security and tools

The API derives account and shop identity from the authenticated session. Requested binding scope
is checked during conversation assignment, and host scope is checked again during resolution.
Tenant hosts use business-scoped deterministic IDs; one shop cannot reuse another shop's host.
Client completions remain untrusted until their ready device assignment is verified. All tool
parsing, permissions, confirmation, execution, and auditing stay server-controlled regardless of
where inference ran.

Remote/local runtimes receive only request context required for inference and never receive server
credentials. Offline chat works only when a compatible local runtime is ready; otherwise the UI
reports AI execution unavailable without claiming full offline support.

## Model preferences

“Use with agent” and model activation are preference/verification operations. They may replace the
binding primary without replacing the conversation or agent. If the preferred model cannot run,
automatic policy selects a fallback. Removing a preference returns execution to automatic mode;
it does not disable ordinary chat.
