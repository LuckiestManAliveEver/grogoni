# Computer Runtime Audit

## Existing Architecture

Grogoni already routes chat work through `AgentRuntimeDomain.createRuntimeTurn`, the canonical runtime tool registry in `packages/tool-core`, and `executeRuntimeCapability` in `services/api/src/cp2/domains/agent-runtime/capabilities.ts`.

The native runtime graph is provider-neutral and lives in `cp2_native_runtime_agents`, `cp2_native_runtime_models`, `cp2_native_execution_hosts`, `cp2_native_model_installations`, `cp2_native_runtime_bindings`, and `cp2_native_runtime_binding_models` from migration `063_native_runtime_bindings.sql`.

Runtime continuity is already represented by immutable `RuntimeHandoff` checkpoints in `packages/shared-types/src/runtime-handoff.ts` and the `cp2_runtime_handoffs`, `cp2_runtime_task_heads`, and `cp2_runtime_task_instances` tables from migration `083_runtime_handoff_protocol.sql`.

> Historical note: this audit describes the pre-implementation baseline. The worker, live view,
> encrypted profiles, persistence, approvals, and external-surface compatibility layer are now
> implemented. See `docs/architecture/computer-runtime.md` for the current architecture.

At the time of this audit there was no production browser automation provider, live browser stream,
encrypted browser-profile store, or computer worker service in the repo.

## Reusable Components

- `RuntimeToolName`, `RuntimeToolDefinition`, `runtimeToolRegistry`, and `validateRuntimeToolInput`.
- Existing confirmation flow in `createRuntimeTurn` and `confirmRuntimeAction`.
- Native execution hosts with advertised capabilities.
- `RuntimeHandoff` action metadata, context references, artifacts, task head, and task instance state.
- Existing MCP gateway pattern, which intentionally exposes curated tools rather than the full registry directly.

## Architectural Conflicts

Older generic names such as `agents`, `models`, `agent_model_bindings`, `execution_hosts`, and `runtime_instances` do not exist as live tables. The actual repo vocabulary is `cp2_native_runtime_agents`, `cp2_native_runtime_models`, `cp2_native_runtime_binding_models`, `cp2_native_execution_hosts`, and `cp2_runtime_task_instances`.

Execution Fabric tables were retired. Computer use should extend the native runtime graph rather than revive the retired fabric.

## Missing Components At Audit Time

- Isolated browser worker service.
- Provider adapter, such as Stagehand or remote CDP, with license review.
- Encrypted persistent browser-profile store.
- Live-view streaming endpoint and frontend card.
- RuntimeHandoff approval resume endpoints specific to computer actions.
- Deployment isolation, network egress policy, and metrics wiring.

## Integration Points

This implementation adds provider-neutral `ComputerRuntime` domain types in `@grogoni/shared-types`, registers `computer.*` runtime capabilities in `@grogoni/tool-core`, adds validation, and adds a policy classifier that hashes exact proposed actions. The API dispatcher fails closed until a real isolated provider is configured.

Computer checkpoints should be represented as `RuntimeAction.metadata`, `RuntimeContextReference` entries, and `RuntimeArtifactReference` rows, with `RuntimeTaskHead` remaining the single mutable active-checkpoint pointer.

## Migration Requirements

No database migration is included in this slice. A production provider will need tables for browser profiles, computer sessions, action audit records, and approval records unless those are deliberately mapped into an existing generic CP2 collection.

## Security Implications

Browser content is untrusted. The model must receive observations as tool results, not instructions. Credentials, cookies, tokens, and browser storage must never be exposed to model context or logs. Consequential browser actions must bind approval to the exact hashed action and must execute at most once.
