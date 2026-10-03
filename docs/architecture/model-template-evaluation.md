# Model Template evaluation and report cards

Evaluation is part of every template's runtime lifecycle, not only a publication gate.

## Suites and cases

A suite belongs to one template and receives a monotonically increasing version. Its cases may be
edited until the first run, then `frozenAt` makes the suite immutable. Each case stores bounded
input, context and tool fixtures, tags, and one evaluator contract:

- `EXACT`: canonical JSON equality.
- `CONTAINS`: recursive JSON subset.
- `SCHEMA`: deterministic required-property and JSON type validation.
- `CONSTRAINTS`: required/prohibited paths and numeric tolerances.
- `TOOL_CALL`: exact tool and canonical arguments.
- `JUDGE`: pluggable rubric and threshold. It fails with `JUDGE_EVALUATOR_UNAVAILABLE` when no
  judge is configured; it never falls back to exact match or a provider implicitly.

## Runs

An evaluation run identifies one frozen suite, candidate version, optional production baseline,
actor, timestamps, detailed per-case results, and aggregate metrics. Candidate and baseline execute
the same cases through the same `TemplateExecutor`. A regression is a case the baseline passed and
the candidate failed.

Metrics are not collapsed into one opaque score:

- task success rate and pass/fail counts;
- structured-output validity and tool-call correctness where applicable;
- median latency and throughput;
- prompt, completion, and total-context tokens;
- artifact size;
- observable memory and estimated cost, otherwise `null`;
- regression count and exact case IDs.

## Report card

`GET /businesses/:businessId/evaluations/:id/report-card` computes the canonical comparison from
persisted run and version data. It includes score delta, prompt-token reduction, approved
corrections incorporated, base model, prior version, and all underlying metrics. The React panel
only formats this response; it performs no evaluation arithmetic.

## Promotion gates

Promotion requires a completed run for that candidate. Configured `maxRegressions` and
`minimumScoreDelta` are checked atomically by the backend. Failure stores a `REJECTED` decision and
marks the candidate failed. Success demotes the prior production version to `PASSED`, activates the
candidate's runtime binding, and retains both histories. Production is never overwritten.

Judge quality, real hardware memory, provider billing, and noisy latency require external
infrastructure. Their nullable fields are intentional; Grogoni must not fabricate them.
