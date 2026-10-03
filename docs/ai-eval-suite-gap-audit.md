# AI eval suite gap audit

## Scope

`tests/ai-eval/` holds six fixture files. Five feed deterministic gate tests (fast, free, run on
every commit); one (`model-fallback-scenarios.ts`) feeds the paid, LLM-judged periodic eval in
`services/api/scripts/run-ai-eval.ts` (`pnpm eval:ai`, also `.github/workflows/ai-eval.yml`
nightly). This audit checked every fixture against the current source of truth it's meant to
mirror and fixed every gap found. All fixes landed in the same commit as this report, with new or
updated tests proving them (CLAUDE.md: no fix without a regression test).

| Fixture                                   | Consumed by                                                  | Source of truth                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cp4-commands.ts`                         | `tests/cp4-rule-parser.test.ts`                              | `RuleIntent`/`ParserNextAction` in `packages/tool-core/src/contracts/runtime.ts`, rules in `packages/tool-core/src/parsers/merchant-command.ts`                                                    |
| `cp10-runtime-commands.ts`                | `tests/cp10-grogoniclaw-runtime.test.ts`                        | `RuntimeToolName` in `packages/shared-types/src`, `createRuntimeToolProposal` in `packages/tool-core/src/parsers/runtime-proposals.ts`, `runtimeToolRegistry` in `packages/tool-core/src/registry` |
| `backend-runtime-status-scenarios.ts`     | `tests/backend-model-runtime-status.test.ts`                 | `apps/web/src/backend-model-runtime-status.ts`                                                                                                                                                     |
| `agent-session-auth-scenarios.ts`         | `tests/native-session-integration.test.ts`                   | `AuthBootstrapState` in `packages/shared-types/src`, `hasServerAuthenticatedSession`/`isAuthBootstrapPending` in `apps/web/src/auth-bootstrap.ts`                                                  |
| `postgres-persistence-queue-scenarios.ts` | `tests/cp2-postgres-store.test.ts`                           | persistence-queue behavior under `services/api/src/cp2`                                                                                                                                            |
| `model-fallback-scenarios.ts`             | `services/api/scripts/run-ai-eval.ts` (paid LLM-judged eval) | same rule parser as above - a scenario only belongs here if it provably misses every rule                                                                                                          |

## Gaps found and fixed

### 1. Real bug: a "model-fallback" scenario didn't reach the model

`model-fallback-scenarios.ts`'s whole premise is merchant messages that "miss every rule in the
deterministic context-script layer" so the eval genuinely exercises a real model call. The
`insufficient-info-product-creation` scenario used the message **"add a new product"**. Verified
against the live parser (`parseMerchantCommand`): this message resolves to intent `add_product` at
confidence `0.99` (max is `0.99`), well above both the `0.44` high-confidence and `0.42`
low-confidence thresholds, and correctly clarifies deterministically ("Which product should I
draft?") without ever reaching a model. The scenario was silently testing behavior the
deterministic layer already guarantees, not the model-fallback path - a paid LLM judge call was
being spent on a case with a fixed, already-correct deterministic answer.

**Fix:** replaced the message with "I got a fresh batch of goods today, not sure how to log it in
the system" - verified to score `0` confidence (intent `unknown`) against every rule, so it
genuinely reaches `createRuntimeTurn`'s model call.

**Regression test added:** `tests/model-fallback-scenarios.test.ts` runs every scenario message
through `parseMerchantCommand` and asserts `intent === "unknown"`. This is a deterministic, free
gate test that makes this exact class of bug structurally impossible to reintroduce - if a future
scenario message accidentally matches a rule, this test fails immediately instead of silently
burning a model call on a non-fallback case.

### 2. Coverage gaps in the deterministic gate-test fixtures

Cross-checked every fixture's values against the full current type/enum it's supposed to exercise.
All existing fixture values were still valid (no stale/removed values anywhere) - the gaps were all
missing coverage, not incorrect coverage. Every added case below was verified by actually running
it through the real parser/mapping (not guessed) before being added.

- **`cp4-commands.ts`** covered 7 of 16 `RuleIntent` values and only the `draft`/`navigate`
  `ParserNextAction` types (never `clarify`, despite `clarify` being a live, frequently-hit path -
  low confidence and missing required slots both produce it). Added: `update_product`,
  `adjust_stock`, `update_customer`, `add_supplier`, `update_supplier`, `update_logistics`,
  `show_reports`, `show_notifications` (English + Swahili phrasing each), plus two `clarify` cases
  (`"add a new product"` missing a product name, `"add customer"` missing a name).
- **`cp10-runtime-commands.ts`** covered 6 of the ~15 `RuntimeToolName`s that `createRuntimeToolProposal`
  can actually produce from a parsed merchant command. (Note: 27 of the 42 total `RuntimeToolName`
  values - `purchase.*`, `sale.record`, `route.*`, `receipt.*`, `commerce.*`, `messaging.send`,
  `workspace.deliver`, `contacts.search`, `network.route`, `product.field.*`, etc. - are not
  reachable through this rule-parser path at all; they're invoked through structured model tool
  calls or context scripts, so they are correctly out of scope for this file and are not counted as
  a gap here.) Added the 10 reachable-but-uncovered mappings: `reports.summary`,
  `notifications.list`, `payments.debtors`, `product.update`, `product.stock_adjust`,
  `customer.update`, `supplier.create`, `supplier.update`, `logistics.update_status`, and
  `unknown.clarify` - each with its real `requiresConfirmation` value read from
  `packages/tool-core/src/registry`.
- **`backend-runtime-status-scenarios.ts`** covered 10 of 14 live error codes in
  `backendRuntimeStatusMessages`. Missing: `MODEL_NOT_LOADED`, `MODEL_STORAGE_NOT_DURABLE`,
  `MODEL_PROBE_FAILED`, `MODEL_HEALTH_CHECK_FAILED` - all four are actively thrown from
  `services/api/src/cp2/domains/agent-runtime/shared.ts` and
  `services/api/src/cp2/domains/messaging/shared.ts`, not dead codes. Added all four, each with a
  `forbidden` substring chosen to catch the exact confusion CLAUDE.md's own test title warns about
  ("explains X without misreporting another failure mode") - e.g. `MODEL_PROBE_FAILED`'s message
  must not also satisfy `MODEL_HEALTH_CHECK_FAILED`'s expectation and vice versa.
- **`agent-session-auth-scenarios.ts`** covered 5 of 8 `AuthBootstrapState` values. Missing:
  `initializing`, `refreshing-session`, `unauthenticated`. Added all three - confirmed against
  `hasServerAuthenticatedSession` (`apps/web/src/auth-bootstrap.ts:23-25`), which returns `true`
  only for `"authenticated"`, so all three are `serverSessionCreationAllowed: false`.
- **`postgres-persistence-queue-scenarios.ts`**: single scenario, matches its one regression
  (burst-write-during-snapshot). No gap found; left unchanged.

## Verification

- `npx vitest run` (full suite) - all pre-existing tests plus the new/expanded ones pass; the only
  skips are pre-existing DB-dependent suites with no `DATABASE_URL` in this environment, unrelated
  to these changes.
- `npx prettier --check` on every touched file - clean.
- Every new fixture value was verified against live `parseMerchantCommand`/`createRuntimeToolProposal`
  output via a throwaway script before being committed to a fixture, not hand-derived from reading
  the rules alone.
- `npx tsc --noEmit` has 426 pre-existing errors on `main` (unbuilt workspace package types,
  `@grogoni/shared-types` etc. - CI's `ai-eval.yml` and `ci.yml` build packages first via
  `pnpm -r --filter "./packages/**" --if-present build`); none of the touched files appear in that
  list, confirmed by diffing the error count against a clean stash of this change.

## What's still out of scope

The 27 `RuntimeToolName`s not reachable via `parseMerchantCommand` (structured tool-call-only
domains: purchases, sales, routes, receipts, commerce, messaging, workspace delivery, contacts,
network, product custom fields) have no eval coverage anywhere in `tests/ai-eval/` because they are
invoked through the model's structured tool-call output or context scripts, not this rule-based
parser. If those domains need golden-set coverage, it belongs in a new fixture exercising the model
tool-call/context-script path directly (out of scope for this audit, which was fixing the _existing_
eval suite against what it already claims to cover).
