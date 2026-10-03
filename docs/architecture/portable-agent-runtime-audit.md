# Portable agent runtime audit

## Current execution path

```text
ChatSurface / useChatRuntimeState
  -> conversation creation or reuse
  -> optional ready client inference proposal
  -> POST /businesses/:businessId/runtime/turns
  -> AgentRuntimeDomain.createRuntimeTurn
  -> ensureDefaultRuntimeForTurn
  -> NativeRuntimeBindingStore.resolveRuntimeBinding
  -> resolveNativeRuntimeModelProvider
  -> ModelRuntimeAdapter / RuntimeModelProvider
  -> bounded tool proposal, authorization, confirmation, execution
  -> response + RuntimeModelTrace
```

Conversation records persist `runtimeBindingId`. The native binding graph separates agents,
models, execution hosts, installations, bindings, and ordered binding-model roles. PostgreSQL
stores that graph in the `cp2_native_*` tables created by migration 063 and evolved by migrations
065–071. Legacy `cp2_agent_model_bindings` remains a compatibility input, not a second router.

## Existing strengths

- First connected chat probes a real generic backend adapter and provisions a deterministic
  shop/account default; no model or bridge download is required.
- Execution targets are location-only values: `backend`, `browser-local`, `installed-app`, and
  `remote-shop-device`.
- Model capability matching, runtime contract matching, host scope authorization, availability
  state, and installation state are checked in trusted API code.
- Retryable inference failure advances through a bounded native fallback list and records trace and
  telemetry fields without prompt or credential content.
- Local/browser completions require ready account/user/device/model assignments before the server
  accepts them. Missing client capability falls back to the normal server turn unless the owner
  explicitly chose local-only.
- Existing conversations and migrated bindings retain their IDs.

## Coupling found and removed

The OSS-agent UI persisted an additional `businessId × deviceId × agentDefinitionId` localStorage
link, automatically ranked/selected an agent during device bootstrap, described manifests as
downloads, and relinked the logical agent on every new device. Profile saving also refused a model
preference unless that model was installed “on this phone.” Those paths coupled logical agent/model
choice to the current device even though the server runtime was already portable.

The device link and automatic hardware-based agent selection are removed. Account manifests now
contain a validated `PortableAgentManifest`; the business profile remains the device-independent
agent identity. Model preferences can be saved independently, while local artifact activation
continues to require a real compatible local runtime only when the owner elects to use it.

## Failure behavior

Ordinary chat does not fail for `BRIDGE_UNAVAILABLE`, missing WebGPU/WASM, missing local artifacts,
or an offline remote node; those conditions reject optional client candidates. A connected turn can
still fail when no configured hosted adapter can execute any compatible model, hosted execution was
explicitly disabled by local-only policy, authorization fails, or every bounded candidate fails.
Those are deployment/policy/security failures rather than device-installation prerequisites.

## Remaining boundaries

This change supplies the Grogoni-manifest importer and safe OSS-catalog conversion foundation; it does
not execute arbitrary framework repositories. Future framework adapters must produce the same
validated manifest and require a separately configured isolated runtime adapter before repository
code can run. Offline chat still requires a previously installed local model/runtime by definition.
