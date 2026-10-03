# ADR: Hosted-first zero-setup AI with swappable native runtime execution

## Context

Grogoni's native runtime graph already separated agents, models, bindings, installations, and hosts,
but the default binding was a model-less draft and chat surfaced manual download/activation
instructions. Client code also treated a ready downloaded agent/model as a prohibition on server
fallback. Provider-specific `openai` values had historically leaked into execution-target data.

## Decision

Hosted execution is the default connected experience. On first authenticated shop chat, Grogoni
idempotently provisions a shop-scoped native binding from models that a configured generic adapter
can actually run. `backend` and `remote-shop-device` are the only execution locations (`browser-local`
and `installed-app` were retired by ADR-device-independent-runtime-and-registry-discovery.md; a
client device never needs a private model copy to chat). Providers and engines remain replaceable
adapter details.

Local execution is optional and preferred when the current device is ready. Only explicit
`LOCAL_ONLY` disables hosted fallback. Conversations retain a runtime binding and resolve the
currently usable model/host at execution time. Retryable execution failures advance through an
ordered, finite fallback chain.

## Alternatives considered

- Require a model download or activation before chat: rejected because it makes infrastructure
  configuration part of merchant onboarding.
- Hard-code a hosted vendor/model as the default: rejected because a provider is neither a model
  abstraction nor an execution location and would strand deployments using another adapter.
- Keep separate cloud/local routers: rejected because decisions, authorization, observability, and
  failure semantics would continue to diverge.
- Persist a backend host without probing it: rejected because a database row is not evidence that
  the current deployment can execute inference.

## Consequences

Connected merchants get first-chat AI without downloads. Operators must configure at least one
hosted adapter for that guarantee; Grogoni does not manufacture an unavailable backend dependency.
Local models still offer privacy, offline execution, cost reduction, and sometimes lower latency.
Deterministic IDs and a tenant-default database constraint make provisioning concurrency-safe.
Existing explicit bindings and local-only preferences are preserved.

The runtime records an additional shop binding and host/installation records after the first chat.
Provider changes do not require conversation or agent migrations. Model/host fallback adds small
resolution and telemetry complexity.

## Security implications

Provisioning occurs only after membership authorization. Conversation binding assignment checks
account and shop scope, host selection rechecks the same scope, and device completions still pass
through server-side assignment, policy, tool, confirmation, and audit boundaries. No credentials,
full prompts, or secrets are included in resolution telemetry.

## Migration impact

Migration 069 converts legacy provider-specific execution targets to `backend` without changing
model provider identity. Migration 070 permits one active tenant default, expands explicit host
health states, and adds its concurrency guard. Existing records are preserved. Missing bindings
are lazily backfilled by `ensureDefaultRuntimeBinding` on first chat, after real adapter
availability is known.
