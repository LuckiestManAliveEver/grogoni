# Business Task Reconciliation

`createPostgresBusinessTaskReconciler` repairs an interrupted native step journal using
already committed canonical runtime evidence. It has no dispatcher, model, approval-claim,
supplier submission or runtime-turn creation dependency. It cannot replay a write.

The caller supplies an authenticated business scope and current environment revision.
Reconciliation locks the unexpired environment before the step, matching execution and
verification lock order. Suspended environments need an explicit resume; terminal environments
and failed steps cannot be reopened. Current capability authorization is required again.

A `RUNNING`, `AWAITING_APPROVAL` or `INCONCLUSIVE` journal can advance only when exactly one
committed completed turn matches the immutable action UUID, capability, arguments, actor,
business and pinned runtime session. Canonical authorization must have succeeded. For an
approval-gated capability, confirmation must have succeeded and a matching native approval
must already have been consumed before expiry, in this exact conversation and session.

Recovery retains the original claim and advances only to `VERIFYING`, never completion.
Independent committed-state verification remains mandatory. Concurrent recoveries serialize;
the second sees the recorded result. Missing, duplicate or mismatching records leave the
original journal unchanged and report that no action was replayed. A draft without a committed
canonical turn is not sufficient evidence. Approval tokens are neither returned nor reopened.

This is an internal recovery primitive, not a public resume endpoint or a chat workflow.
Production orchestration, explicit cancellation/rejection, pending-approval presentation and
binding revalidation still need their own integration. Tests use isolated development database
schemas and committed fixture records; they are not live-model benchmark results.
