# CP4 Decision Log

Status: passed
Date opened: 2026-07-02
Date passed: 2026-07-02

This file records rule-based AI entry point decisions for CP4.

## Accepted Decisions

| ID      | Decision                                                                                       | Rationale                                                                                    | Impact                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| CP4-D01 | Implement CP4 with a deterministic rule-based parser, not a model.                             | CP0 requires MVP chat behavior before heavier model infrastructure.                          | Parser behavior must be testable, repeatable, and available without llama.cpp or cloud models.        |
| CP4-D02 | Parser output is structured as intent, confidence, slots, and next action.                     | Later business tools need typed, auditable input instead of free-form text.                  | CP4 can connect to CP5+ tools later without replacing the parser contract.                            |
| CP4-D03 | State-changing commands become drafts only in CP4.                                             | Product, customer, invoice, payment, inventory, and tax rules belong to later checkpoints.   | CP4 may parse `add_product` or `create_invoice`, but cannot persist those records yet.                |
| CP4-D04 | Low-confidence or incomplete commands must ask for clarification.                              | The chat shell must not guess for business-sensitive actions.                                | Parser thresholds and missing-slot behavior are part of the acceptance tests.                         |
| CP4-D05 | Safe read/navigation intents may complete inside CP4.                                          | CP3 already has shell routes and empty states that can be reached without business mutation. | Commands such as `show products` may navigate to existing placeholder views.                          |
| CP4-D06 | Evaluation examples must include English, Swahili, and mixed-language merchant phrasing.       | Language preference and Kenya-market usage were established before CP4.                      | `tests/ai-eval` should represent realistic merchant text, not only formal English commands.           |
| CP4-D07 | CP4 parser and chat integration must not import model runtime, host tools, or AI service code. | CP0/CP1 preserve AI/runtime isolation and prohibit unsafe merchant-facing tools.             | Boundary checks should keep CP4 inside app/package code, with no `services/ai-runtime` dependency.    |
| CP4-D08 | CP4 should keep one simple end-to-end command non-mutating.                                    | The roadmap requires one simple chat command to complete, while CP5+ own real record writes. | A safe command can route to an existing shell view or empty state, proving chat-first behavior early. |

## Deferred Decisions

| Decision                        | Deferred To | Reason                                                                  |
| ------------------------------- | ----------- | ----------------------------------------------------------------------- |
| Product/customer persistence    | CP5         | CP4 only parses drafts; CP5 owns business records and validation.       |
| Invoice and inventory execution | CP6         | Invoice totals and stock movement must be deterministic and tested.     |
| Payment and M-Pesa execution    | CP8         | Payment reconciliation and webhook trust belong to payments checkpoint. |
| Grogoniclaw runtime full adapter   | CP10        | CP4 is the first simple parser, not the full runtime.                   |
| llama.cpp local model adapter   | CP11        | Local models remain optional behind `ModelProviderAdapter`.             |
| Durable offline parser queue    | CP7         | Offline mutation queue design should drive persistence choices.         |

## CP4 Boundary Checks

CP4 must preserve these checks:

- Parser does not mutate business records directly.
- Parser does not import AI runtime implementation.
- Chat shell does not expose shell, filesystem, browser automation, or arbitrary host tools.
- State-changing intents require later deterministic business tools before execution.
- Existing CP1, CP2, and CP3 tests continue to pass.
