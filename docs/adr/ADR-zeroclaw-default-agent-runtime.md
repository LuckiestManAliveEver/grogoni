# ADR: Shopkeeper on ZeroClaw with GPT-6 Luna as the platform default

## Status

Superseded by the local-first runtime ([docs/local-first-cloud-audit.md](../local-first-cloud-audit.md)):
the ZeroClaw engine and hosted GPT-6 Luna were removed, and the platform default is Shopkeeper on
Grogoni's built-in engine with SmolLM2 360M served by Ollama. Stored agents that still name
"zeroclaw" resolve to the built-in engine. Kept for history.

Previously: Accepted. Superseded [ADR-default-runtime-pi-smollm.md](./ADR-default-runtime-pi-smollm.md)
as the platform default.

## Context

A shop that has not swapped anything runs the platform default runtime. That default used to be
the Pi engine with SmolLM2 360M on Grogoni's Vercel inference host. A 360M model is too small to be a
useful shop assistant. With the multi-provider inference router in place, the platform can pay for
a capable cloud model and still keep budgets, usage records and approvals under its own control.

ZeroClaw (<https://github.com/zeroclaw-labs/zeroclaw>, MIT OR Apache-2.0) is a self-hosted agent
runtime: a single Rust binary with an HTTP gateway. It is the real engine this default runs on,
not a label on Grogoni's own loop.

## Decision

Before any swap, a shop runs:

```text
Agent definition:  builtin:shopkeeper ("Shopkeeper")
Agent engine:      zeroclaw (ZeroClaw gateway, POST /webhook)
Model:             gpt-6-luna (OpenAI GPT-6 Luna)
Target:            backend (provider-routed)
Paid by:           Grogoni (platform-included; every other model is merchant-funded)
```

This lives in `repositoryDefaultRuntimePolicy` and `platformSharedModelId`, and it is materialized
in existing databases by migration 103. Operators can still override it with the
`PLATFORM_DEFAULT_*` variables.

### How a turn runs

1. Grogoni builds the prompt exactly as it does for any model: instructions, the tool contract, and
   the conversation.
2. `InferenceRouter.delegate` checks that the bound model is an enabled, provider-routed catalog
   model. It then admits the call against Grogoni's budgets and rate limits.
3. The ZeroClaw adapter sends one `POST /webhook` to the gateway:
   - a fresh `X-Session-Id` for every turn;
   - the request id as `X-Idempotency-Key`;
   - `X-Webhook-Secret` or a paired bearer token for authentication.
4. ZeroClaw calls GPT-6 Luna using Grogoni's OpenAI key and returns `{ response, model }`.
5. The reply is used only if `model` is the bound model. Any other model is rejected with
   `MODEL_UNAVAILABLE` and never accepted silently.
6. The run is recorded as platform-funded usage. Token counts are estimated because the gateway
   does not report usage.
7. Grogoni parses the reply as ordinary model output. A Grogoni tool call is only a proposal, and it goes
   through Grogoni's own validation, permission, confirmation and approval path.

### Boundaries

- **ZeroClaw never acts on Grogoni data.**
  - It gets no Grogoni credentials or tools.
  - The Blueprint runs it under a `readonly` risk profile with `deny_all_tools = true`.
  - It runs as a private Render service that only the API can reach.
- **No cross-shop memory.**
  - Every turn uses a new ZeroClaw session.
  - Gateway session persistence is off.
  - Grogoni supplies the conversation itself.
- **Nothing is ever switched silently.**
  - There is no per-turn fallback from ZeroClaw to another engine or model.
  - Delegated runs have their own circuit breaker, so a ZeroClaw outage does not take OpenAI
    offline for Grogoni's direct calls.
- **On-device choices stay on the device.**
  - ZeroClaw refuses on-device models.
  - The zero-setup repair no longer attaches a hosted fallback behind a binding whose primary
    model is on-device (`browser-local` or `installed-app`). Now that the default is a cloud
    model, that fallback would otherwise move on-device conversations to the cloud.

### Deployments without a ZeroClaw gateway

ZeroClaw is the first choice, not a requirement to boot. If `ZEROCLAW_GATEWAY_URL` is unset, the
engine is resolved once at configuration time: an agent that names `zeroclaw` runs on Grogoni's
built-in engine (`grogoni`).

- The boot log records `runtime.default_engine_resolved`.
- The effective-runtime API reports the engine that actually runs.
- Nothing changes from turn to turn.

### Choosing another engine

A shop swaps engines by choosing another agent definition:

- "Shopkeeper (Grogoni engine)" (`builtin:shopkeeper-grogoni`) runs on Grogoni's built-in engine.
- "Shopkeeper (Pi engine)" (`builtin:pi-assistant`) runs on the Pi engine.

A shop can pick any other model the same way. Those models are merchant-funded.

## Configuration

| Variable                         | Purpose                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ZEROCLAW_GATEWAY_URL`           | Gateway base URL. Render wires the private `hostport`.                                                   |
| `ZEROCLAW_ALLOW_PRIVATE_NETWORK` | Allows plain http and private addresses. Needed for the private-network sidecar.                         |
| `ZEROCLAW_WEBHOOK_SECRET`        | Must equal the gateway's `gateway.webhook_secret`. Render shares the generated value.                    |
| `ZEROCLAW_GATEWAY_TOKEN`         | Alternative to the secret: a bearer token from `zeroclaw pair`.                                          |
| `ZEROCLAW_AGENT_ALIAS`           | Optional ZeroClaw agent alias (`?agent=`).                                                               |
| `ZEROCLAW_TIMEOUT_MS`            | Per-turn timeout. Default 120000.                                                                        |
| `OPENAI_API_KEY`                 | Grogoni's OpenAI key. Set it on the API (health and routing) and as the ZeroClaw service's provider key. |

## Consequences

- New shops get a capable assistant with no setup and no bill. Grogoni carries the cost, capped by
  `INFERENCE_TENANT_DAILY_BUDGET`, `INFERENCE_PROVIDER_MONTHLY_CEILINGS` and the rate limits.
- GPT-6 Luna's price was taken from OpenAI's published rate at seeding time ($0.10 input and $0.50
  output per million tokens). Operators re-verify it through the platform catalog API.
- ZeroClaw's `/webhook` does not stream, so ZeroClaw turns have no live reply preview. The final
  reply arrives as usual.
