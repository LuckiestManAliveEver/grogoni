# Isolated Inventory Benchmark

`pnpm eval:inventory` exercises seven versioned synthetic retail scenarios:
low stock, reorder quantities, budget limits, supplier comparison, purchase
drafts, invalid quantities, and unavailable suppliers.

## Isolation

Set `INVENTORY_BENCHMARK_DATABASE_URL` to a dedicated local PostgreSQL database
whose name matches `grogoni_*benchmark`. Application databases, remote hosts,
URL query overrides, and implicit `DATABASE_URL` fallback are rejected before
database access. To provision it, set `INVENTORY_BENCHMARK_TEST_DATABASE_URL` to
the same dedicated database URL and run
`pnpm exec tsx services/api/src/benchmarks/prepare-inventory-benchmark-database.ts`.
Every case uses a fresh schema and synthetic account/business/source records.
Schemas are dropped after each case, including rejected proposals. The harness
does not contact suppliers, submit orders, or modify production business data.

## Execution and Evidence

The deterministic baseline uses the existing task compiler, controller,
canonical procurement capability, native persistence, verifier, and evaluation
reader. It is not evidence of model performance.

Optional local Ollama configurations make one bounded proposal per scenario.
The existing adapter and runtime parser validate that proposal. Only
`procurement.prepare` with the exact task ID and no additional arguments can
reach the finite canonical executor. Unsafe proposals are failed results;
negative scenarios may safely abstain without claiming native verification.
This measures bounded capability selection, not an open-ended autonomous agent.

The CLI selects at most two installed models. With one installed model it runs
two different prompt recipes on that same model, not two different models.
`INVENTORY_BENCHMARK_MODELS` can restrict selection. Discovery and inference
require a local, credential-free Ollama endpoint. Unavailable configurations
are `NOT_RUN`, never simulated as successful model runs.

The private JSON report defaults to
`/tmp/grogoni-inventory-benchmark-report.json`. It includes fixture version/hash,
provider/model ID, recipe version/hash, bounded raw proposals, actual canonical
traces, independent verification, duration, and available token/latency data.
Unreported model weight versions and metrics remain null. Provider outputs can
vary between runs; the synthetic domain facts and verifier are deterministic.
Failed real-model results remain in the report. Delayed business rewards are
not fabricated. The command fails if the deterministic baseline fails; model
failures are benchmark findings rather than CI infrastructure failures.

## Checks

`tests/inventory-benchmark.test.ts` covers database guards, all seven baseline
scenarios, cleanup, unavailable configurations, and hostile proposal rejection.
Its adapter test doubles test contracts only and are not research results.
Set `INVENTORY_BENCHMARK_TEST_DATABASE_URL` to enable database integration tests;
the PostgreSQL CI job provisions the dedicated database and runs those tests.

## Observed Local Run

On 2026-10-14 the deterministic baseline passed 7/7 scenarios. The installed
`smollm2:360m` model was actually invoked for both recipes: standard planning
passed 2/7, constraints-first passed 1/7. Those passes were safe abstentions on
negative scenarios, not successful model-directed purchase preparations. Other
cases produced invalid proposals or activation/inference timeouts; rejected
proposals did not dispatch business actions. The run shared CPU with local
checks, so its timing is not an isolated performance measurement. These are
two prompt configurations of one model, not a two-model comparison. Its weight
revision was unavailable. This evidence does not establish model suitability
or production readiness. The detailed private report remains at the default
path above; rerunning replaces that local artifact.
