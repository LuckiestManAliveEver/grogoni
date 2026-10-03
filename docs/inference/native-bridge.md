# Native llama.cpp bridge

The web application never attempts to run native llama.cpp directly. It feature-detects
`globalThis.grogoniNativeInference`, validates the required methods, and otherwise uses a safe
unavailable bridge.

An installed Capacitor, Tauri, Electron, or Android shell may expose:

- `getStatus()`
- `listModels()`
- `loadModel(modelId)`
- `generate(request, onChunk)`
- `cancel(requestId)`

The shell must validate every field against the shared inference contracts. Model IDs resolve
through an app-owned allow-list; remote callers may not supply arbitrary file paths. The bridge
must expose no shell command, filesystem, database credential, or general code-execution
primitive.

## Installed GGUF package attestation

`GrogoniAgentModelRuntime.inspect()` is the authoritative pre-load gate for installed GGUF models.
The current bridge API requires version `1.0.0` or newer and returns:

- available memory and estimated model memory;
- supported GGUF architectures and quantizations;
- the SHA-256 digest calculated from the app-private GGUF bytes;
- whether that digest matches the requested package metadata;
- whether an optional Ed25519 package signature was verified with an app-pinned key;
- the trusted signing-key identifier.

The web runtime rejects loading before inference when the bridge API is too old, memory is
insufficient, architecture or quantization is unsupported, a pinned checksum differs, or a signed
package cannot be verified. Public keys supplied inside a downloaded package are not trust roots;
the installed app must pin or securely provision allowed keys.

Unsigned legacy models remain identifiable as such and must still pass bridge inspection. New
catalog packages should provide `packageManifestVersion`, `packageSignature`, and
`packageSigningKeyId` together with a pinned SHA-256 checksum.

For a loopback transport, bind to loopback only, authenticate every request with an app-generated
short-lived token, restrict allowed origins to the installed app origin, reject replay, and rotate
the token when the app restarts. Never accept a job for another tenant or an agent not assigned to
the device.

Native inference remains behind `VITE_INFERENCE_NATIVE_BRIDGE_ENABLED` plus per-user permission.
Detection alone is not consent.
