# Client-first inference architecture

> **Superseded.** Client-first inference ordering (native bridge → browser WebGPU/WASM → owner
> device → cloud fallback) was retired along with the `browser-local`/`installed-app` execution
> targets it depended on — see ADR-device-independent-runtime-and-registry-discovery.md. The
> owner-device broker (`services/api/src/inference/owner-node-broker.ts`) survives as a legitimate
> `remote-shop-device` execution host; everything else this document describes was removed. Kept as
> historical record.

## Runtime order

Grogoni selects inference deterministically from an explicit policy:

1. installed native llama.cpp bridge, when detected and allowed;
2. browser WebGPU;
3. browser WASM CPU;
4. authenticated shop-owner device;
5. explicitly enabled and consented cloud fallback; or
6. a recoverable unavailable state.

The order is configurable. A low-memory tenant policy can put the owner node before WASM. The
router caps fallback candidates with `INFERENCE_MAX_FALLBACKS` and records only provider ID,
runtime, model ID, timing, cache status, fallback count, cancellation, and bounded failure codes.
Prompts and responses are not routing telemetry.

## Components

- Shared contracts live in `packages/shared-types`.
- Browser feature detection, model loading, streaming, cancellation, and IndexedDB state live in
  `apps/web/src/browser-*`.
- Provider-neutral feature flags, capability normalization, routing, adapters, and error mapping
  live in `apps/web/src/inference`.
- The native adapter talks only to a narrow installed-app bridge. An ordinary browser receives a
  safe unavailable implementation.
- The owner-node broker lives in `services/api/src/inference/owner-node-broker.ts`. Render relays
  signed, expiring jobs and chunks; it does not execute them.
- The only permitted backend model execution is the allow-listed cloud fallback in
  `services/api/src/inference/cloud-fallback.ts`. The production Blueprint enables the route, but
  it remains unavailable without a server-only provider key and explicit user consent.

## Browser flow

The user opts into the browser model download. Grogoni feature-detects WebGPU, WASM, Worker,
IndexedDB, storage, memory when available, logical processors, and connectivity. It does not use a
user-agent string as the primary capability decision.

The approved manifest is code/data metadata, not a model bundle. The Worker loads model files
from a trusted HTTPS repository on demand. Transformers.js uses its dedicated browser cache;
Grogoni's versioned IndexedDB records settings and model state separately from conversation
summaries. A cached compatible model is reusable offline.

One chat client message ID is also the browser inference request ID. Streaming updates one pending
assistant placeholder. Completion replaces that placeholder with the persisted assistant reply.
Provider failures remove the placeholder before a configured fallback, avoiding duplicate
assistant messages.

## Policy inputs

The router considers runtime availability, cached model IDs, online state, memory class, model
minimum memory, native permission, owner-node reachability, cloud consent, privacy mode, provider
health, and the tenant's ordered priority. Task type and latency estimates are part of the shared
request/policy boundary and can be weighted in a later health scheduler without changing
providers.

## Safe failure states

Internal errors map to model-not-downloaded, device-not-supported, insufficient storage, shop
device offline, network unavailable, cloud disabled, timeout, or unavailable. Private provider
details are never rendered to ordinary users.

## Feature rollout

The master client-first flag must be on before any new client provider can be selected. Native,
owner-node, and cloud routes have separate deployment gates and user permissions. The production
Blueprint enables those capabilities, but native still requires a detected trusted bridge,
owner-node requires an authenticated same-shop device, and cloud requires explicit consent plus
an allow-listed configured provider. Browser WebGPU and WASM require an explicit model download.

`grogoniclaw-local` remains the deterministic compatibility fallback when no real model route is
available. It is not presented as a general-purpose language model.
