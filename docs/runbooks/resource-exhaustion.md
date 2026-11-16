# Resource exhaustion and dependency failures

Current repository guidance: 2026-11-16. See [resource isolation](../architecture/resource-isolation.md). Historical OCR-worker, model-artifact-pool and automatically wired circuit-breaker controls are not active operating instructions.

## Identify the failing boundary

1. Record the affected route/job, time, status/error code and current deployment revision. Exclude credentials, document contents and personal data from shared incident notes.
2. Inspect the actual readiness output and provider/database errors. Distinguish unavailable inference, input-validation errors, a full/slow persistence path, database contention and a failed browser scanner.
3. Determine whether the request runs on Node or Edge. Node's in-memory snapshot/persistence behavior and Edge's scoped transaction/lock behavior are different.
4. Preserve pending work and stable operation IDs. A timeout or lost acknowledgement is not permission to repeat a stock, payment or supplier-submission mutation.

## PostgreSQL and persistence

Inspect current pool limits/timeouts in `services/api/src/db-pool-config.ts` and active adapters, queued persistence age/failures, query/statement timeouts and lock holders. Use [the store-lock runbook](cp2-store-lock-leak.md) for lock investigation. Do not blindly raise connection counts across every replica or disable optimistic concurrency.

Database startup uses bounded backoff in `services/api/src/db-startup-retry.ts`. A missing migration, invalid credential or wrong database target needs correction; repeated restart is not a migration strategy. Back up and validate against the intended target before a schema change.

## Online image/model failures

Inspect authenticated `/v1/chat/images/read` responses, configured OpenRouter availability, provider rate/timeout errors and `LUNA_RECEIPT_MAX_OUTPUT_TOKENS`. Preserve the user's draft/attachment for retry. Provider authentication, model availability and network failures need different remedies. Keep credentials server-side and do not silently substitute models or fabricate extracted text.

Receipt-job `receipt_text_required` means no extracted text was supplied. The draft endpoint does not invoke a hidden OCR worker. Image-only PDF receipt processing is still incomplete; the file picker accepting a type does not establish a working extractor.

## Offline scanner failures

Check the controlling service worker, installed manifest/checksums, available browser storage and English asset cache. Reinstall missing/corrupt scanner assets while connected. Scans are serialized; initialization/recognition timeouts recreate failed workers. There is no server Python OCR worker to restart as an offline fallback.

Locally captured jobs contain text/metadata and pending sync operations, not queued source-image bytes. Reconnect and use existing sync recovery to obtain server IDs and perform supplier matching/review. Do not delete unsynchronized local state casually or confirm the same receipt again to clear an indicator.

## Durable jobs and ambiguous outcomes

Inspect the active daemon/job definitions, persisted work state, leases, attempts and committed evidence. Use existing work-specific retry/reconciliation mechanisms. Do not turn an unknown provider delivery or database acknowledgement into a fresh action with a new idempotency key. General messaging/fulfillment queues are not receipt participant synchronization queues.

## Capacity and remediation

Measure actual memory, request latency, database lock/pool pressure, persistence age and external-provider response behavior before changing budgets. Source changes to typed resource-control primitives require their tests; production isolation also requires evidence that the primitive is wired into the affected path.

Keep a record of the failing boundary, observations, corrective action and measured outcome. Retired service names and old environment tables in dated audit documents are historical context, not services to provision.
