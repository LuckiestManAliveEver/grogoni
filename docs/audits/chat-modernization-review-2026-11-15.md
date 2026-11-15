# DeepSeek modernization implementation review — 15 November 2026

The supplied “Grogoni × DeepSeek Chat Demo” document is **partially implemented**.
This review covers the current reply-version implementation and its API/client tests. It is
not the complete upstream file audit, three-browser certification or hardware assessment required
by the document. The earlier audit explicitly records its limited inspection depth; pinned
upstream revisions in that report have not been independently revalidated in this pass.

## Findings, ordered by consequence

1. **Durable queued regeneration is missing; server cancellation is fixed on the Node API only.**
   The regenerate route now observes the client connection (`observeRequestAbort`): Stop or a
   dropped connection cancels the turn, and no version is written even when the model call cannot
   be interrupted (`499 regeneration_cancelled`). Proved end to end over a real socket in
   `tests/conversation-reply-versions.test.ts`; removing the route's signal makes that test fail.
   Still open: on the Edge API regeneration runs inside its request and is replayed around the
   model call; cancellation, reconnect and partial recovery there are untested, and regeneration
   is not on the durable turn queue. Phase 4 is therefore not complete.
2. **Fixed: the paid eval could miss updates to existing business records.**
   The original oracle compared collection lengths and excluded collections using a broad
   name regex. Updating an existing product, payment or permission left its size unchanged.
   It now hashes canonical record contents, preserves nested sequence order and excludes only
   explicitly named turn bookkeeping plus the target reply's expected version fields.
   Regression tests detect same-size stock/permission/task updates and unrelated message writes.
   The first rerun with the stronger oracle failed every case: it hashed `runtimeHandoffs` and
   `runtimeTaskHeads`, the per-turn conversation checkpoint and its pointer, which every turn
   rewrites. The oracle now leaves those two out of the content hash and instead compares what
   the checkpoints claim: every pending action, and every completed action whose tool a
   regenerated turn may not run. Historical run on the live default model through OpenRouter (before round-4 changes): 8 of 8 cases
   graded, safety 1.00, usefulness 1.00, 0 refusals for wanting to act
   (`/tmp/reply-versions/eval/report.json`).
3. **Fixed: each version records a question revision without retaining erased wording.**
   `ConversationReplyVersion.questionRevision` contains the question's pre-inference edit marker,
   or `null` for the unedited question. Omitted means unknown. Reply versions never copy the
   question text. Monotonic edit markers prevent same-millisecond collisions, and edits that restore
   the original wording during inference still refuse the stale result. The client marks an answer
   predating the current edit. Full conversation trees and one-step "edit and ask again" remain open.
4. **Fixed: retry keys are account-scoped and removed on sign-out.**
   Keys are stored under `grogoni:reply-version-requests:<accountId>`; the hook is unavailable
   when signed out; the chat inbox reset that sign-out triggers calls
   `forgetReplyVersionRequests`, which clears memory and every such session-storage entry.
5. **Fixed: responses could outlive their chat context.**
   The hook previously had no lifecycle cleanup. It now aborts pending regeneration on unmount or
   conversation/business change, ignores late responses and errors, and prevents an old request's
   completion from clearing a newer request's busy state. The retry key remains available for replay.
   Regression tests cover unmount and conversation switching, including a transport that ignores
   abort and resolves late.

The architecture explanation now identifies the pre-execution runtime guard as the enforcement
point. A result check after execution cannot reverse an unauthorized tool's side effects. Tests
exercise mutation proposals, approval-gated proposals, computer tools, question deletion/edits,
concurrent regeneration, version limits, retries and authorization boundaries.

## Document coverage

| Phase                       | Assessment                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0: complete source baseline | Partial historical inventory; no independently reproduced full-file baseline here.                                                                                                                                  |
| 1: DeepSeek audit           | Earlier report: 6 full reads, 39 structural inspections, 95 unopened source files. Not complete.                                                                                                                    |
| 2: existing Grogoni chat    | Partial mapping exists; streaming is explicitly not fully audited.                                                                                                                                                  |
| 3: unified engine           | Sibling reply versions implemented using existing messages, networking and sync, each recording a privacy-preserving question revision; full conversation branches and a one-step "edit and ask again" are missing. |
| 4: streaming and recovery   | Existing preview/polling paths; regeneration cancels on client disconnect on the Node API; queued regeneration, Edge cancellation and reconnect certification missing.                                              |
| 5: multimodal               | Existing attachment/product-capture paths; new paste/drop/type-validation work deferred.                                                                                                                            |
| 6: voice                    | Existing capability-detected speech input; new recording-state/transcript-review/read-aloud work deferred.                                                                                                          |
| 7: rich rendering           | Chat remains plain text; safe lazy Markdown/math/diagram work deferred.                                                                                                                                             |
| 8: history portability      | Existing server export; retry keys are account-scoped and cleared on sign-out; chat import and account-scoped local history are not implemented.                                                                    |
| 9: shared accessible UI     | Native accessible version buttons tested; Vercel adoption matrix and Google guidance report missing.                                                                                                                |
| 10: security                | Server-side regeneration guards and tenant/asker tests present; independent complete audit remains open.                                                                                                            |
| 11: performance             | Production payload measured and owner budget repaired by loading workspaces on demand; no streaming, long-history or physical-device comparison.                                                                    |
| 12: certification           | Targeted unit/API tests and typechecks pass; no new three-browser or physical-device certification.                                                                                                                 |
| 13: deliverables            | Earlier audit and architecture exist; full upstream audits, compliance/adoption matrices and certifications missing.                                                                                                |

## Reproduced evidence

- Final combined reply-version API/client/safety-oracle run: 69 tests passed across three files.
- Web, API and shared-types TypeScript checks, package builds, ESM import checks and affected-file lint passed in the feature commit hooks.
- No provider model, credentials, transport or message store was replaced. No DeepSeek source was copied.
- The historical paid evaluation above predates the round-4 oracle; a fresh run is required before claiming a current score. No real commerce transaction or physical-device exercise was performed.

The source checklist's independent security, provider, legal and hardware gates remain separate
release conditions. Neither this review nor passing scripted-model tests closes them.

## Measured bundle correction

The first integrated production build passed compilation but failed the owner-route budget:
197.50 KiB gzip against 185 KiB. Business workspace rendering now loads only when a workspace is
opened, through the existing lazy-module recovery/error-boundary mechanism. The budget measures
all static dependencies, so merely renaming or moving eager chunks cannot pass it.

After rebuilding with the same configuration: initial JavaScript 159.51 KiB gzip (250 KiB limit),
CSS 24.93 KiB (50 KiB), incremental owner route 182.26 KiB (185 KiB). All budgets pass without
raising thresholds. Lazy-recovery, error-boundary and workspace coverage: 31 tests passed.
This measures payload; no latency, memory or physical-device performance improvement is claimed.
Optional large chunks still produce Vite warnings.
