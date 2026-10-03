# Grogoni Agent Business Runtime

## Architecture

Grogoni treats a model as one replaceable component of a shop-specific runtime. The effective agent is
assembled from the saved agent profile, structured personality and policy, a tenant-bound context
manifest, executable skill bindings, bounded memory, evaluation policy, and the active model
binding.

The shared `ShopAgentRuntime` contract is provider-neutral and serialisable. Every runtime carries
`tenantId`, `shopId`, `agentId`, and `version`. The existing business ID remains the tenancy and shop
boundary; the runtime does not introduce a parallel ownership model.

Configuration remains in the existing `cp2_agent_profiles` record. Revision history, context-source
metadata, owner corrections, and evaluation events use the normalized runtime collections added by
migration `039_agent_business_runtime.sql`. Runtime versions contain configuration and context
references, not copies of product, customer, supplier, order, or receipt datasets.

## Message flow

An authenticated server turn follows this order:

1. Require a business-scoped session and verify runtime readiness.
2. Load the saved active profile on the server; ignore any client-supplied profile prompt.
3. Normalize the message and run deterministic vocabulary/context scripts.
4. Classify intent and resolve the executable tool proposal.
5. Build the current shop runtime and retrieve a bounded set of authorized context.
6. Retrieve only active owner corrections allowed by the memory policy.
7. Compile platform, identity, policy, personality, context, tool, memory, and output rules.
8. Ask the selected provider through the existing provider-neutral model interface when deterministic
   routing did not already resolve the request.
9. Validate the proposal, enforce typed policy and role/confirmation rules, then execute if permitted.
10. Record the runtime version, model route, context count, tool outcome, and evaluation event.

Context scripts therefore remain ahead of general model interpretation. Tool permissions and
confirmation checks remain mandatory even when a script or model proposes an action.

## Replaceable models

Changing a model updates only `AgentModelBinding` and creates a new runtime revision. Identity,
personality, policy, context, skills, memory policy, corrections, and evaluation history remain
attached to the shop. A successful local-model activation still requires installation validation and
a real inference test; cloud fallback still requires explicit consent. Removing or changing a model
also creates a revision so the configuration can be audited and rolled back.

## Readiness and versioning

`GET /businesses/:businessId/agent-runtime/readiness` checks the active profile, tenant/shop binding,
model selection and registry availability, profile state, and skill/tool registry compatibility.
Chat turns stop with an actionable readiness failure rather than claiming the agent is available.

Material profile, context, correction-promotion, and model changes create immutable
`AgentRuntimeVersion` records. Rollback restores a selected snapshot as a new version; it does not
delete or rewrite history.

## API surface

- `GET /businesses/:businessId/agent-runtime`
- `GET /businesses/:businessId/agent-runtime/readiness`
- `GET /businesses/:businessId/agent-runtime/versions`
- `POST /businesses/:businessId/agent-runtime/versions/:version/rollback`
- `GET|POST /businesses/:businessId/agent-runtime/context-sources`
- `GET|POST /businesses/:businessId/agent-runtime/corrections`
- `POST /businesses/:businessId/agent-runtime/corrections/:correctionId/disable`
- `GET /businesses/:businessId/agent-runtime/evaluations`
- `POST /businesses/:businessId/agent-runtime/feedback`

The existing agent-profile and model-activation APIs remain the write paths for their respective
configuration. All routes use existing session, membership, and permission checks.

## Known limitations

- Retrieval is currently bounded lexical matching over the existing in-process/runtime snapshot,
  not an embedding or external search service.
- Context manifests expose references for customer, supplier, receipt, order, and conversation data;
  record bodies continue to be read through existing authorized tools.
- Owner corrections are the durable semantic-memory mechanism in this iteration. General
  conversation memory and reusable workflow promotion are policy-modeled but not automatically
  populated.
- Readiness verifies registered availability and configuration. Device-local runtime health remains
  verified by the existing activation test on that device.
