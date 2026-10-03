# ADR: Pi and SmolLM2 as the initial hosted platform default

## Status

Accepted.

## Context

The native runtime graph and model adapter boundary already supported hosted-first provisioning,
but the repository default was a Qwen-oriented catalog preference and every turn entered a single
Grogoni orchestration implementation. `services/ai-runtime` and its Ollama image existed but Render
explicitly did not deploy them. A new merchant therefore had no guaranteed first-chat backend.

The platform needs a zero-download default without turning an agent harness, model, provider or
host into a permanent architectural dependency.

## Decision

The initial platform policy is:

```text
Agent:           builtin:pi:v1
Agent adapter:   pi
Model:           smollm2-360m
Target:          backend
Provider:        ollama
Provider model:  smollm2:360m-instruct-q4_0
Host:            Render private grogoni-inference service
```

Pi is selected because its small MIT-licensed agent core provides an explicit model transport,
state, cancellation and event-oriented agent-loop boundary without requiring the coding-agent
CLI or its filesystem/shell tools. Grogoni registers it behind `AgentRuntimeAdapter`; Pi receives a
resolved model callback and no database credentials or direct business tools.

SmolLM2 360M Instruct Q4_0 is selected as a lightweight CPU bootstrap model. Its purpose is a
low-cost always-present baseline, not a claim that it is the best model for every shop. Its model
contract is chat generation; structured tool interpretation and protected execution belong to the
agent/runtime and Grogoni policy respectively.

The shared SmolLM runtime is included as the starting point. Store owners may replace it with a
compatible custom model, but custom model usage, storage, and hosting are merchant-funded. The
activation API requires explicit merchant cost responsibility and records it in the audit trail;
the billing adapter remains responsible for collecting actual charges.

Hosted-first avoids model/agent downloads, WebGPU requirements and device-specific setup on the
first connected chat. Local targets remain available as explicit choices.

Ollama stays behind `services/ai-runtime` so the API and PWA do not depend on an engine protocol,
and service authentication, identity checks, limits and error normalization stay centralized.
Weights stay on the inference host's persistent disk; Neon stores only runtime metadata.

## Swappability consequence

Changing the platform agent changes policy/catalog metadata and adapter registration, not
conversations, models or hosts. Changing the platform model changes policy/catalog/provider
mapping and the host's installed artifact, not the agent. Changing target/host changes a binding
role and model adapter, not the agent or model identity.

Explicit user and tenant bindings always win. Unavailability does not rewrite preferences. The
pre-existing `grogoni` agent adapter remains available for rollback and explicit bindings.

## Node and dependency decision

The selected current Pi package is `@earendil-works/pi-agent-core` 0.84.4, licensed MIT. It depends
on `@earendil-works/pi-ai`, telemetry, TypeBox, YAML and small utility packages; the coding-agent,
TUI, filesystem tools and SQLite backend are not installed. The package requires Node
`>=22.19.0`. Grogoni therefore upgrades its backend/build/runtime pin from Node 20 to Node 22.19 LTS
rather than adding an orchestration sidecar only to bridge Node versions. The upgrade is accepted
only with all repository gates, production builds and runtime smoke tests passing.

## Alternatives rejected

- Keep one implicit Grogoni turn implementation: it cannot prove agent/runtime swappability.
- Encode Pi branches in chat code: it spreads a default into permanent architecture.
- Put Pi executable/runtime fields in portable manifests: it couples identity to installation and
  weakens manifest security.
- Let Pi execute Grogoni write tools directly: Pi has no built-in business permission system and
  cannot replace deterministic authorization and confirmation.
- Keep Qwen solely because it was the former catalog default: defaults are policy, not migration
  constraints.
- Use full precision `smollm2:360m`: it is unnecessarily large for the CPU bootstrap host.
- Expose Ollama or call it from the browser: it leaks provider/topology details and bypasses the
  authenticated facade.
- Store model blobs in Neon: relational storage is for control-plane metadata, not model weights.
- Revive the Execution Fabric or add a provider-specific target: both duplicate/violate the native
  graph.

## Rollback

If the inference host is unhealthy, keep the API online and disable backend default provisioning.
If Pi regresses, change the platform agent/adapter to `grogoni` or another registered adapter without
database reconstruction. If SmolLM quality is inadequate, change the platform model and install
the replacement without replacing Pi. Existing tenant/conversation bindings remain intact unless
an operator deliberately updates them.
