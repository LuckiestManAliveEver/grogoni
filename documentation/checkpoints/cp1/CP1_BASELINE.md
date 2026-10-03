# CP1: Repository and Engineering Foundation

Status: passed
Date opened: 2026-07-02
Date passed: 2026-07-02
Target tag: `checkpoint/cp1-engineering-foundation`
Actual tag: not created. No `.repo.git` directory exists in this checkout; see the corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`.

## Purpose

CP1 establishes the engineering foundation for Grogoni before product feature work begins.

The goal is to create a stable, testable repository skeleton with clear runtime boundaries:

- mobile web application shell
- API service
- sync service
- AI runtime service boundary
- shared business, event, sync, tool, and UI packages
- local development services
- lint, type check, test, and CI conventions

## Formal Entry From CP0

CP0 is accepted as the planning baseline.

Accepted CP0 controls remain active:

- Master Control Document is the highest authority.
- MVP begins with a rule-based parser, not a full local LLM.
- AI infrastructure remains replaceable and cannot own business records.
- Business Runtime validates state-changing actions.
- Tool Executor is the only business mutation path.
- Event records are immutable.
- Marketplace and full TIEL remain outside MVP.

## CP1 Scope

In scope:

- monorepo workspace setup
- application and package skeletons
- local development stack definition
- health check route
- formatting, linting, type checking, and test runner setup
- CI skeleton
- environment variable conventions
- initial migration structure
- feature flag policy stub

Out of scope:

- account/auth implementation
- merchant business setup flow
- production payment integration
- invoice, stock, customer, supplier, or report feature logic
- full Grogoniclaw runtime implementation
- llama.cpp integration
- marketplace or TIEL implementation

## Target Repository Shape

```text
apps/web
services/api
services/sync
services/ai-runtime
packages/business-core
packages/shared-types
packages/event-core
packages/sync-core
packages/tool-core
packages/ui
infra
tests
```

## CP1 Exit Criteria

CP1 is marked passed because:

- [x] Workspace package manager installs from a fresh clone.
- [x] Expected monorepo directories exist.
- [x] Local development stack is documented and can boot.
- [x] PostgreSQL and Redis are available through local Docker Compose or an equivalent documented path.
- [x] API health check endpoint works.
- [x] Formatting, linting, type checking, and unit test commands exist.
- [x] CI skeleton runs lint, type check, and tests.
- [x] Initial migration structure exists as `000_initial` or equivalent.
- [x] Environment variable conventions are documented.
- [x] No business feature code depends on AI infrastructure.
- [x] Checkpoint tag `checkpoint/cp1-engineering-foundation` is created.

## Rollback Instructions

Rollback target:

- Return to the CP1 skeleton and initial migration structure.
- Preserve CP0 planning documents and source artifacts.

Rollback trigger examples:

- foundation tooling cannot boot from a fresh clone
- application code depends directly on agent or model infrastructure
- local stack cannot provide repeatable PostgreSQL and Redis services
- CI cannot run deterministic baseline checks

## Next Checkpoint

Next checkpoint:

- CP2: Account, Auth, and Business Creation

CP2 should not start until CP1 exit criteria are passed and tagged.
