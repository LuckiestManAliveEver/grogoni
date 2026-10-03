# ADR: Explicit device-local models

## Status

Accepted. This partially supersedes
[ADR-device-independent-runtime-and-registry-discovery.md](./ADR-device-independent-runtime-and-registry-discovery.md):
the `browser-local` and `installed-app` execution targets are reinstated in a new form.

## Context

The earlier ADR retired on-device models for three reasons:

1. **Silent fallback.** A device could answer with a different, privately downloaded model
   without the person knowing.
2. **Device-bound configuration.** A model was assigned per device (`localStorage`), so a second
   device of the same shop had no working agent.
3. **Maintenance and security surface.** Several engines, chunked GGUF downloads into Postgres,
   and client-side inference paths all competed with the hosted default.

The product owner asked to bring on-device models back as a normal choice next to hosted models.
The multi-provider inference router
([multi-provider-inference-implementation.md](../architecture/multi-provider-inference-implementation.md))
gives a way to do that without reopening those problems.

## Decision

Device-local models are ordinary catalog models whose `inference.executionTarget` is
`browser-local` or `installed-app`, served by the router's `local` provider.
`ModelExecutionTarget` includes those two targets again.

**Explicit, per-shop choice.** A shop picks an on-device model in the model switcher, like any
other model. The binding is shop-level (reason 2 above no longer applies): every member's device
can serve that member's own turns once the model is installed on that device.

**The server keeps authority.** The turn pipeline is unchanged:

1. The server resolves the binding, builds the prompt (instructions, minimized business context,
   history), and hands only generation to the device through the `DeviceInferenceBroker`.
2. The device returns plain model output.
3. The server parses, validates, authorizes and confirmation-gates that output exactly as it does
   for a hosted model. Devices never execute tools.

**Scoping.** A device job goes only to:

- authenticated sessions of the account whose turn it is;
- a device that reports the model as installed;
- the turn the device is watching (`x-grogoni-turn-id`).

Results need a one-time token and are size-bounded.

**No silent fallback (reason 1).** If no device with the model is online within 20 seconds, the
turn fails with `LOCAL_DEVICE_UNAVAILABLE`. It never switches to another model unless the shop
configured an explicit fallback policy (brief §16). The UI labels on-device models everywhere they
appear.

**One engine, pinned provenance (reason 3).** Only WebLLM, in
`apps/web/src/device-model-engine.ts`, which the retired-reference guard now permits. A model is
loadable only when two things are both true:

- it is an entry in the installed `@mlc-ai/web-llm` package's own prebuilt list;
- its weights come from `https://huggingface.co/mlc-ai/`.

The catalog can name a model but cannot point a browser at an arbitrary URL. Nothing is stored in
Postgres; the browser cache holds the weights.

**Anonymous callers are refused.** Storefront visitors and MCP tokens without an account are
refused with `LOCAL_EXECUTION_REQUIRED`. A buyer's device never runs a shop's model.

**What `installed-app` means.** The device runs Grogoni as an installed app (standalone display
mode), or is a native client implementing the same claim/complete HTTP protocol. A
`browser-local` model runs on either kind of device; an `installed-app` model runs only on
installed-app devices.

## Consequences

- Members choose privacy and zero cost per token over quality. The catalog seeds three WebLLM
  models (SmolLM2 360M, Qwen2.5 0.5B, Qwen3 1.7B).
- A member chatting from a device without the model gets a clear message to install it
  (Settings → AI providers → On-device models) instead of an answer from something else.
- Activation cannot probe a device. Health checks report `DEVICE_EXECUTED`, and each device
  verifies the model when it installs it.
- Public storefront replies cannot use an on-device model. Shops that want storefront replies
  keep a hosted model.
- The broker is in-process, like the owner-node broker, which matches the single-writer API
  deployment.
