# DeepSeek modernization implementation review — 15 November 2026

The supplied “Grogoni × DeepSeek Chat Demo” document is **partially implemented**.
This review covers the current reply-version implementation and its API/client tests. It is
not the complete upstream file audit, three-browser certification or hardware assessment required
by the document. The earlier audit explicitly records its limited inspection depth; pinned
upstream revisions in that report have not been independently revalidated in this pass.

## Findings, ordered by consequence

1. **Server cancellation and durable queued regeneration are missing.**
   `services/api/src/cp2/domains/messaging/routes.ts` awaits regeneration inside the request.
   `apps/web/src/features/reply-versions/useReplyVersions.ts` aborts the browser fetch only.
   A turn may finish after Stop or after an Edge request timeout. The UI correctly says it stops
   waiting, and unsettled retry IDs are retained. This does not meet phase 4's server cancellation,
   reconnect and partial-recovery requirements. Move regeneration to the existing durable turn
   queue and test process termination, replay and cancellation before claiming completion.
2. **Fixed: the paid eval could miss updates to existing business records.**
   The original oracle compared collection lengths and excluded collections using a broad
   name regex. Updating an existing product, payment or permission left its size unchanged.
   It now hashes canonical record contents, preserves nested sequence order and excludes only
   explicitly named turn bookkeeping plus the target reply's expected version fields.
   Regression tests detect same-size stock/permission/task updates and unrelated message writes.
   Historical “safety 1.00” describes the old narrow oracle only. The paid eval has not been
   rerun with the stronger oracle, so no new live-model score is claimed.
3. **Question wording is not preserved with each version.**
   `ConversationReplyVersion` retains ID, text and timestamp, but no source-question revision.
   `requireRegenerableReply` uses the current question text; editing it between versions leaves no
   record of which wording each answer addressed. Editing during generation is tested and refused.
   Capture a source message revision/hash and immutable wording before implementing “edit and ask
   again.” Do not describe the sibling-version model as a complete parent-linked conversation tree.
4. **Account-scoped retry-key storage remains incomplete.**
   `reply-version-requests.ts` uses one session-storage key and a process-wide singleton indexed
   by message ID. No account-specific namespace or logout cleanup is implemented there. The values
   are retry IDs, not message bodies or provider credentials; server authorization remains required.
   Add account scoping and switching/logout coverage for phase 8's browser-storage requirement.
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

| Phase                       | Assessment                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0: complete source baseline | Partial historical inventory; no independently reproduced full-file baseline here.                                                               |
| 1: DeepSeek audit           | Earlier report: 6 full reads, 39 structural inspections, 95 unopened source files. Not complete.                                                 |
| 2: existing Grogoni chat    | Partial mapping exists; streaming is explicitly not fully audited.                                                                               |
| 3: unified engine           | Sibling reply versions implemented using existing messages, networking and sync; full conversation branches and question revisions missing.      |
| 4: streaming and recovery   | Existing preview/polling paths; queued regeneration, server cancel and reconnect certification missing.                                          |
| 5: multimodal               | Existing attachment/product-capture paths; new paste/drop/type-validation work deferred.                                                         |
| 6: voice                    | Existing capability-detected speech input; new recording-state/transcript-review/read-aloud work deferred.                                       |
| 7: rich rendering           | Chat remains plain text; safe lazy Markdown/math/diagram work deferred.                                                                          |
| 8: history portability      | Existing server export; new import and complete account-scoped history/retry lifecycle not implemented.                                          |
| 9: shared accessible UI     | Native accessible version buttons tested; Vercel adoption matrix and Google guidance report missing.                                             |
| 10: security                | Server-side regeneration guards and tenant/asker tests present; independent complete audit remains open.                                         |
| 11: performance             | Production payload measured and owner budget repaired by loading workspaces on demand; no streaming, long-history or physical-device comparison. |
| 12: certification           | Targeted unit/API tests and typechecks pass; no new three-browser or physical-device certification.                                              |
| 13: deliverables            | Earlier audit and architecture exist; full upstream audits, compliance/adoption matrices and certifications missing.                             |

## Reproduced evidence

- Final combined reply-version API/client/safety-oracle run: 45 tests passed across three files.
- Web, API and shared-types TypeScript checks, package builds, ESM import checks and affected-file lint passed in the feature commit hooks.
- No provider model, credentials, transport or message store was replaced. No DeepSeek source was copied.
- No paid model evaluation, real commerce transaction or physical-device exercise was performed.

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
