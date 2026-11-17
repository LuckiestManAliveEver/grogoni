# Grogoni and Luna

The default is Shopkeeper on Grogoni with `gpt-6-luna`, served as
`openai/gpt-6-luna` through OpenRouter. No extra process or container is required.

## Deployment

1. Set `OPENROUTER_API_KEY` as a Supabase Edge secret, never a frontend variable.
2. If deployment overrides exist, set `PLATFORM_DEFAULT_AGENT_ADAPTER_ID=grogoni`,
   `PLATFORM_DEFAULT_MODEL_ID=gpt-6-luna`, and `PLATFORM_DEFAULT_EXECUTION_TARGET=backend`.
3. Apply `111_openrouter_grogoni_default.sql` and deploy the API Edge bundle together.
4. Verify first chat and model selection. Explicit shop/account bindings are preserved.

Neon stores state; Supabase runs request-scoped orchestration and calls OpenRouter
over HTTPS. The historical Render blueprint intentionally retains its explicit
local configuration.

Locally, `pnpm dev:api` loads the ignored `.env.openrouter` file.
`pnpm test:live-openrouter` makes small billed direct and Grogoni-engine requests.

## Runtime Safeguards

The built-in engine enforces active-agent checks, isolated per-invocation prompts,
tool allowlist intersection, 128 KiB prompt and 256 KiB output limits, a 120-second turn deadline, cancellation,
and lifecycle events. Each invocation makes at most one model call with no hidden
retry loop. The provider retains token usage and request IDs; its output token cap
defaults to 2048 (`OPENROUTER_MAX_OUTPUT_TOKENS`). Model substitution is impossible: each
request names one model and the answer's model is checked. Host fallback is on (below).

Existing Grogoni conversation history, skills, MCP integration, audit and approval
flows remain authoritative. Model tool requests are proposals; the engine has no
database, shell, filesystem, or business-mutation capability. Memory comes from
authorized request context rather than shared process state.

For durable, scheduled background work, use the daemon lanes described in
`docs/deployment/daemon-lanes.md`: a queue worked by users' open browsers and by
the Edge API's own `daemon_worker` job, with no separate host. The request-scoped
engine itself does not start a daemon or shell sandbox.

## Response speed

Three settings in `services/api/src/inference/openrouter-model-runtime.ts`, read by
`createOpenRouterRuntime`:

- `OPENROUTER_REASONING_EFFORT` (default `low`): how long Luna reasons before its
  first visible token. Sent as `reasoning: { effort, exclude: true }`; `default`
  sends nothing and leaves the provider's own setting. Every call that carries
  images (receipt and chat image transcription, on the chat path and the WhatsApp
  path alike) uses `LUNA_RECEIPT_REASONING_EFFORT` instead, `default` unless set,
  since it feeds money and stock. Daemon lane agents and the inventory benchmark
  share the chat setting; the gate below measured it on the inventory recipes.
  The guest classifier keeps its own `minimal`.
- `OPENROUTER_PROVIDER_SORT` (default `latency`): which host of the same model
  is tried first. It never changes the model. `none` restores OpenRouter's default
  load balancing, which spreads calls over every host of the model, including the
  slower `openai/flex` tier.

Host fallback is on (`allow_fallbacks: true`, chosen by Julien on 2026-11-17) for
the chat adapter and the guest classifier: when the top host fails or is rate
limited, OpenRouter hands the same request to the next host of the same model in
sort order, instead of the call failing. It is not silent: each call records the
host that answered as `providerHost` on its result and on the turn's model trace.
The WhatsApp voice transcriber keeps its own `allow_fallbacks: false`; it has no
host sort and was outside this change. On 2026-11-17, eight hosts served
`openai/gpt-6-luna` (OpenAI standard, fast and flex tiers, three Azure regions, two
Amazon Bedrock endpoints), and the latency sort sent every eval call to Amazon
Bedrock.

All three are trimmed and case-insensitive. Blank means the default, so an empty
secret never selects a faster setting by accident. An invalid
`OPENROUTER_REASONING_EFFORT` or `OPENROUTER_PROVIDER_SORT` stops the Node API at
startup; on the Edge API it logs `openrouter_configuration_invalid` and every model
call answers `MODEL_CONFIGURATION_INVALID` (inbox and delivery keep working). An
invalid `LUNA_RECEIPT_REASONING_EFFORT` logs
`openrouter_image_configuration_invalid` and fails image calls only.

The turn's model trace records `cachedPromptTokens` next to `promptTokens`, so
prompt-cache hits show up per turn. The system message holds only trusted static
instructions; retrieved context and memory go in the user turn, so the prefix
stays stable from one turn to the next.

Measured on 2026-11-17 with the hosted inventory quality gate (14 Luna calls per
run, two recipes × seven fixtures), compared with
`services/api/scripts/compare-inventory-latency.ts`:

| Settings (effort / sort)       | Passed | Model latency p50 | p90     | Completion tokens |
| ------------------------------ | ------ | ----------------- | ------- | ----------------- |
| default / none (before), run 1 | 14/14  | 5270 ms           | 8670 ms | 4892              |
| low / latency (now), run 1     | 14/14  | 2338 ms           | 3669 ms | 3879              |
| default / none (before), run 2 | 14/14  | 5225 ms           | 9510 ms | 4906              |
| low / latency (now), run 2     | 14/14  | 2573 ms           | 3955 ms | 3669              |
| low / none, run 2              | 14/14  | 3917 ms           | 4817 ms | 3086              |
| default / latency, run 2       | 14/14  | 2580 ms           | 3251 ms | 4044              |

Host selection gives most of the gain. Low effort on its own cuts the slow tail
and completion tokens. A live check showed prompt caching still works under
`sort: latency` (4103 of 4105 prompt tokens cached from the second call).
Re-run the gate and the comparison after changing either setting:

```sh
OPENROUTER_REASONING_EFFORT=default OPENROUTER_PROVIDER_SORT=none \
  pnpm eval:inventory:hosted --output /tmp/before.json
pnpm eval:inventory:hosted --output /tmp/after.json
pnpm exec tsx services/api/scripts/compare-inventory-latency.ts /tmp/before.json /tmp/after.json
```

The comparison exits 1 if the candidate passes fewer cases than the baseline.

Per-request bounds are not a daily spending cap; set OpenRouter key limits for that.

## Streaming

When a turn has a watcher (the chat sends `x-grogoni-turn-id`, so the turn has a live
reply stream in `inference/turn-stream.ts`), the adapter calls OpenRouter with
`stream: true` and hands each content delta to the turn stream as it arrives. The
chat shows the reply's message text in its preview bubble
(`createRuntimeReplyTextStream` hides JSON and tool proposals). The validated reply
from the full output still replaces the preview. Calls without a watcher, and every
call that carries images, keep the single-response transport.

A stream that errors mid-way, names another model, or fails validation at the end
clears the preview (a `reset` event) before the failure is reported. On the Edge
API the deferred live call (`edge-model-deferral.ts`) runs under the client's
stream turn id, so the live call streams and later attempts replay its recorded
result without a second provider call. Streamed calls record `firstTokenMs` on the
turn's model trace.

Limits: the turn stream is in memory, so on the Edge API the preview reaches the
client only when its `GET /v1/ai/turn-stream/:turnId` lands on the isolate running
the turn. Otherwise the long-polled reply (supabase-edge-api.md, "Agent turns")
arrives as before.

Measured on 2026-11-17 (`pnpm eval:openrouter-streaming`, five short shop chat
prompts on Luna at the defaults above, each also run unwatched after a warm-up, in
alternating order): every reply previewed, every preview equal to the kept reply.
The first words showed at a median 1186 ms, against 1627 ms for the same prompt's
single-response reply, and the streamed call itself was not slower (median 1464 ms).
The gate also requires that: streamed total at most 1.25x the unwatched total. A
first run without the warm-up and alternation read streaming as slower, because the
second call of each pair always got the first one's prompt cache. The target set
before measuring, a first preview at half the total time or less, was missed. Short
chat replies (26 to 83 tokens) finish within 10 to 450 ms of their first token, so
time to first token, not output length, is most of the wait. Streaming pays off
most on long replies. The eval gates on correctness (every reply previewed, preview
equal to the kept reply, first preview strictly earlier than the reply) and reports
the saving.

Agent definitions and models remain independently selectable. Additional hosted
models require catalog registration and an `OPENROUTER_MODELS` mapping. ZeroClaw
stays retired: stored definitions that name it run on Grogoni, and `ZEROCLAW_*`
variables are rejected at startup.

Rollback migration `111_openrouter_grogoni_default.down.sql` restores the local
global default; restore deployment overrides to `grogoni`, `smollm2-360m`, `local`
when rolling back application code. Production migration is a separate deployment
step and is not applied by starting the API locally.
