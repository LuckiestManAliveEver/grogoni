# Agent model runtime connection

Grogoni keeps one business agent and one messenger pipeline. Installed GGUF files live in OPFS under
the existing `grogoni-ai-models` private directory. The browser stores a device-scoped installation
record and assignment; the API stores only safe installation metadata and the assignment. A raw
Android filesystem path is never sent to the API or telemetry.

## Runtime boundary

The adaptive runtime uses an Android-injected `window.GrogoniAgentModelRuntime` bridge when available,
otherwise it uses the existing Wllama llama.cpp/WASM engine for compatible OPFS GGUF files. Wllama
owns a dedicated inference Worker; model loading and token generation do not execute the heavy
llama.cpp loop on the React/UI thread. Descriptors contain an opaque OPFS storage key, not a native
path.

Activation, launch restoration, and chat share one in-memory runtime registry. A successful health
check therefore registers the same loaded handle that chat resolves; chat does not create a second
engine and load the artifact again. Switching models unloads the previous handle only after the
replacement passes readiness and its assignment is saved.

The bridge should:

- resolve the opaque storage key through app-private storage;
- expose bridge API version `1.0.0` or newer;
- hash the actual GGUF bytes with SHA-256 and compare them with the package checksum;
- verify optional Ed25519 package signatures using an app-pinned trusted key;
- report supported architectures, quantizations, and currently available memory during inspect;
- limit context to the descriptor/context request and use conservative thread counts;
- inspect available memory before allocating model buffers;
- keep one loaded conversational model and single-flight duplicate loads;
- honor cancellation and release native buffers on unload or process teardown;
- return safe error codes without logging prompts, messages, private paths, or customer data.

Readiness is established only by real inference of `Reply with exactly: GROGONI_MODEL_READY`. The
test result is configuration metadata and is not written into the customer conversation.

## Activation lifecycle and source of truth

The UI projects durable artifact and binding records plus transient runtime work into one vocabulary:
`available`, `downloading`, `verifying`, `installed`, `loading_runtime`, `activating`, `active`,
`activation_failed`, `incompatible`, and `removing`. Only installation and binding/readiness records
survive reload. A downloaded artifact alone always projects to `installed`, never `active`.

Activation is a request-scoped finite state machine: `idle` → `validating` →
`creating_runtime` → `loading_model` → `binding_agent` → `active`, with terminal `failed` and
`offline_blocked` states. A request owns one `AbortController`; API operations are bounded to 45
seconds and the complete local load/readiness operation is bounded to 120 seconds. The Wllama
adapter also bounds model load to 90 seconds and generation to 120 seconds. Timeout or cancellation
terminates the worker-backed engine so late work cannot publish a stale ready handle. The runtime
emits `MODEL_LOAD_STARTED`, progress, `MODEL_READY`, or `MODEL_LOAD_FAILED`.

The server assignment is the configured account/agent source of truth. The browser mirror is scoped
by business and device and is the source of truth for whether this device has the artifact and a
runnable local handle. The mirror is written only after the model file validates, the runtime
positively acknowledges readiness, and the hidden readiness inference succeeds. A different device
can see the configured model but reports `PREFERRED_MODEL_NOT_INSTALLED_ON_DEVICE` until it downloads
and verifies its own artifact.

Online activation probes the authenticated API instead of trusting `navigator.onLine`, creates or
restores a non-empty managed runtime session, and then persists the ready binding. A page reload
revalidates server runtime liveness through `RuntimeManager` and lazily reloads/tests the local
model. Failed activation never overwrites the previous ready assignment. Missing/corrupt OPFS bytes
change installation metadata to failed/corrupt and require a new download.

The application service worker handles interactive model/assignment/runtime mutations network
only. On connection failure it returns typed `interactive_model_offline` HTTP 503 JSON with
`Cache-Control: no-store`; it has no Background Sync handler and never caches authenticated model
activation responses.

## Manual Android/PWA verification

1. Install an Apache-2.0 GGUF from **Android model library** and confirm the UI says it is installed
   but not attached.
2. Reload the app and confirm the same installation appears without a duplicate file.
3. Open **Agent model** → **Choose model** and verify compatible models sort first, while
   incompatible/restricted models are disabled with a reason.
4. Tap **Use with this agent** with the native bridge disabled. Confirm activation fails with
   `RUNTIME_UNAVAILABLE`, no Ready label appears, and the previous assignment remains active.
5. Enable the Android llama.cpp bridge, attach again, and inspect native logs to confirm one load
   and one readiness generation. Confirm the UI reports the exact attached model as Ready.
6. Force-close and restart Android. Open Agent settings and confirm the device assignment is
   restored; send a message and confirm lazy runtime reinitialization.
7. Set **Local only**, disable networking, restart the app, and send a message. Confirm no API
   inference request occurs and the response status identifies `<model> · Local · In use`.
8. Set **Local first** with each fallback policy. Force the matching local error and confirm cloud
   inference happens only when the selected policy permits it, with a visible fallback reason.
9. Corrupt or delete the GGUF file. Confirm test/chat shows File missing or Failed without crashing
   the chat, and cloud is not used in Local only mode.
10. Switch between two installed models. Force the second model's readiness test to fail and
    confirm the first model remains assigned and its runtime handle is usable.
11. Remove the active model from the agent, then remove its file. Confirm native buffers unload,
    the assignment clears, and existing cloud behavior is restored.
12. Repeat on a low-memory Android device or emulator. Confirm unsafe loads stop with
    `INSUFFICIENT_MEMORY` and the application remains responsive.
13. Start activation and tap **Cancel activation**; confirm the button returns to retry and a late
    bridge/API response does not change the selected model.
14. With the PWA offline, activate a fully installed model and send a short chat message; confirm
    the native model supplies the visible reply. Then try a hosted fallback and confirm the exact
    “Connect to the internet to activate this model.” message appears with no queued mutation.

## End-to-end path

```text
Marketplace / model library
        |
        v
OPFS artifact + verified installation metadata
        |
        v
Shared runtime registry
   +----+----------------+
   |                     |
Wllama Worker     Installed-app bridge
   |                     |
   +----------+----------+
              v
     readiness inference
              |
              v
device agent/model assignment
              |
              v
provider-neutral chat dispatcher
              |
              v
local generation -> authorized Grogoni tool boundary -> streamed response
```

The separate Transformers.js/WebLLM browser catalog remains another adapter inside the same
provider-neutral router. Neither local adapter silently changes to cloud. Repository-backed agents
are metadata/instructions unless a real isolated backend adapter is composed; general Grogoni agent
readiness does not advertise repository source as executable.

## Composer actions

The conversation composer shows the active agent, one `+` control, the message field, and Send.
The existing accessible `StackedModule` primitive contains Camera (seller mode), photos/files,
voice, command (seller mode), SMS, and platform sharing. It behaves as a safe-area-aware bottom
sheet on narrow screens and a constrained dialog on wide screens, traps focus, closes on Escape or
down-swipe, and restores focus to the `+` control.
