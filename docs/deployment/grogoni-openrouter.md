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
defaults to 2048 (`OPENROUTER_MAX_OUTPUT_TOKENS`). Provider substitution is disabled.

Existing Grogoni conversation history, skills, MCP integration, audit and approval
flows remain authoritative. Model tool requests are proposals; the engine has no
database, shell, filesystem, or business-mutation capability. Memory comes from
authorized request context rather than shared process state.

For always-on execution and durable scheduling, use the optional native service
described in `docs/deployment/native-daemon.md`. It runs separately from Edge;
the request-scoped engine itself does not start a daemon or shell sandbox.
Per-request bounds are not a daily spending cap; set OpenRouter key limits for that.
The initial model transport is non-streaming.

Agent definitions and models remain independently selectable. Additional hosted
models require catalog registration and an `OPENROUTER_MODELS` mapping. ZeroClaw
stays retired: stored definitions that name it run on Grogoni, and `ZEROCLAW_*`
variables are rejected at startup.

Rollback migration `111_openrouter_grogoni_default.down.sql` restores the local
global default; restore deployment overrides to `grogoni`, `smollm2-360m`, `local`
when rolling back application code. Production migration is a separate deployment
step and is not applied by starting the API locally.
