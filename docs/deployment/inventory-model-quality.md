# Inventory model quality gate

The deterministic inventory executor passing does not establish model quality.
Use the existing operator-configured OpenRouter runtime to evaluate the hosted
model, without changing production policy or adding another dispatcher:

```sh
INVENTORY_BENCHMARK_DATABASE_URL=postgres://localhost/grogoni_inventory_benchmark pnpm eval:inventory:hosted
```

Supply local database authentication through the approved local environment.
Only the dedicated loopback benchmark database is accepted. Each case uses a
fresh schema and synthetic business records; no supplier orders are submitted.
The command loads the existing ignored `.env.openrouter` when present. Never
commit provider credentials or point this command at Neon production.

The command requires both model configurations to complete every fixture
successfully with actual, identified model invocations. Missing credentials,
unavailable inference, skipped cases, malformed proposals, and partial success
all fail the quality gate. The deterministic baseline must also pass. JSON
reports retain actual model output, tokens, latency, and canonical execution
evidence. Keep reports private; do not substitute baseline traces for model calls.

`INVENTORY_BENCHMARK_MODELS` accepts at most two distinct catalog IDs already
mapped by `OPENROUTER_MODELS`. One selected model runs two existing recipes;
this is not evidence of two different models. The ordinary local benchmark
continues to use loopback Ollama unless a provider is explicitly selected.

## Measured hosted result

On 2026-10-16, the configured `gpt-6-luna` model was evaluated on seven fixtures
per recipe, with a deliberately bounded 512-token output allowance per call.
The deterministic baseline passed 7/7. The planning recipe passed 3/7, and the
constraints-first recipe passed 3/7. Failures included empty provider outputs
and malformed or truncated proposals. The required quality gate exited 1.
This is a failed bounded evaluation, not a production model certification or
proof that a larger allowance will pass. No automatic paid retries were made.

A separate evaluation at the runtime's 2,048-token default passed 5/7 and 6/7
respectively. Remaining failures copied source observations into tool arguments
instead of the permitted task-only input. The model instructions now render the
existing procurement tool input contracts; validators and fixtures are unchanged.
After that instruction change, a fresh evaluation started at
`2026-10-16T12:57:28.703Z` passed 7/7 fixtures for each recipe, with 14 identified
hosted model invocations, and 7/7 deterministic baseline cases. The required
quality gate exited 0 at a 2,048-token per-call limit. The planning recipe used
5,429 prompt and 2,451 completion tokens in total; constraints-first used 5,713
prompt and 2,123 completion tokens. This establishes the measured fixture result
for one hosted model with two recipes, not general model safety, future business
outcomes, or production deployment readiness.

Evidence identifiers:

- Fixture SHA-256: `6cc3bccaa5a90776f05e0da3a165ee04768fb055c3d3d1449024a8bff046e9e1`.
- Private full report SHA-256: `b17ac2ca21f34f9e0578a714e1ea7d6539343ad00f41925a2006bf89dd729c18`.
- Local private report: `/tmp/grogoni-hosted-inventory-contract-quality-report.json`.
- Real PostgreSQL benchmark regressions: 9/9 passed, including rejection of extra
  tool arguments and cleanup of the exact interrupted-case schema.

The private report is local evidence, not a deployed durable backup. Re-run the
gate for model, provider, prompt, fixture, or generation-setting changes.

The default runtime allowance is separately configured by
`OPENROUTER_MAX_OUTPUT_TOKENS`; a future evaluation with a different allowance
must record its actual results before claiming readiness. The weak local
smollm2 results likewise remain experimental, not certified.
