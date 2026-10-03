# Computer Runtime

Computer use is a Grogoni runtime capability family, not a separate agent architecture.

```text
Grogoni Chat -> Agent Runtime -> Capability Router -> computer.* -> ComputerRuntime -> Provider
```

Computer use is also the compatibility fallback for an authorized application whose capability
cannot be reached through Grogoni itself, a native agent, MCP, an API, or an installed integration:

```text
Grogoni agent + bound model -> ComputerRuntime -> ExternalSurface -> authorized application UI
```

The selected Grogoni agent continues to own planning, authorization, task state, handoff, validation,
and the final response. An AI service reached through its website is an external surface, not a
native Grogoni agent, and does not replace either the active agent or its bound model.

## Runtime Concepts

- **Native agent**: a registered runtime implementation participating directly in native bindings,
  runtime instances, capability resolution, and RuntimeHandoff.
- **Native model**: a model independently bound to a native agent through the runtime graph.
- **Tool**: a governed Grogoni runtime capability with validation, risk, and permission metadata.
- **MCP capability**: a programmatic capability supplied through Grogoni's curated MCP boundary.
- **API integration**: an authorized deterministic provider interface.
- **ComputerRuntime**: the governed session, observation, action, approval, takeover, and checkpoint
  capability used to operate interfaces.
- **ExternalSurface**: a provider-neutral descriptor/adapter for a `web`, `pwa`, `desktop`, or
  `mobile-web` interface operated by ComputerRuntime.
- **External agent surface**: an ExternalSurface whose UI happens to expose an AI agent. It remains
  untrusted external content and is not shown in the native agent selector.

`resolveCapabilityRoute` uses this preference order: internal Grogoni capability, native agent, MCP,
API, installed integration, authorized UI through ComputerRuntime, then unsupported. Session
creation fails closed if a programmatic route is declared available or no authorized surface exists.

The permanent contract is `ComputerRuntime` in `packages/shared-types/src/computer-runtime.ts`. It exposes provider-neutral sessions, observations, actions, control mode, profiles, approvals, and action results. It does not expose Playwright, Stagehand, Browserbase, Browser Use, or CDP types.

Every computer session carries an immutable execution envelope:

```json
{
  "executionMode": "computer_use",
  "orchestratingAgentId": "openclaw",
  "orchestratingModelId": "spark",
  "externalSurface": { "id": "closed-agent", "type": "web" },
  "capabilityResolution": {
    "executionMode": "computer_use",
    "reason": "No equivalent programmatic capability is available; using an authorized UI surface."
  }
}
```

Agent, model, and execution host are derived from the active RuntimeHandoff on server-mediated
session creation. They are not accepted as authority from the browser client. The external surface
id is never written as `activeAgent` and is never inserted into the native runtime registry.

`packages/tool-core/src/domains/computer.ts` registers:

- `computer.session.create`
- `computer.session.resume`
- `computer.navigate`
- `computer.observe`
- `computer.click`
- `computer.type`
- `computer.scroll`
- `computer.upload`
- `computer.control.take`
- `computer.control.release`
- `computer.checkpoint`
- `computer.suspend`
- `computer.close`

`packages/tool-core/src/computer-policy.ts` classifies actions as `READ`, `MUTATE`, or `CONSEQUENTIAL` and creates a stable hash over the exact proposed action. This hash is the approval binding primitive.

The capability dispatcher calls `ComputerRuntimeDomain`, which authorizes account/business scope,
evaluates policy, creates approvals, records audit events, and calls `ComputerWorkerClient`.
`HttpComputerWorkerClient` talks to the independently deployed `services/computer-runtime` worker
over a bearer-authenticated private endpoint.

## RuntimeHandoff

Computer state checkpoints through the existing immutable `RuntimeHandoff` protocol. Session id,
control mode, action hash, approval id, current URL, and observation reference live in action
metadata, context references, and artifacts. `RuntimeTaskHead` remains the only mutable active
checkpoint pointer. Migration 087 persists encrypted profiles, approvals, and audits without
creating a second task state machine.

Checkpoint metadata additionally preserves `executionMode`, orchestrating agent/model ids, the
external-surface descriptor, capability-resolution rationale, and opaque profile/observation refs.
Cookies, storage state, passwords, and tokens remain outside portable handoffs.

## Provider Boundary

The initial provider uses Playwright Chromium. Provider types remain inside
`services/computer-runtime`; shared contracts and API domain code contain no Playwright types.
The chat card polls authenticated JPEG frames through the API proxy, so external sites are never
iframe embedded. Human input is accepted only in `HUMAN_CONTROLLED`; release captures a fresh
observation, persists encrypted profile state, checkpoints RuntimeHandoff, and restores agent input.

## Examples

A closed campaign assistant with no supported API can be represented as
`ExternalSurface { id: "closed-agent", type: "web" }`. OpenClaw + Spark remains the active binding,
delegates a subtask through ComputerRuntime, validates the returned untrusted content, and continues
the parent task. Meta Muse is one possible illustrative surface; the core has no Muse-specific code.

A normal SaaS administration console uses the same path, for example
`ExternalSurface { id: "shop-admin", type: "web", provider: "commerce-provider" }`, but only when
an authorized API or installed integration cannot perform the requested operation.

Consequential clicks and submissions remain bound to one-time Grogoni approvals. Page content cannot
change the active agent/model, grant permissions, disable approval, expose credentials, or invoke
unrelated tools. User takeover pauses agent input; returning control always captures a fresh
observation before execution continues.
