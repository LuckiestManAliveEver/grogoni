# Grogoni Security Audit

## Scope

This document is the Phase 0 audit requested for the security hardening and resilience initiative. It reviews the repository as it exists today and identifies what is already implemented, what is partially implemented, and what remains as a security or infrastructure risk before the next hardening phase.

This audit intentionally stops at the audit step. It does not implement new security controls or change runtime behavior.

## Executive summary

Grogoni already contains a meaningful amount of security infrastructure and resilience logic. The codebase includes:

- HTTP-level request throttling at the API gateway (`services/api/src/app.ts`)
- session and authorization checks with tenant and permission enforcement (`services/api/src/cp2/store.ts`)
- inference protection via bulkheads and circuit breakers (`services/api/src/inference/model-runtime.ts`)
- durable background task leasing and retry logic (`services/api/src/daemon/task-store.ts`, `services/api/src/daemon/worker.ts`)
- browser/computer runtime network restrictions and untrusted-content sanitization (`services/computer-runtime/src/playwright-runtime.ts`, `services/computer-runtime/src/network-policy.ts`)
- structured auth and audit event logging (`services/api/src/cp2/store.ts`)

The main risk is not the absence of all protections. The main risk is that these protections are fragmented across layers and do not yet form a single, unified admission-and-recovery model for expensive agent work. The repository already addresses several classic web and infrastructure risks, but it still lacks a single execution-admission controller for arbitrary agent/model/tool work, and some system boundaries depend on local per-process state rather than cross-instance shared policies.

## High-level architecture findings

### Existing protections already present

1. API gateway throttling
   - Evidence: `services/api/src/app.ts`
   - Observations:
     - `@fastify/rate-limit` is registered globally.
     - Request limits are differentiated by route class (`/auth/` vs general API).
     - A Redis-compatible backend can be injected via `rateLimitRedisClient` for shared counters across instances.
     - `/health` and `/metrics` are explicitly allow-listed.

2. Authentication, session, and authorization boundaries
   - Evidence: `services/api/src/cp2/store.ts`
   - Observations:
     - `requireAnySession`, `requirePinVerifiedSession`, `requireAuthenticatedActor`, and `requireBrowserAuthorizedSession` enforce login state, PIN authentication, and business authorization.
     - `requireMembership` and `requireAuthorizedActor` enforce business membership and permission checks before mutating or reading business-scoped data.
     - Cross-shard business restrictions are checked in runtime binding code to prevent binding a conversation to another shop runtime.

3. Inference resource isolation and provider fault handling
   - Evidence: `services/api/src/inference/model-runtime.ts`
   - Observations:
     - `boundModelRuntimeAdapter()` wraps adapter calls with a bulkhead and circuit breaker.
     - `INFERENCE_BUSY` and `INFERENCE_CIRCUIT_OPEN` are explicit, user-visible failure states rather than silent retries.
     - The same file documents the intended design for bounded concurrency and graceful degradation.

4. Durable background task execution
   - Evidence: `services/api/src/daemon/task-store.ts`, `services/api/src/daemon/worker.ts`
   - Observations:
     - PostgreSQL-backed daemon tasks support enqueue, claim, renew, settle, release, retry, and lease expiration.
     - The worker uses heartbeat renewal, abort deadlines, and lease expiry to handle crashes and stalled workers.
     - The queue is explicitly designed to make at-least-once execution work and to preserve safety when the lease is lost.

5. Computer runtime isolation
   - Evidence: `services/computer-runtime/src/playwright-runtime.ts`, `services/computer-runtime/src/network-policy.ts`
   - Observations:
     - Navigation requests are filtered before loading via `assertNavigationAllowed()`.
     - Private IPs, localhost, and blocked domains are rejected.
     - The browser session sanitizes untrusted page text before it is exposed to agents or persisted.

6. Security audit and event logging
   - Evidence: `services/api/src/cp2/store.ts`
   - Observations:
     - `recordSecurityEvent()` writes structured audit events for authentication flows and account security actions.
     - PIN and MFA failures are rate-limited and recorded with outcome metadata.

---

## Findings by severity

### CRITICAL

#### 1. No unified execution admission controller across agent, model, and tool work

- Evidence:
  - `services/api/src/app.ts` provides gateway-level request throttling only.
  - `services/api/src/inference/model-runtime.ts` budgets inference calls but does not cover every expensive business execution path.
  - `services/api/src/cp2/store.ts` performs authorization and runtime binding checks, but it is not a centralized admission controller for all expensive tasks.
  - `services/api/src/daemon/task-store.ts` is a scheduled-task queue, not an admission gate for every agent/model/tool workflow.
- Risk:
  - An expensive request can still reach the business execution layer without a single enforcement point that checks identity, tenant quota, resource availability, and execution permission together.
  - This is the highest-value gap against the “request should never be able to consume unlimited Grogoni resources” requirement.
- Current state:
  - Partially addressed in component-specific places, but not yet centralized as a single policy boundary.

#### 2. Durable queue is present, but it is not yet the project-wide job backbone for all agent execution and provider recovery

- Evidence:
  - `services/api/src/daemon/task-store.ts` defines a daemon task queue with `enqueue`, `claim`, `renew`, `settle`, and `expireExhausted`.
  - `services/api/src/daemon/worker.ts` implements leases, heartbeats, shutdown handling, and retry-based settlement.
  - `services/api/src/cp2/store.ts` and `packages/shared-types` contain `RuntimeHandoff` runtime checkpoint logic, but the queueing and the checkpointing are not unified into one durable workflow layer for arbitrary business tasks.
- Risk:
  - A provider outage or worker crash may be recoverable for daemon tasks, but the broader agent execution path still depends on separate runtime checkpoint and authorization logic rather than a single durable business workflow boundary.
  - This leaves a gap between “queued infrastructure work” and “critical business executable workflows that must resume safely.”

### HIGH

#### 3. Gateway rate limiting is effective but still coarse and not fully tenant-aware at the edge

- Evidence:
  - `services/api/src/app.ts`
  - `services/api/src/inference/providers/usage-policy.ts`
- Observations:
  - Global `@fastify/rate-limit` is enabled with a default regional limit and an auth-specific limit.
  - The key generator uses `request.ip` at the HTTP layer: `keyGenerator: (request) => ...request.ip`.
  - There are per-tenant/per-user inference budgets in the usage policy layer, but those are not the same as a unified API gateway or tenant request-budget layer.
- Risk:
  - The service has a general request limiter and some per-user/per-tenant inference controls, but it does not yet have a complete per-tenant, per-user, and per-endpoint budget model at the API edge for all expensive endpoints.
  - This leaves room for bursts against expensive routes and business-flattened attack patterns that bypass the coarser global limit.

#### 4. Trusted-proxy handling is not visible in the API build configuration

- Evidence:
  - `services/api/src/app.ts` sets up rate limiting with `request.ip`, but there is no visible `trustProxy` configuration in the Fastify bootstrap.
- Risk:
  - If an API instance sits behind a reverse proxy, spoofed `X-Forwarded-For`/proxy headers can distort the client identity used for rate limits and security telemetry unless the deployment explicitly trusts only the upstream proxy set.
  - This is a classic infrastructure resilience and abuse-control risk.

#### 5. The repository already has strong tenant checks, but no single tenant-isolation enforcement contract for all execution types

- Evidence:
  - `services/api/src/cp2/store.ts` checks business membership and runtime binding ownership before binding or executing runtime work.
  - `services/api/src/cp2/domains/native-runtime/store.ts` and `services/api/src/cp2/domains/runtime-handoff/store.ts` also reject cross-business runtime binding via `RUNTIME_BINDING_FORBIDDEN`.
- Observations:
  - The guardrails are present and well-dispersed.
  - However, they are implemented as many separate business-specific checks rather than one explicit tenant-isolation boundary shared by all expensive execution features.
- Risk:
  - The repo is less vulnerable to direct cross-tenant bugs than a typical greenfield service, but the architecture still relies on repeated validation rather than an explicit “one cross-cutting tenant boundary” contract.

### MEDIUM

#### 6. Browser-level navigation controls are robust but depend on policy configuration being correct and complete

- Evidence:
  - `services/computer-runtime/src/network-policy.ts`
  - `services/computer-runtime/src/playwright-runtime.ts`
- Observations:
  - `assertNavigationAllowed()` blocks localhost/private IPs, forbidden protocols, blocked domains, and optional private-network navigation.
  - Browser sessions are created with a `ComputerNavigationPolicy` passed in from the caller.
- Risk:
  - The security posture is strong when policy is configured correctly, but the actual protection depends on the deployment policy being strict enough for the target environment. A permissive policy would create SSRF and unsafe navigation exposure.

#### 7. There is a good foundation for job recovery, but the queue is not yet extended to a full operational job-history and dead-letter lifecycle for all user-triggered background work

- Evidence:
  - `services/api/src/daemon/task-store.ts` exposes `expireExhausted`, `retry`, `cancel`, `stats`, and `purge` semantics.
- Observations:
  - The queue correctly handles retries and lease expiration, but the current task model is still a generic task scheduler rather than a full business workflow state machine.
- Risk:
  - A misbehaving business workflow can still be retried without a rich check for side-effect idempotency, approval scope, or exact workflow resumption state.

### LOW

#### 8. Security logging exists, but the event model is not yet organized as a single adversarial telemetry set

- Evidence:
  - `services/api/src/cp2/store.ts` includes `recordSecurityEvent` and calls for login, password reset, and MFA flows.
  - `services/api/src/app.ts` logs request metadata and rate-limit failures via Fastify hooks.
- Observation:
  - Structured logs exist, but there is no single repo-wide security-events taxonomy covering all categories required by the prompt: rate-limit violations, tenant-isolation failures, queue stalls, provider outages, and worker crashes in one consistent schema.
- Risk:
  - Operational detection is possible, but not as uniform or complete as it needs to be for a mature business-executable environment.

---

## Repository inventory against the requested security hardening checklist

### API entry points

- `services/api/src/index.ts`
- `services/api/src/app.ts`
- `services/api/src/cp2/routes.ts`
- `services/api/src/mcp/routes.ts`

### Authentication middleware and authorization boundaries

- `services/api/src/cp2/store.ts`
  - `requireAnySession`
  - `requirePinVerifiedSession`
  - `requireAuthenticatedActor`
  - `requireBrowserAuthorizedSession`
  - `requireMembership`
  - `requireAuthorizedActor`
- Related route-level auth enforcement:
  - `services/api/src/cp2/route-helpers.ts`
  - `services/api/src/cp2/routes.ts`

### Tenant isolation

- `services/api/src/cp2/store.ts`
- `services/api/src/cp2/domains/native-runtime/store.ts`
- `services/api/src/cp2/domains/runtime-handoff/store.ts`

### Existing rate limiting

- `services/api/src/app.ts` — HTTP gateway rate limiting
- `services/api/src/inference/providers/usage-policy.ts` — request limiter and cost policy guard
- `services/api/src/cp2/route-helpers.ts` — auth throttling helper

### Existing queues

- `services/api/src/daemon/task-store.ts`
- `services/api/src/daemon/worker.ts`
- `services/api/src/edge-job-runner.ts`

### Background workers

- `services/api/src/daemon/worker.ts`
- `services/api/src/daemon/edge-lane.ts`
- `services/api/src/edge-job-runner.ts`

### Agent execution lifecycle

- `services/api/src/cp2/store.ts`
- `services/api/src/cp2/domains/agent-runtime/store.ts`
- `services/api/src/cp2/domains/runtime-handoff/store.ts`

### RuntimeHandoff implementation

- `services/api/src/cp2/domains/runtime-handoff/store.ts`
- `docs/adr/ADR-durable-agent-execution.md`
- `docs/architecture/runtime-handoff-protocol.md`

### Checkpoint persistence

- `services/api/src/cp2/postgres-store.ts`
- `services/api/src/cp2/store.ts`

### Model provider adapters

- `services/api/src/inference/model-runtime.ts`
- `services/api/src/inference/providers/`
- `services/api/src/inference/providers/inference-router.ts`
- `services/api/src/inference/providers/routed-model-adapter.ts`

### Computer Runtime isolation

- `services/computer-runtime/src/playwright-runtime.ts`
- `services/computer-runtime/src/network-policy.ts`

### Database access patterns

- `services/api/src/cp2/postgres-store.ts`
- `services/api/src/daemon/task-store.ts`
- `services/api/src/daemon/worker.ts`

### Deployment configuration

- `render.yaml`
- `docker-compose.yml`
- `docker-compose.daemon-test.yml`
- `vercel.json`
- `docs/deployment/`

### Existing security tests

- `tests/http-rate-limit.test.ts`
- `tests/phone-pin-continue.test.ts`
- `tests/security-hardening.test.ts`
- `tests/native-daemon.test.ts`
- `tests/inference-router.test.ts`

---

## Architectural conclusion

Grogoni already has a solid base for defense-in-depth. It has:

- rate limiting,
- session + tenant auth enforcement,
- model-circuit protection,
- durable task queues,
- browser navigation filtering,
- runtime checkpoint concepts,
- and operational retry/lease logic.

The remaining gaps are not in the absence of basic controls, but in their consistency and completeness across the full business-execution lifecycle. The missing design element is a single execution-admission layer that governs all expensive user-triggered work before it consumes tenant, model, tool, or browser resources. The second missing element is a unified durable business workflow model that connects the daemon task queue and the runtime handoff/checkpoint system into one recovery story.

These are the highest-priority items for the next phase, after this audit is reviewed.

## Stop condition for Phase 0

This audit is complete. It provides:

- repository evidence,
- a severity classification,
- a gap inventory against the requested hardening prompt,
- and a clear boundary for what remains to be implemented in Phase 1.

No implementation work has been performed beyond this audit artifact.
