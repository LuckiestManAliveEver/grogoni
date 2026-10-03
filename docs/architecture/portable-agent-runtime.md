# Portable agent runtime

Grogoni's invariant is:

```text
Agent != Model != Execution Host
```

The agent is behavior: instructions, capabilities, tool requirements, memory, and permissions. The
model is a swappable inference resource described by capabilities and compatibility. The execution
host is an authorized, health-tracked location where the model/runtime can run.

```text
Portable agent definition
          ×
Compatible model
          ×
Authorized healthy execution host
          ↓
Native runtime binding
          ↓
Conversation turn
```

These are persisted through the existing native graph:

- `cp2_native_runtime_agents`
- `cp2_native_runtime_models`
- `cp2_native_execution_hosts`
- `cp2_native_model_installations`
- `cp2_native_runtime_bindings`
- `cp2_native_runtime_binding_models`
- `cp2_conversations.runtime_binding_id`

No Android or browser-specific agent identity exists. Client capability records describe optional
local inference only. Account-saved manifests and business agent profiles restore the logical agent
on another device without a device link or reinstall.

Connected chat is hosted-first at the availability boundary: on a first turn, the API probes its
configured provider-neutral backend adapters and idempotently provisions a tenant binding. A ready
local completion may be proposed by the client, but the API accepts it only when it matches an
authenticated, ready device/model assignment. Missing WebGPU, WASM, a native bridge, a local model,
or a remote owner node therefore removes candidates; it does not remove the agent.

Local execution remains useful for privacy, offline work, cost, and sovereignty. Remote shop-device
execution remains an authenticated owner-node capability. Neither is a prerequisite for ordinary
chat. Provider identity stays inside model/adapter metadata and is not an execution target.

Imported OSS projects are converted into `PortableAgentManifest` records. Grogoni never treats a
repository's Python/Node/Docker runtime as something that must run on the current Android device.
