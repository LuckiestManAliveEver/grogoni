# Resource isolation and graceful degradation

Current repository review: 2026-11-16. This replaces the obsolete deployment-specific description from September. The dated [resource audit](resource-isolation-audit.md) is historical evidence, not current operating instructions.

## 0. Implementation boundaries

`packages/resource-control/src/` contains tested bulkhead, circuit-breaker and retry primitives. Their existence does not prove a particular request path uses them. In the current API source, database startup uses `retryWithBackoff` through `services/api/src/db-startup-retry.ts`; no production API caller of `createBulkhead` or `createCircuitBreaker` was found in this review. Do not advertise live inference/OCR bulkhead gauges or circuit-breaker environment settings on that basis.

## 1. Node and Edge are different scopes

Node's `createPostgresCp2Store` hydrates domain state and persists mutations through its existing queue. Edge loads tenant-scoped state inside short coordinated transactions through `services/api/src/edge-domain-routes.ts`, `cp2/edge-snapshot-scope.ts` and `edge-transaction-pool.ts`. A historical single-Node-process ceiling is not a description of every Edge request. Keep existing account/business locks and optimistic conflict checks; do not disable them to hide serialization failures.

## 2. PostgreSQL budgets and recovery

Use `services/api/src/db-pool-config.ts` and the current connection adapters rather than provisioning a historical model-artifact pool. Node persistence, readiness/parity and realtime listener behavior live in `cp2/postgres-store.ts`. Database startup retry is bounded by `db-startup-retry.ts`; schema/deployment mismatches are not solved by unlimited retries.

Before changing concurrency, inspect current pool and query-timeout configuration, persistence errors, transaction/lock contention and readiness output. Do not copy an environment table from an older audit without finding its active reader. See [the store-lock runbook](../runbooks/cp2-store-lock-leak.md) for contention investigation.

## 3. Inference

Hosted model work uses the configured adapters in `services/api/src/inference/`; receipt image reading uses the existing OpenRouter reader. Authentication precedes image inference. On Edge, image model work is detached from snapshot transactions, so a slow provider call does not hold the receipt store lock. Validate provider availability, per-call timeout/output limits and exact model configuration in the active adapter. Never add silent provider fallbacks, invent results or replay a consequential action on a model timeout. OpenRouter host fallback between hosts of one model is allowed because it is not silent: the answering host is recorded as `providerHost` and the model identity is checked.

## 4. Receipt OCR

There is no Python server OCR worker, worker queue, OCR circuit breaker or associated worker deployment to resize. Online receipt images use `/v1/chat/images/read`; explicit offline scans use the browser Tesseract worker. The browser scan queue is serialized, initialization/recognition have timeouts, and corrupt/missing cached assets are reported unavailable. These controls do not imply live camera preprocessing or cross-account receipt synchronization.

See [receipt processing](../receipt-ocr.md), [data lifecycle](../ocr-data-lifecycle.md) and the [implementation checklist](../audits/receipt-to-commerce-checklist-2026-11-16.md). Plain-text receipt drafts are `provided_text`, not evidence that a retired engine ran.

## 5. Durable jobs and idempotency

The existing daemon and `services/api/src/edge-job-runner.ts` define active work and schedules. A browser promise queue is not durable synchronization infrastructure. Keep work-specific idempotency, commit evidence, bounded retries and failed/pending states. The general daemon, fulfillment and messaging outboxes do not establish receipt-specific participant consumers or reconciliation.

## 6. Observability and operations

Use actual readiness/errors, provider responses, pending persistence/job state, database locks and measured request/resource behavior. A primitive's unit test is not proof of a wired production gauge or a production capacity budget. The [resource-exhaustion runbook](../runbooks/resource-exhaustion.md) covers current investigation without retired service commands.

## 23. Verification

```bash
node node_modules/vitest/vitest.mjs run packages/resource-control/src/bulkhead.test.ts packages/resource-control/src/circuit-breaker.test.ts packages/resource-control/src/retry.test.ts services/api/src/resource-exhaustion-acceptance.test.ts --maxWorkers=1 --minWorkers=1
node scripts/check-retired-runtime-references.mjs
node scripts/check-render-inference-boundaries.mjs
```

These verify primitive behavior and retired-deployment boundaries. Production isolation, load budgets and recovery require measurements against the actual deployed Node/Edge paths; do not claim those measurements from this document.
