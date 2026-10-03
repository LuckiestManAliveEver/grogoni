# Receipt OCR

Receipt OCR is implemented as a self-hosted flow for supplier purchase receipts.

## Engine strategy

- Primary OCR engine: PaddleOCR.
- Fallback OCR engine: Tesseract, only when PaddleOCR fails and `OCR_FALLBACK_ENABLED=true`.
- Default profile: `balanced`.
- Supported profiles: `mobile`, `balanced`, `accurate`.
- CPU execution is the default deployment target.

The worker service lives in `services/receipt-ocr-service`. It exposes HTTP health and scan
endpoints and can run from Docker Compose with:

```bash
docker compose --profile ocr up receipt-ocr-worker
```

The API connects through `OCR_WORKER_URL` (locally `http://127.0.0.1:8090`). Binary image and PDF
bytes are sent only after the API authenticates the business and the signed malware scanner returns
`clean`. Worker responses are schema-validated before entering parsing and contact matching.

## Production deployment

`render.yaml` declares `grogoni-ocr-worker` as a `type: pserv` (private, not internet-facing)
Docker service built from `services/receipt-ocr-service/Dockerfile`. `grogoni`'s
`OCR_WORKER_URL` is wired to it automatically via Render's `fromService`/`hostport` linking rather
than a manually pasted value - `createOcrExtractionProcessorFromEnvironment`
(`services/api/src/cp2/ocr-provider.ts`) normalizes the bare `host:port` Render provides into an
`http://` endpoint. No persistent disk is mounted, so PaddleOCR re-downloads its model weights on
each deploy/restart (a one-time cold-start cost, not a per-request one); see the comment on that
service block in `render.yaml` if that cost needs to be traded for a disk later. The `starter` plan
may need sizing up under real PaddleOCR memory pressure - watch the worker's Render metrics after
the first production deploy.

## A shared OCR capability, not a receipt-only one

The bridge to the worker (`services/api/src/cp2/ocr-provider.ts`, exporting
`OcrExtractionProcessor`) is generic: it takes an image or PDF and returns raw OCR blocks, full
text, engine metadata, and confidence, with no receipt-specific parsing. `registerCp2Routes` builds
one processor instance from `OCR_WORKER_URL` and passes it into every domain that needs OCR, so
receipt parsing is a consumer on top of the same capability, not a separate integration:

| Consumer                                              | Route                                           | What it adds on top of raw OCR                                 |
| ----------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Receipt parsing (`domains/suppliers`)                 | `POST /businesses/:businessId/receipt-ocr/jobs` | Supplier/receipt/line-item field parsing, contact matching     |
| Chat document extraction (`domains/document-imports`) | `POST /businesses/:businessId/documents/ocr`    | Returns extracted text for chat attachments, no field parsing  |
| Camera product capture (`domains/commerce`)           | `POST /businesses/:businessId/product-captures` | Product title/price extraction for the Camera → Catalogue flow |

A future extractor (identity documents, invoices, and so on) should be a new consumer of this same
`OcrExtractionProcessor`, not a new OCR worker integration.

Title/price extraction and duplicate-catalogue matching for camera product capture are pure,
deterministic functions (`captureField`, `firstProductCaptureTitle`, `visibleProductCapturePrice`,
`productCaptureItemsFromFields`, `queryCatalogueProducts` in `@grogoni/business-core`). The online
route and the offline capture path below both import the same functions rather than each keeping
their own copy, so a photo produces the same title/price whether it was scanned server-side or
on-device.

## Supported inputs

The API validates the declared MIME type, file size, and file signature where the browser can provide one.

Supported upload types:

- JPEG
- PNG
- WebP
- HEIC/HEIF
- PDF
- text or CSV for manual retry/development receipts

Important limits are configured through:

- `OCR_MAX_UPLOAD_MB`
- `OCR_MAX_IMAGE_EDGE`
- `OCR_MAX_PDF_PAGES`
- `OCR_JOB_TIMEOUT_SECONDS`
- `OCR_MAX_RETRIES`
- `OCR_CONCURRENCY`
- `OCR_WORKER_URL`

## User flow

1. User uploads or takes a photo of a purchase receipt from Suppliers, chat, or a receipt card.
2. The upload is validated.
3. The signed malware scanner must classify the upload as clean.
4. The API sends binary content to the bounded worker with configured timeout and retries.
5. OCR extracts raw text blocks, full text, engine metadata, confidence, and warnings.
6. The parser extracts supplier, sales agent, receipt, payment, and product fields.
7. The required `receipt_contact_matching` context script normalizes fields and ranks supplier/contact candidates.
8. User confirms or corrects the review card.
9. Structured purchase receipt and line items are saved.
10. Worker temporary files are deleted immediately after each scan.

Runtime sequence:

```text
receipt command context script
→ OCR extraction
→ receipt-contact-matching context script
→ deterministic supplier and sales-agent resolution
→ user confirmation
→ structured record creation
→ model fallback only when still unresolved
```

## Chat support

Receipt commands are protected by `receipt_ocr_commands` and contact matching is protected by
`receipt_contact_matching`. Both run before general model fallback.

Examples:

- “Show my suppliers”
- “Upload this receipt”
- “Show sales agents for Wholesale Depot”
- “Which supplier sold me maize last week?”
- “Show purchase receipts”
- “Match this receipt to a supplier”
- “Find this supplier in my phonebook”
- “match hii receipt na supplier”

## Receipt contact matching

`receipt_contact_matching` is required, runs after OCR extraction, and returns structured candidates.

Supplier priority:

1. Confirmed supplier-contact link.
2. Exact tax PIN or registration number.
3. Exact normalized phone.
4. Exact verified email.
5. Exact linked external contact ID.
6. Exact normalized supplier name.
7. Previous confirmed receipt pattern.
8. Conservative contact-name suggestion.

Sales-agent priority:

1. Confirmed sales-agent-contact link.
2. Exact normalized phone.
3. Exact normalized name within the matched supplier.
4. Previous confirmed receipt association.
5. Conservative contact-name suggestion.

Thresholds are configurable:

- `OCR_CONTACT_MATCH_AUTO_SELECT`
- `OCR_CONTACT_MATCH_CONFIRMATION_REQUIRED`
- `OCR_CONTACT_MATCH_REJECT_BELOW`

Medium-confidence, tied, or conflicting candidates require user confirmation. Exact phone,
email, tax PIN, registration number, and confirmed contact-link matches are not overridden by
model suggestions.

## API endpoints

- `POST /businesses/:businessId/receipt-ocr/jobs`
- `POST /businesses/:businessId/receipt-ocr/jobs/:ocrJobId/confirm`
- `GET /businesses/:businessId/purchase-receipts`
- `GET /businesses/:businessId/purchase-receipts/:receiptId`

## Saved OCR metadata

Receipt OCR jobs save:

- engine
- engine version
- model version
- profile
- fallback flag
- raw OCR blocks
- full text
- average confidence
- warnings
- field evidence
- supplier and sales agent match candidates
- contact matching result with confidence, sources, and matched-by explanation

The original receipt image is not permanently stored by this pipeline.

## Privacy

Only contact nodes from the current owner, active sync sources, direct visibility, and non-revoked
consent states are searched. OCR does not upload the owner’s full address book to an external OCR or
model provider, and unrelated contacts are not passed into model prompts.

## Offline receipt scanning

With `VITE_OFFLINE_RUNTIME_ENABLED=true`, install business data in Settings → Offline runtime,
then choose **Enable offline receipt scanning** while connected. The browser must be controlled
by the service worker (reload once if prompted). Installation downloads about 14 MiB of pinned
Tesseract 7 English assets, checks available storage, and verifies every file against the versioned
manifest. Interrupted, outdated, missing or corrupt installations are reported as unavailable and
can be installed again. The same asset URLs are served in development and production.

In explicit offline mode, open Suppliers → Receipt scans. JPEG, PNG and WebP photos up to 10 MiB
are read on the device; PDF, HEIC/HEIF and text/CSV receipts require the online flow. Scans run in
sequence. Failed image decoding and worker startup errors allow retry, and processing is bounded
to 60 seconds for initialization and 60 seconds for each recognition. A blank scan displays a failed
job with an explanation.

Receipt text and OCR metadata are saved atomically with a pending sync operation in IndexedDB.
Image bytes are neither retained nor queued. Every locally captured job can be reopened after
navigation or reload, including when no supplier exists yet. The worker and language files are
served from verified local cache; missing files do not silently fetch during a scan. Browsers may
independently check for service-worker updates.

Choose **Sync and go back online** to run server-side field parsing and supplier/contact matching,
then review and confirm the saved job in Receipt scans. The list refreshes to the assigned server
IDs after sync; confirmation is disabled while explicit offline mode is active and after completion.
Confirmation creates the purchase receipt and refreshes purchase history. Retrying sync or
confirmation does not create duplicates. Matching and confirmation remain online operations;
the offline list contains captures saved on this device, not a downloaded history of every OCR job.

Verification:

```bash
pnpm exec vitest run tests/offline-runtime.test.ts tests/offline-runtime-web.test.ts \
  tests/offline-runtime-artifacts.test.ts tests/offline-ocr-engine.test.ts \
  tests/offline-receipt-ui.test.ts tests/receipt-ocr.test.ts tests/receipt-ocr-provider.test.ts
node scripts/verify-offline-ocr-browser.mjs
```

The browser smoke test builds a temporary production harness using the actual web build plugins,
Tesseract assets, service worker and local database. It requires Playwright Chromium (or set
`OCR_BROWSER_CHANNEL=chrome` to use installed Chrome) and a local listening port. It tests scanning
with networking disabled after reload, concurrent scans, invalid/blank images, persistence, and
cache eviction without scan-time network fallback.

## Offline camera product capture

Camera product capture reuses the exact same on-device Tesseract engine as offline receipt
scanning (`apps/web/src/offline-ocr.ts`'s `runLocalOcr` is generic - it is the injected `ocr`
callback for both `receipts.ocr.create` and `productCaptures.ocr.create` in
`packages/offline-runtime/providers/local-provider.ts`). There is no separate "enable offline
product capture" install step: once **Enable offline receipt scanning** has installed the shared
Tesseract assets and explicit offline mode is active, `POST /businesses/:businessId/product-captures`
transparently routes through the local provider instead of the network
(`apps/web/src/offline-runtime.ts`'s `routeOfflineRequest`), so the existing `ProductCapturePanel`
UI needs no changes to work offline.

Unlike receipt OCR, product-capture title/price extraction and duplicate-catalogue matching are
cheap, deterministic functions (see above), so the on-device review card shows real extracted
fields and real duplicate suggestions against the locally cached catalogue snapshot immediately -
not a placeholder pending sync. The job still syncs like any other offline mutation: no image bytes
are ever queued or synced (same bandwidth rule as receipts - only `extractedText` and
`averageConfidence` travel), and the server recomputes the same fields from that text as the
authoritative source rather than trusting the device's copy.

Offline scope matches receipts: capture works fully offline (photo → local OCR → reviewable job
with a locally-assigned id); review, confirm, retry and cancel need an online connection, since
those call server endpoints the offline routing table does not map. A capture made offline and not
yet synced is not restorable after a page reload while still offline (there is no local "read one
job by id" op, only sync-and-create) - the existing draft-restore code in `ProductCapturePanel`
degrades honestly in that case (it clears its saved capture id rather than crashing) instead of
showing stale or fabricated data.
