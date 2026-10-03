# ADR: Collapse harness into agent

## Context

`ADR-device-independent-runtime-and-registry-discovery.md` decided that runtime selection stays
"four independent, swappable dimensions: Agent, `AgentRuntimeAdapter` (harness), Model, and
Execution Host." In practice this meant three separate, only loosely-related systems all claimed a
piece of "agent":

- `AgentDefinition` (`packages/shared-types`, `cp2_agent_catalog`) — personality, instructions,
  knowledge, tools. Already the mature, GitHub/HuggingFace-importable catalog a business picks from
  via `BusinessAgentProfile.agentDefinitionId` (`updateAgentProfile`).
- `NativeRuntimeAgentSummary` (`cp2_native_runtime_agents`) — a thinner, plumbing-oriented "native
  agent record" (`id`, `provider`, `packageRef`, `configuration.runtimeAdapterId`) that the ADR's
  own diagram actually labels "Agent," despite carrying none of `AgentDefinition`'s
  personality/instructions.
- `AgentRuntimeAdapter` ("harness") — the in-process execution interface (`canRun`/`execute`),
  selected via a _third_, independent registry (`AgentRuntimeAdapterDescriptor`,
  `/v1/platform/agent-runtime-adapters`) that a shop reached through a bolted-on "Harness" dropdown
  in `QuickRuntimeSwitcher.tsx`, unconnected to which `AgentDefinition` they had actually chosen.

A shop could pick a personality (`AgentDefinition`) and, entirely independently, pick an engine
(`AgentRuntimeAdapter`) — two unrelated choices a user had to reconcile mentally, with no
constraint stopping nonsensical combinations. Separately, the harness _registry_ let GitHub/Hugging
Face search results be discovered and partially imported as `kind: "harness"` — a repository
claiming to be a Grogoni-compatible adapter, validated only by a `grogoni.harness.json` manifest file,
capped at `PROVISIONING` because no sandboxed runtime exists in this codebase to safely execute
imported third-party code. That security boundary correctly stopped harness code from
auto-activating, but it did nothing to fix the deeper problem: harness was never actually a
property of _anything_ a shop directly chose.

## Decision

1. **Engine choice becomes a field on `AgentDefinition`, not an independent dimension.**
   `AgentDefinition.runtimeAdapterId: string` (`packages/shared-types/src/index.ts`) declares which
   registered `AgentRuntimeAdapter` an agent definition runs on. `defaultAgentDefinition`
   ("builtin:shopkeeper") declares `"grogoni"`; a second built-in, `piAgentDefinition`
   ("builtin:pi-assistant"), declares `"pi"` so the Pi engine stays choosable. A shop swaps engines
   by picking a different agent definition (`PUT /businesses/:businessId/agent-profile`) — the same
   action that already changes personality and instructions — never by an independent activation
   parameter.
2. **The harness-import pipeline is deleted, not reworked.** `RuntimeAssetKind` narrows to
   `"agent" | "model"`. `grogoni.harness.json`, `harness-manifest.ts`, the GitHub harness-discovery
   branch, and `importHarness()`'s hard-stop-at-`PROVISIONING` state machine are all removed.
   Grogoni no longer supports importing third-party executable adapter code from GitHub/Hugging Face
   at all. Only the two built-in adapters (`pi`, `grogoni`) exist; a new one is added by a human
   wiring code into `AgentRuntimeAdapterRegistry.register()`
   (`services/api/src/agent-harness/default-agent-runtime-adapters.ts`), never by an import flow.
   This is safe to remove outright rather than migrate: the feature never reached a state where
   third-party code actually ran, so nothing observable is lost by retiring it.
3. **The `AgentRuntimeAdapter` execution mechanism itself is unchanged.** The interface
   (`canRun`/`execute`), `AgentRuntimeAdapterRegistry`, `createGrogoniAgentRuntimeAdapter`,
   `createPiAgentRuntimeAdapter`, and `NativeRuntimeAgentSummary.configuration.runtimeAdapterId`
   all still exist exactly as before. What changed is _who decides the value written there_:
   `finalizeVerifiedActivation` (`agent-runtime/store.ts`) now always resolves it from the
   business's current `AgentDefinition.runtimeAdapterId` (via `resolveAgentCatalogEntry`) instead
   of accepting a client-supplied `agentRuntimeAdapterId` override.
4. **The platform's zero-setup default is unaffected.** `PlatformDefaultRuntimePolicy.agentRuntimeAdapterId`
   ("pi", per `ADR-default-runtime-pi-smollm.md`) still governs the hosted-first bootstrap for a
   business that has never touched its agent definition — `ensureDefaultRuntimeForTurn` special-cases
   exactly this "untouched, still on `defaultAgentDefinitionId`" condition to use the platform
   default, so the zero-setup guarantee is not silently downgraded to Shopkeeper's own `"grogoni"`
   engine before a business does anything explicit. Any other, explicitly chosen agent definition
   uses its own declared engine.
5. **The two parallel display/selection catalogs are retired.** `AgentRuntimeAdapterDescriptor`,
   `agent-harness/agent-runtime-catalog.ts`, `GET /v1/platform/agent-runtime-adapters`, and
   `GET /api/agents/:agentId/harness` are deleted — superseded by `AgentDefinition`'s own
   `id`/`displayName`/`runtimeAdapterId` fields and the already-existing
   `GET /v1/platform/agent-catalog`. `EffectiveRuntimeSummary.harness: {id, name}` becomes
   `EffectiveRuntimeSummary.agent: {id, name, runtimeAdapterId}`.

## Alternatives considered

- **Keep harness independently swappable, just rename it**: rejected. This would have "collapsed"
  the concept in name only — a shop could still end up with a personality and an engine that were
  never chosen together, which was the actual problem, not the word "harness" itself.
- **Fold harness into agent _import_, keep the third-party-code security cap**: rejected in favor
  of deleting the pipeline outright. The harness-import feature never let third-party code reach
  `ACTIVE` in the first place (see the ADR this supersedes, point 6), so keeping a capped,
  never-fully-working import path around a growing `AgentDefinition` surface added maintenance
  burden for a capability nobody could actually complete.
- **Make `NativeRuntimeAgentSummary` (the ADR's own "Agent" node) the place engine choice lives,
  independent of `AgentDefinition`**: rejected. `NativeRuntimeAgentSummary` has no personality,
  instructions, or import provenance — building the "pick your agent" UX against it instead of the
  already-mature, already-importable `AgentDefinition` catalog would have meant building a second,
  parallel "which agent" picker rather than reusing the one that already exists.

## Consequences

A shop's engine choice is now visible and changeable in exactly one place — their agent
definition — instead of two unrelated dropdowns that could silently disagree. `QuickRuntimeSwitcher.tsx`
now offers "Agent" (built-in definitions only, matching its existing "quick/common-case" scope) and
"Model," backed by `PUT /businesses/:businessId/agent-profile` and the existing model-activation
route respectively — two independent requests, not a combined one, so a failure in either leaves
the other's prior state intact. `PortableAgentManifest` gains an optional `runtimeAdapterId` field
so a future GitHub/Hugging-Face-imported _agent_ (config only, never executable code) can declare
which of the two built-in engines it expects, validated the same way any other manifest field is.

The trade-off: an explicit model-only activation on a business still using the platform-default
agent definition now surfaces that definition's own declared engine (`"grogoni"`) instead of silently
preserving whatever the zero-setup bootstrap happened to provision (`"pi"`). This is a deliberate
consequence of removing the independent-harness axis, not an oversight — see point 4 above for the
one case (an untouched business, before any explicit action) where the old zero-setup behavior is
still preserved.

## Migration impact

`infra/db/migrations/095_drop_harness_runtime_kind.sql` deletes existing `kind='harness'`
`cp2_runtime_registry_imports` rows (operational data describing a retired capability, not decision
history) and narrows that table's `kind` CHECK constraint to `'agent' | 'model'`.
`infra/db/migrations/096_agent_definition_runtime_adapter.sql` backfills the existing
`builtin:shopkeeper` `cp2_agent_catalog` row with `runtimeAdapterId: "grogoni"`, seeds the new
`builtin:pi-assistant` row, and requires the field on every future row. No already-applied
migration is edited. `packages/offline-runtime/db/migrations/003_drop_harness_version_pin_column.sql`
drops the now-redundant `device_runtime_pins.harness_version` column (engine choice is implied by
which agent a device is pinned to) via a version-gated `ALTER TABLE`, since `DROP COLUMN` — unlike
the `CREATE TABLE IF NOT EXISTS` pattern every prior offline-runtime migration used — is not safe
to re-run unconditionally on every database open.
