# Browser model manifest

Browser model metadata is defined in `apps/web/src/browser-model-registry.ts`. A manifest entry
contains:

- manifest version and stable model ID;
- display name, architecture, format, and quantization;
- trusted HTTPS repository URL;
- approximate download/runtime memory sizes;
- context window and minimum device tier;
- supported inference runtimes/backends;
- optional SHA-256;
- license metadata and enablement.

No model weight is imported into the frontend bundle. The dedicated Worker passes the approved
repository ID to Transformers.js only after validating HTTPS, hostname, credentials, path prefix,
and the deployment's origin allow-list.

Models are lazy-loaded after explicit user consent. Progress and cancellation are handled by the
existing Worker engine. Ready model metadata is inventoried in the versioned
`grogoni-browser-inference` IndexedDB database, while public model files remain in the Transformers
browser cache. Conversation summaries use separate stores and must never be placed in the public
model cache.

Offline routing requires the selected model ID in the ready cache inventory. Account deletion
clears all inference stores. Removing a model clears model stores and the Transformers cache but
does not delete conversation summaries. Eviction preserves explicitly retained models and removes
older non-retained entries.

Trusted-repository validation is mandatory. An optional `sha256` is manifest metadata for loaders
that expose raw asset verification; the current Transformers.js repository loader does not expose
a reliable whole-repository byte stream, so a populated hash must not be advertised as verified
until the staged custom asset loader verifies every declared file and recovers partial downloads.
