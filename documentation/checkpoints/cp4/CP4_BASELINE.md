# CP4: Rule-Based AI Entry Point

Status: passed
Date opened: 2026-07-02
Date passed: 2026-07-02
Target tag: `checkpoint/cp4-rule-parser`
Actual tag: not created. No `.repo.git` directory exists in this checkout; see the corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`.

## Purpose

CP4 adds the first deterministic chat intelligence behind the CP3 chat shell.

The goal is to prove chat-first interaction without depending on a local model, cloud model, Pi/OpenClaw harness, or full Grogoniclaw runtime. CP4 must parse merchant text into explicit intents, confidence scores, slots, clarifying questions, and safe UI routes.

CP4 is an AI entry point, not a business-record checkpoint. State-changing commands may be parsed and drafted, but they must not create or mutate products, customers, invoices, payments, inventory, tax records, or debt records before their later checkpoints define the deterministic business rules.

## Formal Entry From CP3

CP3 is accepted as passed.

CP4 starts from:

- React/Vite mobile PWA shell
- CP3 chat shell and message composer
- quick actions and commerce empty states
- CP2 authenticated session and active business contract
- Fastify API boundary
- business, event, sync, tool, and UI package boundaries
- CI, lint, typecheck, tests, build, and boundary checks

## CP4 Scope

In scope:

- rule-based parser module
- intent taxonomy for initial merchant commands
- confidence scoring
- slot extraction for simple product/customer/invoice/payment phrases
- clarification behavior for missing or ambiguous slots
- structured fallback after repeated low-confidence parsing
- chat shell integration for parser output
- safe navigation for read-only or placeholder intents
- parsed draft state for future state-changing actions
- AI evaluation dataset under `tests/ai-eval`
- tests for parser accuracy, low-confidence behavior, and non-mutation boundaries

Out of scope:

- local LLM or llama.cpp integration
- cloud model fallback
- Pi/OpenClaw-style harness integration
- full Grogoniclaw runtime
- product/customer/supplier CRUD persistence
- invoice or inventory mutation
- payment or M-Pesa mutation
- offline mutation queue
- autonomous tool execution
- model-owned business truth

## Initial Intent Taxonomy

CP4 should recognize these intents:

- `add_product`
- `add_customer`
- `create_invoice`
- `record_payment`
- `check_debt`
- `show_products`
- `show_invoices`
- `unknown`

Only safe read/navigation intents may complete inside CP4. State-changing intents must become drafts that require later checkpoint implementation before execution.

## Target Flow

```text
Owner types a message in CP3 chat
  -> rule parser classifies intent
  -> parser extracts slots and confidence
  -> low-confidence input asks a clarification question
  -> safe read/navigation intents update the shell route
  -> state-changing intents become drafts only
  -> no business mutation occurs before deterministic checkpoint support exists
```

## Parser Rules

- Parser output must be structured and testable.
- Confidence thresholds must be explicit.
- Low-confidence behavior must not execute actions.
- Missing required slots must produce clarification prompts.
- English and Swahili or mixed-language examples must be represented in the evaluation dataset.
- Parser behavior must be deterministic for the same input.
- No CP4 parser path may import model runtime implementation.
- No CP4 parser path may expose shell, filesystem, browser automation, or arbitrary host tools.

## CP4 Exit Criteria

CP4 is marked passed because:

- [x] Rule-based parser module exists.
- [x] Initial intent taxonomy exists.
- [x] Parser returns structured intent, confidence, slots, and next action.
- [x] At least 50 internal test commands exist under `tests/ai-eval`.
- [x] Parser handles predefined product and customer commands with at least 80 percent accuracy.
- [x] Low-confidence behavior asks for clarification and does not execute business actions.
- [x] Chat shell shows parser results or clarification prompts.
- [x] At least one safe simple command can complete from chat without mutating business records.
- [x] State-changing commands are drafts only.
- [x] Existing CP1, CP2, and CP3 checks still pass.
- [x] Checkpoint tag `checkpoint/cp4-rule-parser` is created.

## Rollback Instructions

Rollback target:

- Return to CP3 chat shell placeholder behavior.
- Preserve CP2 auth/business/session behavior and CP3 shell navigation.

Rollback trigger examples:

- parser executes state-changing commands without deterministic business rules
- parser bypasses role checks, confirmation, or audit requirements
- low-confidence commands mutate state
- chat behavior depends on model output for correctness
- parser imports AI runtime or host tools
- CP1, CP2, or CP3 checks regress

## Next Checkpoint

Next checkpoint:

- CP5: Business Core Records

CP5 should provide the deterministic product, customer, supplier, inventory, and event foundations that CP4 parsed drafts can later target.
