# Business Execution Environment: Phase 1

PHASE: 1 - Environment contract and lifecycle
COMMIT: See the Phase 1 pull request history.
STATUS: Implemented; awaiting final checks and merge.

## Existing Components Reused

The contracts live beside the existing runtime tool contracts in `packages/tool-core`.
Capability names use `RuntimeToolName`; permissions and read-only policy come from
`runtimeToolRegistry`. The environment layer contains no dispatcher, model selection,
business mutations, or authorization replacement.

Instances reference the existing CP2 `businessId`, agent, runtime instance, runtime
session, and handoff task identifiers. There is no second tenant/shop hierarchy.

## New Components

- `packages/tool-core/src/environments/contracts.ts`: versioned manifests, instance
  identity, lifecycle states, and categorized completion evidence.
- `packages/tool-core/src/environments/lifecycle.ts`: deterministic transitions,
  suspension with exact resume state, terminal states, and completion validation.
- `packages/tool-core/src/environments/registry.ts`: trusted definition validation,
  explicit version lookup, defensive copies, and canonical permission derivation.
- `tests/business-environment-contract.test.ts`: contract and lifecycle tests.

`packages/tool-core/src/index.ts` exports these contracts and helpers.

## Database Changes

None. Phase 2 must persist task and instance state in awaited PostgreSQL transactions.
Pure state transitions here do not claim to persist or verify business records.

## Security Considerations

Manifests reject additional fields, including permission or confirmation overrides.
Unknown capabilities and writes in read-only manifests are rejected. Unavailable,
draft, and deprecated definitions cannot pass the capability availability check.
That check is metadata filtering; the canonical runtime must still authorize every
action and enforce confirmations.

Suspended instances cannot pass the running-state guard, and resume must return to
the exact suspended state, including awaiting approval. Completion requires all six
verification categories to pass with evidence references bound to the same task and
instance. Live completion requires committed durability.

## Known Limitations

No environment is registered as active. Policy identifiers are references, not
implemented verifiers or evaluators. This phase does not wire the contract into
runtime sessions, database persistence, chat, or a benchmark runner. Completion
evidence must be produced by trusted server verification in subsequent phases;
these pure helpers do not authenticate evidence supplied by a caller.

Simulation is a declared execution mode only. It must not be enabled in a live
runtime until fixture isolation and external-effect suppression are implemented.

## Validation

- Contract and canonical architecture regression tests: 22 passed.
- Full test suite: 361 files passed, 2,365 tests passed, 190 skipped. Skipped tests
  are not counted as verification.
- Workspace typecheck: passed. Targeted tool-core typecheck passed after the final
  capability schema projection change.
- Architectural boundaries and API route coverage: passed.
- Formatting and lint on changed TypeScript files: passed.
- Full lint, formatting, configured build, and GitHub CI: pending at PR creation.

The first sandboxed full suite failed because test servers could not bind local
ports; it passed outside the sandbox. Plain `pnpm build` requires an API base URL;
the configured build uses `VITE_API_BASE_URL=/api`. PostgreSQL integration testing
is not applicable to this phase because no persistence behavior changes; CI still
runs the existing PostgreSQL regression lane.

## Next Phase

Durable structured business tasks, composed with runtime handoff, following the
audit's persistence and confirmation hardening prerequisites.
