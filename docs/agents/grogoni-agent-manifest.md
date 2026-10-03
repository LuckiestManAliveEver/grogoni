# Grogoni agent manifest

`grogoni-agent.yaml` is the portable, declarative form of an agent. It describes behavior and
requirements; it is not an executable package. The canonical TypeScript contract and validator
are `PortableAgentManifest` and `validatePortableAgentManifest` in `@grogoni/shared-types`. The
machine-readable schema is [grogoni-agent.schema.json](./grogoni-agent.schema.json).

```yaml
schemaVersion: "1"
agent:
  id: portable:shop-assistant
  name: Shop Assistant
  description: Helps manage catalogue, customers, and orders
  version: "1.0.0"
instructions:
  system: |
    Help the shop owner through authorized Grogoni tools.
  files:
    - context/shop-policy.md
capabilities:
  - conversation
  - commerce
tools:
  - name: products.list
    required: false
  - name: orders.create
    required: false
modelRequirements:
  requiredCapabilities:
    - chat
    - tool-routing
  minimumContextWindow: 8192
  hostedAllowed: true
  localAllowed: true
executionRequirements:
  preferredTargets:
    - backend
    - remote-shop-device
  requiresNetwork: false
  requiresFilesystem: false
  requiresNativeBridge: false
permissions:
  toolApproval: writes
  network: restricted
  filesystem: sandboxed
memory:
  scope: shop
```

Instruction files are manifest-relative context documents. Absolute paths, URLs, parent-directory
traversal, executable commands, endpoints, host/device IDs, credentials, and provider model IDs
are rejected. Tools are identifiers only; the trusted Grogoni tool registry supplies implementation,
authorization, input validation, confirmation, and audit behavior.

`preferredModelId` is a preference rather than an embedded model. The runtime may choose another
compatible model when the preferred model is unavailable. Likewise, `preferredTargets` ranks
locations but never embeds a permanent execution host.
