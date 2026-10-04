# Shared SmolLM template inference

Status: proposal. This document translates the shared SmolLM `.grogoni.com` template architecture into
Grogoni's current native runtime graph.

## Thesis

Grogoni can run one shared small-model inference service while many merchants, customers, and business
agents use different domain-specific `.grogoni.com` templates. The shared model is an execution target,
not the durable unit of expertise. The durable unit is the validated recipe: context, tools,
execution rules, evaluation evidence, vocabulary snapshot, and lineage.

This preserves the existing agent/model binding system:

- Native runtime bindings remain authoritative for the selected agent adapter, model, artifact, and
  execution host.
- `.grogoni.com` templates attach portable expertise to that runtime after authorization and tenant
  resolution.
- SmolLM2-360M-Instruct is the initial shared default candidate, not a permanent dependency and not
  assumed capable of every task.

## Separation of concerns

```text
Unified chat
  -> Grogoni API control plane
  -> identity, authorization, tenant isolation, conversation state
  -> native runtime binding resolution
  -> promoted .grogoni.com template selection
  -> model/template compatibility check
  -> context, tool, and execution recipe assembly
  -> shared inference host
  -> Grogoni validation, tool execution, persistence, and response streaming
```

The inference host does not own Grogoni business state. It receives bounded request context from the
API, runs the selected model, and streams generated text or structured output back. Neon remains the
system of record for the model registry, runtime bindings, template manifests, approved
vocabulary, business data, execution records, and evaluation evidence.

One shared model never means one shared conversation. Every invocation is isolated by authenticated
user, business, conversation, task, template version, and runtime binding.

## Shared model role

The initial benchmark/default candidate is `smollm2-360m` backed by
SmolLM2-360M-Instruct-compatible GGUF artifacts. Current deployment documents may call the remote
host `backend`, `vercel`, or a provider-specific service name for compatibility reasons; the
runtime graph's `ModelExecutionTarget` is the routing contract that matters.

| Concern            | Initial position                                                  |
| ------------------ | ----------------------------------------------------------------- |
| Model role         | Default small conversational and task-execution candidate         |
| Weights            | Frozen and pinned through model-artifact metadata                 |
| Artifact           | GGUF, quantization recorded on the artifact row                   |
| Host               | Resolved through native runtime binding and `ModelRuntimeAdapter` |
| API access         | Private, authenticated service-to-service request                 |
| Business data      | Supplied per request by the Grogoni API                           |
| Template selection | Grogoni API only                                                  |
| Tool execution     | Grogoni API only                                                  |

The model should be loaded once per warm inference worker and reused across requests when the host
supports that cache. Loading a separate model instance for every template would erase the benefit of
shared inference. A single loaded small model may still execute sequentially or with limited
concurrency depending on CPU, memory, llama.cpp/runtime behavior, and host policy.

Example invocations can share the same loaded model while receiving distinct recipes and state:

```text
Request A: model smollm2-360m, template product-search, business Shop A
Request B: model smollm2-360m, template inventory-management, business Shop B
Request C: model smollm2-360m, template order-processing, business Shop A
```

All three reuse the same model identity and artifact but have separate context, permissions,
vocabulary snapshots, execution records, and output validation.

## `.grogoni.com` recipe model

The canonical `.grogoni.com` format remains
[`.grogoni.com` Model Template format v1](../specs/grogoni-model-template-v1.md). A template is a portable,
versioned recipe artifact. It does not embed model weights and does not replace native model
activation.

For this architecture, each promoted template version contributes three runtime recipes:

- **Context recipe**: relevant catalog, business rules, conversation history, approved vocabulary,
  structured facts, ordering, and token allocation.
- **Tool recipe**: registered Grogoni tool IDs, permitted operations, input/output schemas,
  tool-selection constraints, and permission requirements.
- **Execution recipe**: task decomposition where supported, structured output requirements,
  verification, retry conditions, termination rules, and escalation behavior.

The template declares model requirements and validation evidence. It may list tested or preferred
models, including `smollm2-360m`, but compatibility is still checked against the actually resolved
runtime model for the turn.

## Runtime resolution

Shared-template inference follows the existing order from
[Runtime resolution](runtime-resolution.md) and
[Inference runtime architecture](inference-runtime.md):

1. Authenticate the caller and resolve business, account, conversation, and agent scope.
2. Resolve the active native runtime binding: agent adapter, model candidate, artifact, and
   execution host.
3. Resolve the promoted `.grogoni.com` template for the business, agent, and task.
4. Check template requirements against the selected model and host.
5. Assemble the recipe-specific prompt/context/tool contract.
6. Invoke the resolved `ModelRuntimeAdapter`.
7. Parse and validate output in the API.
8. Execute authorized tools through Grogoni, never through the inference host.
9. Persist the message, execution record, template version, runtime binding, and validation result.

This ordering is intentional. It lets a merchant keep an independently bound model, use fallback
models, or override a runtime as long as the selected template is compatible. If the chosen model is
incompatible, the request fails explicitly instead of silently dropping the template expertise.

## Compatibility and validation

SmolLM2-360M should be treated as a candidate to benchmark, not as proof that every Grogoni task is
solved. Product search, deterministic classification, and concise business actions are reasonable
early targets. Complex planning, multilingual ambiguity, long-horizon negotiation, or high-risk
transaction flows may require a stronger model or a different host.

SmolLM2-360M is the platform-included starting point, not a permanent model lock. A store owner may
replace it through the native runtime binding with any compatible custom model. Custom model
activation must explicitly assign cost responsibility to the merchant; model usage, artifact
storage, and dedicated hosting charges are not absorbed by the shared starter service. Activation
records preserve that responsibility for billing and audit integration. Until a billing provider
is connected, this is an enforced acceptance and attribution boundary, not evidence that a charge
was collected.

Promotion gates for a template version should record:

- template version and vocabulary snapshot;
- tested model IDs, revisions, artifact hashes, and quantization;
- benchmark distribution and report ID;
- required model capabilities and minimum context window;
- allowed tool IDs and required permissions;
- output schema and deterministic assertions;
- observed latency, retry, and failure categories.

The validation record proves that a recipe worked on a particular model/artifact/runtime
combination. It does not make that model the only future execution target.

## Isolation and safety

- Tenant context is assembled only after authenticated authorization.
- Tool declarations inside a template are requests to Grogoni's tool policy pipeline, not authority.
- The inference host receives no database credentials, storage credentials, or MCP credentials.
- Vocabulary canonicalization remains deterministic and exact-match, per the canonical template
  spec.
- Runtime records must include the template version and current vocabulary snapshot so production
  drift is auditable.
- Tool side effects occur only after API-side parsing, authorization, confirmation, and idempotency
  checks.

## Operational implications

The shared host should be operated as a bounded small-model service:

- keep model artifact revision and hash pinned;
- load and cache the model per worker where possible;
- cap input size, output tokens, concurrency, and request duration;
- expose health/readiness without forcing generation;
- return retryable overload errors before queueing unsafe amounts of work;
- measure cold load time, warm latency, memory, cache hits, and template-level failure rates.

The current native runtime graph already supports moving this service between Vercel,
DigitalOcean, Render-private backend services, or future merchant-owned devices without changing
the `.grogoni.com` contract.

## Related documents

- [`.grogoni.com` Model Template format v1](../specs/grogoni-model-template-v1.md)
- [Model Template expertise flywheel](model-template-flywheel.md)
- [Runtime resolution](runtime-resolution.md)
- [Inference runtime architecture](inference-runtime.md)
- [Model Template evaluation](model-template-evaluation.md)
- [Native runtime bindings](native-runtime-bindings.md)
