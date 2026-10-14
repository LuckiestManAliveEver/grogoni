# Inventory Replenishment Acceptance Traceability

Scope: the owner's three-day inventory replenishment request within KES 15,000.
This extends the audited capability-first runtime; it does not introduce a
second dispatcher, runtime, model registry, or production business database.

Paths below are relative to the repository. Runtime modules are under
`services/api/src/cp2/domains/agent-runtime/` unless otherwise stated.

| Criterion                              | Implementation                                                                                                                                                                    | Verification                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Resolve business environment        | `inventory-task-controller.ts`, `business-environment-registry.ts`, `business-environment-store.ts`; pinned actual runtime binding and versioned manifest                         | `business-environment-store.test.ts`, `tests/business-environment-contract.test.ts`                                                                     |
| 2. Verify permissions                  | Existing store authorization plus actor/business/session scope checks at native reads, claims, execution and controls                                                             | `business-task-store.test.ts`, `business-task-step-store.test.ts`, `runtime-approval-store.test.ts`, `tests/business-write-permission.test.ts`          |
| 3. Compile structured task             | Shared bounded objective parser and existing tool-core task compiler; immutable admitted task                                                                                     | `inventory-task-objective.test.ts`, `business-task-store.test.ts`, `tests/business-environment-contract.test.ts`                                        |
| 4. Retrieve authorized inventory/sales | `inventory-procurement-store.ts` business-scoped committed source reads                                                                                                           | `inventory-procurement-store.test.ts`                                                                                                                   |
| 5. Calculate stockout risks            | `packages/business-core/src/domains/inventory-replenishment.ts`; confirmed-sales window and fixed-point quantities                                                                | `tests/inventory-replenishment.test.ts`                                                                                                                 |
| 6. Retrieve available suppliers        | `inventory-procurement-store.ts`, `supplier-offer-review.ts`; committed, business-scoped, unexpired all-in quotes                                                                 | `inventory-procurement-store.test.ts`, `tests/supplier-offer-panel.test.tsx`                                                                            |
| 7. Generate recommendations            | Existing planner compares valid supplier offers and allocates finite budget                                                                                                       | `tests/inventory-replenishment.test.ts`, `inventory-procurement-store.test.ts`                                                                          |
| 8. Validate constraints                | Fixed-point quantity/currency checks, minimums/increments, availability, lead times, total budget                                                                                 | `tests/inventory-replenishment.test.ts`, `inventory-procurement-store.test.ts`                                                                          |
| 9. Canonical purchase preparation      | Existing `runtimeToolRegistry`, `createRuntimeTurn`, `executeRuntimeCapability`; `procurement.prepare` persists immutable draft records                                           | `inventory-procurement-store.test.ts`, `business-task-execution.test.ts`                                                                                |
| 10. Approval before submission         | Drafts remain `NOT_SUBMITTED`; no supplier submission adapter is enabled. Existing exact-scope one-time approval and durable rejection protect enabled consequential capabilities | `runtime-approval-store.test.ts`, `runtime-approval-rejection.test.ts`, `tests/runtime-approval-deletion.test.ts`, `tests/inventory-task-card.test.tsx` |
| 11. Verify business records            | `business-task-verification.ts`; independent committed-record reads across six categories, monotonic evidence sequence, no optimistic success                                     | `business-task-verification.test.ts`, `inventory-procurement-store.test.ts`                                                                             |
| 12. Persist execution/evaluation       | Native tasks, environment revisions, write claims, canonical turns, verification reports, report-embedded evaluation                                                              | `business-task-step-store.test.ts`, `business-environment-store.test.ts`, `inventory-procurement-store.test.ts`                                         |
| 13. Record eligible experiences        | `task-experience.ts`, `task-experience-access.ts`; current authorization, verified candidate admission, source-independent validation and existing snapshot persistence           | `task-experience.test.ts`, `inventory-procurement-store.test.ts`, `tests/muse-adoption-runtime.test.ts`                                                 |
| 14. Unified chat outcome               | Existing persisted text-message task reference, `apps/web/src/InventoryTaskCard.tsx`; fresh native results, journal steps, drafts, issues and revision-fenced controls            | `tests/inventory-task-card.test.tsx`, `business-task-routes.test.ts`, `e2e/responsive-accessibility.spec.ts`                                            |

## Failure and Security Coverage

- Missing data, invalid quantities, unavailable suppliers, expired offers and
  insufficient budget stay incomplete or safely abstain: planner, procurement
  and isolated benchmark scenarios.
- Rejected, expired, wrong-actor, wrong-conversation and already-claimed tokens
  cannot authorize another operation: approval store/rejection tests.
- Interrupted execution reconciles committed evidence without re-dispatching
  a possibly executed write: task execution/reconciliation/step-store tests.
- Uncertain persistence cannot become verified completion: task verification,
  procurement and environment lifecycle tests.
- `tests/edge-inventory-persistence.test.ts` exercises the actual Edge route
  factory on PostgreSQL: independently acknowledged drafts, canonical turns
  and verification survive read-committed and repeatable-read outer request
  rollbacks; retry does not dispatch
  another purchase preparation. Its binding-graph check excludes another
  business's models, roles, hosts and installations.
- Tenant boundaries, current authorization, deletion and retention apply to
  native records: environment/task/approval/experience tests and
  `tests/account-deletion-native-runtime-sweep.test.ts`.
- UI review is tested at 320px and 1440px with overflow and accessibility checks;
  execution acknowledgement is displayed separately from verified success.

## Boundaries

This acceptance scope prepares purchase drafts. It does not send supplier
orders, assert supplier acknowledgement, prove future stockouts were avoided,
or award delayed business rewards before observable outcomes. Unknown metrics
remain null/pending. Supplier offers must come from authorized committed data,
not model-generated assumptions. The benchmark documents actual model failures;
a green code suite does not certify model quality or production deployment.

Database migrations are additive and scoped: 113-115 and 117-121. Migration 116
belongs to separate daemon work and is not repurposed. Existing user work on
that branch is preserved. No new migration is needed for the final chat review.

## Final Certification Section

- PHASE: inventory acceptance and Edge persistence certification.
- COMMIT: see the merged `feat/inventory-acceptance-certification` PR and its
  exact checked head in GitHub; this document is versioned with that code.
- STATUS: implementation complete; acceptance remains contingent on the PR's
  complete CI, PostgreSQL and browser checks passing before merge.
- EXISTING COMPONENTS REUSED: canonical runtime, native graph resolver,
  snapshot scope/persistence, procurement, task journal, verifier and chat card.
- NEW COMPONENTS: acceptance traceability and real Edge rollback/isolation tests.
- MODIFIED FILES: Edge domain persistence, Edge native graph scope, inventory
  chat card/styles, component tests and responsive browser certification.
- DATABASE CHANGES: none in this section.
- SECURITY CONSIDERATIONS: follow only authorized binding graph edges; host
  ownership remains checked; preserve no-replay behavior after independent commits.
- TESTS EXECUTED: real PostgreSQL Edge route rollback/retry and tenant graph
  isolation; existing scoped persistence/runtime jobs; Edge route/snapshot unit
  contracts; inventory card component tests; Chrome 320px/1440px accessibility
  and overflow checks; lint, type checks, format, boundaries and build.
- TEST RESULTS: consult the final green PR run for the complete combined suite;
  the traceability table identifies the tests for each criterion.
- KNOWN LIMITATIONS: no supplier submission integration, delayed outcomes
  pending actual observations, weak installed local-model benchmark results.
- REGRESSION RISKS: Edge snapshot transaction boundaries and native graph
  scoping are shared behavior and require full hosted regression coverage.
- NEXT PHASE: production deployment verification with approved service access,
  real tenant source data and an operationally validated model configuration.
