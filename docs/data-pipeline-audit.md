# Data pipeline audit

Audit date: 2026-07-17. Receipt-path correction: 2026-11-16; other rows retain their original audit scope.

## Implemented pipelines

| Pipeline              | Ingestion                                          | Processing                                                                                          | Durable boundary                                              | Delivery/consumer                                                               | Result                                                             |
| --------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Document import       | Text or base64 PDF, Word, and spreadsheet uploads  | Signature validation, malware scan, extraction, preview mapping, and row validation                 | External object storage plus import source/job records        | Product and supplier UI                                                         | Working; storage is enabled by configuration                       |
| Receipt OCR           | Browser binary upload                              | Authenticated online image inference or browser OCR, validated fields, parsing and contact matching | OCR jobs, receipts, and line items; original bytes ephemeral  | Supplier receipt review UI                                                      | Image/text receipt path exists; scanned-PDF OCR remains incomplete |
| Offline mutations     | IndexedDB local mutation store                     | Ordered transfer with stable idempotency keys and retry-aware server replay                         | IndexedDB until acceptance; PostgreSQL server queue afterward | Product, customer, supplier, inventory, invoice, payment, and logistics actions | Working                                                            |
| Account catch-up      | Account-scoped cursor API                          | Page validation, tombstones, expired-cursor reset                                                   | PostgreSQL journal and atomic IndexedDB page commit           | Web cache                                                                       | Working                                                            |
| Realtime hints        | Authenticated WebSocket                            | Account isolation, PostgreSQL fan-out, listener reconnect, and catch-up coalescing                  | Cursor journal remains authoritative                          | Web catch-up client                                                             | Working across API instances                                       |
| PostgreSQL state      | Store mutations and durable defaults               | Serialized normalized snapshot transaction                                                          | Normalized and relational tables                              | API restart hydration                                                           | Working; flush and health expose persistence failures              |
| Account/shop deletion | Scheduled runner or cron                           | Quarantine, processor receipts, purge and retry                                                     | Deletion requests/proofs and relational cleanup               | Operations jobs                                                                 | Working; external processors run when configured                   |
| Data export/backup    | Authenticated export and scheduled database backup | Scoped bundle generation or `pg_dump`                                                               | Export records and configured backup destination              | Owner/operations                                                                | Working                                                            |
| Messaging outbox      | Failed browser message send                        | Account-scoped retry with HTTP failure classification                                               | Account-scoped browser storage until server acceptance        | Conversation message API                                                        | Working                                                            |
| Message notifications | Accepted conversation message                      | Durable push/email attempts, exponential retry, expired-subscription cleanup, and dead-lettering    | PostgreSQL notification delivery records                      | Push and transactional email providers                                          | Working; provider delivery is retried                              |
| Network invites       | Selected phone or email contacts                   | Signed, idempotent delivery webhook                                                                 | Invite delivery status and audit event                        | Configured invite delivery service                                              | Working when webhook is configured                                 |

## Fixed in this audit

- Replaced the receipt worker health-only loop with an HTTP scan consumer.
- Sent actual image/PDF bytes from the frontend instead of empty extracted text.
- Added OCR response validation, retries, timeout, concurrency, upload-size, image-edge, and PDF-page enforcement.
- Connected IndexedDB mutations to the server queue and automatic reconnect replay.
- Prevented bulk replay from repeatedly executing non-retryable conflicts or ignoring retry backoff.
- Recovered interrupted `processing` queue items after hydration and converted unexpected replay
  failures into retryable failed items.
- Pruned expired sync tombstones and synchronized removals to PostgreSQL on the next durable save.
- Stopped swallowing PostgreSQL save failures: `flush()` now rejects and health reports `degraded`.
- Added an HTTP response barrier so successful mutation responses wait for queued PostgreSQL
  persistence.
- Scoped queued chat messages to the authenticated account, removed unsafe legacy entries, and
  stopped retrying permanent client/conflict errors.
- Included quarantined shop records in the scheduled deletion purge runner.
- Connected queued network invites to a signed delivery webhook and persisted `sent` or `failed`
  delivery state.
- Added PostgreSQL `LISTEN`/`NOTIFY` fan-out with source-instance suppression, dedicated listener
  connections, automatic reconnect, and health reporting.
- Replaced fire-and-forget push/email delivery with a persisted retry queue, scheduled worker,
  exponential backoff, and terminal dead-letter state.
- Added signed malware-scanner and object-storage adapters, retained-source provenance, and
  production fail-closed scanner configuration.

## Deployment dependencies

- Online receipt images require configured OpenRouter inference; offline scans require installed browser Tesseract assets. No server OCR worker is deployed by this path. See [receipt processing](receipt-ocr.md).
- Migration `028_data_pipeline_infrastructure.sql` must be applied before starting this API version.
- Cross-instance realtime fan-out uses the same PostgreSQL database as the durable cursor journal;
  no separate broker is required.
- Network invite delivery requires `NETWORK_INVITE_WEBHOOK_URL` and
  `NETWORK_INVITE_WEBHOOK_SECRET`. Without them, invites remain queued.
- Push and email providers still require their normal credentials. Failed delivery records remain
  durable and are retried while the notification runner is enabled.
- Binary upload malware scanning is opt-in with `MALWARE_SCANNER_ENABLED=true`; otherwise the API
  uses a passthrough pipeline and does not require scanner credentials. Retained import sources use
  the signed object-storage adapter when the scanner-enabled pipeline is configured; receipt bytes
  remain ephemeral.

See [Data pipeline infrastructure](./data-pipeline-infrastructure.md) for deployment and adapter
contracts.
