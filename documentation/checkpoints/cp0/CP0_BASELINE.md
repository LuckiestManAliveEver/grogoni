# CP0: Planning Baseline

Status: passed
Date opened: 2026-07-01
Date passed: 2026-07-01
Target tag: `checkpoint/cp0-planning-baseline`
Actual tag: not created. No `.repo.git` directory exists in this checkout; see the corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`.

## Purpose

CP0 establishes the planning baseline for Grogoni before implementation begins.

The goal is to prevent the project from drifting into premature implementation without a shared understanding of:

- source document authority
- MVP scope
- architecture boundaries
- AI integration boundaries
- UI direction
- checkpoint and rollback policy
- open decisions that must be resolved before CP1

## Source Documents

The source documents remain in `documentation/`.

Authoritative order:

1. `Grogoni doc 5 June ctrl .pdf`
2. `Grogoni_Master_Control_Document_v1.docx`
3. `Grogoni_Master_Control_Document_v1 (1).docx`
4. `Grogoni doc 2 June .pdf`
5. `Grogoni doc 3 june.pdf`
6. `Grogoni doc 1 june.pdf`
7. `Grogoni doc 4 June  (1).pdf`
8. `Grogoni doc 1.0 june (1).pdf`
9. `Grogoni doc 1,1 june.pdf`
10. PNG UI references

Known invalid source:

- `Grogoni doc 4 June .pdf`
  - Broken placeholder.
  - Contains only `Grogoni.markeyl`.
  - Excluded from authority.

## Harmonized Readme

The clean entry point is:

- `documentation/README.md`

That file now harmonizes:

- document authority
- implementation principles
- target system shape
- Pi/OpenClaw and llama.cpp integration approach
- UI direction
- CP0 to CP18 development roadmap
- rollback strategy
- MVP/Beta/Public Launch/Post-launch scope
- Definition of Done
- open planning items

## CP0 Scope

In scope:

- planning baseline
- source hierarchy
- development roadmap
- checkpoint policy
- rollback policy
- decision log
- risk register
- open questions

Out of scope:

- production code
- package installation
- monorepo scaffolding
- service implementation
- UI implementation
- database migrations
- Git remote changes
- deployment

## Baseline Architecture

Grogoni should be implemented as:

```text
Mobile PWA / optional native shell
  -> Application Runtime
  -> Grogoniclaw Runtime
  -> Business Runtime
  -> Data and Sync Runtime
  -> Cloud services
```

The most important boundary:

```text
AI proposes.
Business Runtime validates.
Tool Executor executes.
Events record what happened.
```

## AI Integration Baseline

Current planning position:

- Pi/OpenClaw-style agentic harness may implement Grogoniclaw orchestration.
- llama.cpp may implement local model inference through a model adapter.
- Both must remain replaceable.
- Neither may own business records.
- Neither may bypass permission, confirmation, audit, or business-rule checks.

Initial sequence:

1. Rule-based parser.
2. Grogoniclaw runtime adapter.
3. Optional Pi/OpenClaw harness adapter.
4. Optional llama.cpp model provider.
5. Cloud fallback.

## UI Baseline

The PNG files are accepted as mobile UI references.

They establish:

- light background
- green primary action color
- card-based summaries
- large tap targets
- bottom confirmation action
- quick actions grid
- M-Pesa-style payment familiarity

This does not override the chat-first principle.

Correct pattern:

```text
Chat or quick action
  -> structured preview card
  -> confirmation/edit screen
  -> deterministic execution
  -> event and sync update
  -> agent response
```

## CP0 Exit Criteria

CP0 can be marked passed when:

- `documentation/README.md` exists.
- CP0 baseline packet exists.
- Document hierarchy is explicit.
- MVP scope is explicit.
- Rollback checkpoint policy is explicit.
- Known invalid document is identified.
- Open decisions are listed.
- Git repository status is resolved or explicitly recorded as blocked.

Current status:

- All planning artifacts are created.
- **Correction (added after implementation):** no `.repo.git` directory exists in this checkout
  and no `checkpoint/cp0-planning-baseline` tag was ever created. `.git` in this checkout is a
  normal writable repository. See the corrected Git Directory Note in
  `documentation/checkpoints/CHECKPOINT_LOG.md`.

## Rollback Instructions

Rollback target:

- Restore this CP0 packet.
- Restore `documentation/README.md`.
- Preserve all original PDFs, DOCX files, and PNG references.

Rollback trigger examples:

- roadmap drifts away from the Master Control Document
- implementation begins before CP1 foundation is defined
- AI infrastructure is allowed to mutate business records directly
- marketplace or TIEL work enters MVP without explicit decision update

## Next Checkpoint

Next checkpoint:

- CP1: Repository and Engineering Foundation

CP1 should not start until the open CP0 decisions are accepted or assigned owners.
