# ADR: Device-independent runtime execution, plus connected GitHub/Hugging Face discovery

> **Partially superseded** by [ADR-explicit-device-local-models.md](./ADR-explicit-device-local-models.md):
> `browser-local` / `installed-app` are execution targets again, as an explicit per-shop model
> choice. Generation is delegated to the member's own device; the server keeps prompt, tools and
> approvals, and there is no silent fallback.

## Context

Grogoni's hosted-first zero-setup runtime (ADR-hosted-first-zero-setup-ai.md, ADR-default-runtime-pi-smollm.md)
already made Pi + SmolLM2 360M work on a shop's first chat message with no client setup. Alongside
that hosted path, the codebase still carried an earlier, parallel architecture: private on-device
model execution. `ModelExecutionTarget` included `browser-local` (in-browser GGUF/WebGPU/WASM
inference via `@wllama/wllama`, `transformers.js`, and WebLLM) and `installed-app` (a native bridge,
`window.GrogoniAgentModelRuntime`, running llama.cpp against a model privately downloaded to one
Android device). A shop-scoped model artifact uploaded to the account could be reconstructed back
onto any individual device (`restoreAccountModelToDevice`) purely to run inference locally, and a
`localStorage`-keyed `DeviceAgentModelAssignment` bound "this agent" to "this installed model" per
device rather than per shop. GGUF model chunks were stored directly as Postgres `bytea`
(`cp2_model_artifact_chunks`, migration 066) — Neon acting as a model-weight filesystem, not a
control plane.

This meant a user signing into the same shop from a second device found no model available there
until they repeated a private download/restore/activation sequence on that device too — the exact
opposite of the hosted-first guarantee. It also meant ~2,500 lines of client-side capability
detection, chunked download/reassembly, OPFS/IndexedDB persistence, and worker-based inference
plumbing had to be kept correct and secure for a path that competed with, rather than complemented,
the already-working hosted default.

Separately, real (if disconnected) GitHub/Hugging Face discovery code already existed
(`services/api/src/cp2/github-model-catalog.ts`, `huggingface-model-catalog.ts`,
`github-agent-catalog.ts`, `huggingface-agent-catalog.ts`) — backend-only, hitting the real public
APIs, never called directly from React. It had no unified cross-provider search, no per-account
connected-credential tier (only a deployment-wide `GITHUB_TOKEN`/`HF_TOKEN` env var), and its only
consumer action was "download this GGUF file to the device," i.e. it fed the private on-device path
rather than the hosted registration path.

## Decision

1. **Narrow `ModelExecutionTarget` to `"backend" | "remote-shop-device"`.** `browser-local` and
   `installed-app` are retired. `remote-shop-device` is kept and redefined precisely: it names a
   shop-owned machine _registered as an execution host_ (e.g. a merchant's laptop running Ollama,
   added through the existing native-runtime execution-host graph), never "whichever browser or
   phone happens to be open right now." A client device never needs a private model copy to use
   normal agent chat — inference always resolves to a host the shop's runtime binding already
   knows about, not to browser-local state.
2. **Runtime selection stays four independent, swappable dimensions**: Agent, `AgentRuntimeAdapter`
   (harness), Model, and Execution Host. Changing one must never silently reset another. The
   client-facing projection of this is `RuntimeBinding` (`packages/shared-types/src/runtime-registry.ts`)
   — `{agentId, agentRuntimeAdapterId, modelId, executionTarget, executionHostId}` — built from the
   existing native/legacy binding records, not a new persistence shape competing with them.
3. **GitHub and Hugging Face become `RuntimeRegistryAdapter` sources, not runtime authorities.**
   A canonical `RuntimeRegistryAdapter` interface (`search`, `inspect`) is implemented by
   `GrogoniCatalogRegistryAdapter`, `GitHubRegistryAdapter`, and `HuggingFaceRegistryAdapter`, wrapping
   the pre-existing catalog code rather than re-implementing GitHub/Hugging Face access. A unified
   `GET /v1/runtime-registry/search` fans out to requested providers concurrently, normalizes results
   into `RuntimeRegistrySearchItem`, and reports provider-level failures separately so one slow or
   down provider never blocks the rest.
4. **Users may connect their own GitHub/Hugging Face account** via a pasted personal access token,
   not a new OAuth application. This needed no new registered OAuth app or client secret from the
   deployment owner — a scoped OAuth flow would have — and is a standard pattern for this class of
   integration. The token is validated against one real, lightweight provider API call at connect
   time, encrypted at rest with the same AES-256-GCM primitive already used for social-login OAuth
   tokens (`services/api/src/cp2/oauth.ts`'s `encryptOAuthToken`/`decryptOAuthToken`), never returned
   to the browser after storage, and actually deleted (not just flagged) on disconnect.
5. **External assets go through an explicit import lifecycle** (`RuntimeAssetImportState`:
   `DISCOVERED → INSPECTING → VALIDATED → IMPORTING → REGISTERED → PROVISIONING → READY → ACTIVE`,
   with named failure states including `ACCESS_REQUIRED` and `LICENSE_CONFIRMATION_REQUIRED`) rather
   than one boolean `installed` flag. Every imported asset keeps `RuntimeAssetProvenance` — provider,
   external id, repository URL, owner, revision/commit SHA, filename, checksum, license, import time
   — pinned at import time. An upstream change never silently mutates an already-active runtime; it
   can only ever surface as "update available."
6. **A harness (an `AgentRuntimeAdapter` implementation) is never executed merely because a user
   selected a GitHub search result.** Discovery and compatibility are different states: a search
   result is `"compatible"` only after static inspection finds a well-formed Grogoni-compatible
   manifest at the repository root — never because a repo name or README contains the word "agent."
   Import for a harness proceeds through discover → inspect → validate → register, and then
   deliberately stops: this codebase has no isolated execution environment (no `isolated-vm`,
   container, or equivalent sandbox) to safely run untrusted third-party code inside the API
   process, so automatic sandboxed provisioning of a _new_ harness implementation is explicitly out
   of scope here. Activating a newly-discovered harness still requires deploying it through the
   existing trusted `AgentRuntimeAdapterRegistry.register()` code path — a real code change, not a
   runtime-triggered import. Building a false sense of isolation would be worse than naming this gap
   plainly; it is recorded here as a real follow-up requiring dedicated sandboxing infrastructure,
   not a limitation to quietly work around.
7. **Agent and model imports have no equivalent execution risk and are completed fully**: a GitHub
   agent import validates a `PortableAgentManifest` (already denylists device paths, credentials, and
   executable references — `packages/shared-types/src/portable-agent.ts`) and registers a plain
   declarative record; a Hugging Face model import resolves one specific compatible artifact from
   metadata (never downloads full weights merely to render search results), captures its provenance,
   and provisions it without ever making the client browser the storage intermediary.

## Alternatives considered

- **Keep on-device inference as an offline fallback**: rejected. A silent fallback to a different,
  privately-downloaded model on connectivity loss is a correctness and trust hazard (the user has no
  way to know which model actually answered); offline chat instead surfaces a clear "Agent
  unavailable while offline. Reconnect to use the configured runtime." state.
- **Full OAuth apps for GitHub/Hugging Face connections**: rejected for this iteration. It would
  require the deployment owner to register and maintain two separate OAuth applications and rotate
  their client secrets, for a benefit (slightly smoother connect UX) that a pasted access token
  already delivers with less operational surface. The `ExternalRegistryConnection` shape does not
  preclude adding an OAuth flow later.
- **Execute a discovered harness's code in-process immediately on import, gated only by a manifest
  check**: rejected outright — a manifest is declared metadata, not a security boundary; running
  fetched third-party code without process isolation is exactly the class of compromise this
  architecture exists to prevent.
- **Model harness discovery on GitHub topic/keyword matching alone**: rejected — it would misclassify
  ordinary repositories as executable harnesses. Compatibility requires an explicit, validated
  manifest.

## Consequences

Signing into an existing shop on a new device gets the shop's already-configured runtime
immediately — no re-download, no re-activation, no device-specific state to reconcile. Users can
browse and (for agents and models) fully import components from GitHub and Hugging Face without any
client-side capability detection, worker orchestration, or chunked-storage code. The web bundle
shrinks by the removal of the on-device inference stack (`ai-model-manager.ts`,
`browser-model-registry.ts`, `browser-gguf-runtime.ts`, nine `browser-inference-*.ts` files, and the
on-device branches of `AgentModelPanel.tsx`/`useChatRuntimeState.ts`).

The trade-off: a shop that genuinely wants offline or fully private inference on a specific device
now needs that device registered as a `remote-shop-device` execution host rather than getting it for
free via ad hoc browser capability detection. Harness discovery is real end-to-end for _finding_ and
_validating_ a compatible adapter, but activating a brand-new third-party harness still requires an
operator-driven deploy step until real sandboxed provisioning infrastructure is built — this is a
named, deliberate gap, not an oversight.

## Security implications

- GitHub/Hugging Face credentials are resolved server-side only, never included in prompts, runtime
  manifests, browser storage, or execution traces; they are redacted from error messages.
- Registry search results are metadata only — no full model weights or repository source are
  downloaded to service a search request.
- README/model-card text encountered during discovery is treated as untrusted data; nothing in the
  import pipeline executes instructions found in it.
- Provider metadata (stars, license, compatibility claims) is discovery input, never authoritative
  runtime truth — Grogoni independently validates what it will register and, for models, what it will
  provision.
- Search result caching separates public results from connected-account results by cache key
  (`accountId` only enters the key when the request is actually authenticated as connected); one
  account's connected search results are never served to another account or to an anonymous caller.

## Migration impact

A forward migration (`infra/db/migrations/073_...` or the next free number — see the migration
itself for the exact number applied) adds `cp2_external_registry_connections` (modeled on
`user_identities`'s real-column style, since it holds an encrypted secret rather than a JSONB
metadata blob) and `cp2_runtime_registry_imports` (modeled on the generic `entity_id/record
jsonb`-per-row convention used by `cp2_model_catalog`/`cp2_agent_catalog`). No already-applied
migration is edited. Existing `cp2_model_artifacts`/`cp2_model_artifact_chunks` rows are preserved
untouched — this decision stops _new_ GGUF-chunk-into-Postgres writes going forward; it does not
retroactively migrate or delete historical rows, which remain readable for any code that still
depends on them until a dedicated artifact-storage migration follows up. Pi + SmolLM2 360M remain
the repository default; nothing here changes `repositoryDefaultRuntimePolicy`.

## Update: a narrow, disclosed exception for explicit offline mode

The Grogoni Offline Runtime (`docs/offline/README.md`) reintroduces on-device model execution for one
specific, narrow case: a device the merchant has _explicitly_ put into offline mode from Settings,
where the alternative is not "route to the hosted default" but "the agent is unavailable at all."
This is not a reversal of the decision above - the "keep on-device inference as an offline fallback"
alternative rejected there was a _silent_ fallback on an ordinary connectivity blip, where the
merchant has no way to know a different, privately-downloaded model just answered instead of the
configured runtime. That specific hazard does not apply here, because:

- The device only has an on-device model at all because the merchant explicitly opted into it,
  through the same disclaimed "Go Offline" confirmation that installs the business-data snapshot -
  there is no ambient "sometimes your browser just happens to answer instead" behavior for a user
  who never asked for offline mode.
- Every on-device reply is labeled with the exact pinned model, in the UI, every time
  (`OfflineRuntimeSettings.tsx` renders "Answered offline by <model>") - never presented as
  indistinguishable from a normal, data-connected agent turn.
- It only ever runs while `offlineModeActive` is true, which - per the existing (pre-dated) resolver
  design in `packages/offline-runtime/providers/resolver.ts` - is never entered or exited silently;
  reconnecting shows a sync prompt, not an automatic switch back.

`ModelExecutionTarget` (`"vercel" | "backend" | "remote-shop-device"`) is unchanged - this is not a
fourth execution target for ordinary online chat. It is scoped entirely inside
`packages/offline-runtime`'s pre-existing `InstalledRuntimeAdapter` interface, which this decision's
own "Explicit limits" section already anticipated ("offline AI requires an executable
`InstalledRuntimeAdapter`...but no browser model engine...is supplied") without ruling out ever
supplying one for this specific, disclosed path.

Scope, deliberately narrow: one model (`Qwen2.5-0.5B-Instruct-q4f16_1-MLC`), one engine
(`@mlc-ai/web-llm`/WebGPU), answering from the prompt alone with no catalogue/order/customer/account
data - not the full multi-engine, multi-model, GitHub/Hugging-Face-discoverable registry this ADR
retired. Reintroducing that full surface would reopen exactly the maintenance and security burden
this ADR argued against; this exception is scoped to stay well short of it.
