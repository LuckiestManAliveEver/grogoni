# CP1 Decision Log

Status: passed
Date opened: 2026-07-02
Date passed: 2026-07-02

This file records engineering foundation decisions for CP1.

## Accepted Decisions

| ID      | Decision                                                                     | Rationale                                                                                                                                                          | Impact                                                                                                                                                                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP1-D01 | Use this folder as the implementation repository.                            | CP0 documents live here.                                                                                                                                           | Source code will be added beside `documentation/`. Correction: no `.repo.git` directory or checkpoint tags were ever actually created; `.git` in this checkout is a normal writable repository — see the corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`. |
| CP1-D02 | Use `pnpm` workspaces for the monorepo.                                      | It is lightweight, common for TypeScript workspaces, and avoids adopting a heavier task graph before the repo needs one.                                           | CP1 will create workspace package boundaries without Nx or Turborepo.                                                                                                                                                                                                                   |
| CP1-D03 | Use React for the mobile PWA frontend.                                       | React has broad PWA support, mature ecosystem coverage, and predictable hiring/maintenance characteristics.                                                        | `apps/web` will be the primary mobile-first app shell.                                                                                                                                                                                                                                  |
| CP1-D04 | Use Node.js with Fastify for service runtimes.                               | Fastify keeps the API boundary small, typed, and operationally straightforward.                                                                                    | `services/api`, `services/sync`, and `services/ai-runtime` should expose explicit HTTP boundaries.                                                                                                                                                                                      |
| CP1-D05 | Use PostgreSQL and Redis for the local foundation stack.                     | The roadmap requires durable business data, event/audit records, sync queues, and later background processing.                                                     | Docker Compose or an equivalent local path must provide both services.                                                                                                                                                                                                                  |
| CP1-D06 | Use Drizzle with committed SQL migrations as the reviewable source of truth. | The data model includes audit-sensitive business records where migration transparency matters, while TypeScript services still benefit from typed database access. | CP1 should establish an initial Drizzle migration path without hiding schema behavior behind model magic.                                                                                                                                                                               |
| CP1-D07 | Keep AI runtime separate from business packages.                             | CP0 requires AI-assisted, not AI-controlled, business execution.                                                                                                   | No business-core package may import agent/model runtime implementation.                                                                                                                                                                                                                 |
| CP1-D08 | Start with a CI skeleton before product code.                                | Baseline checks prevent fragile scaffolding from becoming hidden debt.                                                                                             | Lint, type check, and placeholder tests are part of CP1 completion.                                                                                                                                                                                                                     |
| CP1-D09 | Defer IndexedDB wrapper choice to CP3/CP7.                                   | Local browser storage details depend on the PWA shell and offline sync design.                                                                                     | CP1 can define package boundaries without locking the offline implementation.                                                                                                                                                                                                           |
| CP1-D10 | Defer Pi/OpenClaw and llama.cpp integration work to CP10/CP11.               | CP0 explicitly keeps those behind adapters and outside the first foundation checkpoint.                                                                            | CP1 only creates boundaries where those adapters can later attach.                                                                                                                                                                                                                      |

## CP0 Open Decisions Resolved For CP1

| CP0 ID  | Resolution                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| CP0-O01 | `pnpm` workspace.                                                                                              |
| CP0-O02 | React.                                                                                                         |
| CP0-O04 | Node.js with Fastify.                                                                                          |
| CP0-O05 | Drizzle with committed SQL migrations as source of truth.                                                      |
| CP0-O11 | Correction: no `.repo.git` was ever created; `.git` in this checkout is already a normal, writable repository. |

## Deferred Decisions

| CP0 ID  | Deferred To | Reason                                                                                 |
| ------- | ----------- | -------------------------------------------------------------------------------------- |
| CP0-O03 | CP3/CP7     | Browser local storage choice depends on PWA shell and sync queue design.               |
| CP0-O06 | CP10        | Pi/OpenClaw timing belongs to Grogoniclaw adapter work.                                |
| CP0-O07 | CP11        | llama.cpp path belongs to local model adapter work.                                    |
| CP0-O08 | CP6/CP14    | Tax profile should be tied to invoice/payment implementation and compliance hardening. |
| CP0-O09 | CP16        | SMS provider is public-launch infrastructure.                                          |
| CP0-O10 | CP8         | M-Pesa provider path belongs to payments checkpoint.                                   |
