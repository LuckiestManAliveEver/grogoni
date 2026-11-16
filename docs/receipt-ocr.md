# Receipt OCR and receipt processing

Verified against repository code on 2026-11-16. The complete receipt-to-commerce engine is **not implemented**. See [the phase checklist](audits/receipt-to-commerce-checklist-2026-11-16.md) for remaining work.

## Active extraction paths

| Input                        | Active implementation                                                                                                    | Limits                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Online image                 | Authenticated `POST /v1/chat/images/read`, `services/api/src/cp2/chat-image-reader.ts`, existing OpenRouter Luna adapter | JPEG, PNG, WebP or GIF, at most 10,000,000 bytes; requires configured server-held inference credentials. This is hosted inference and can incur provider charges.                       |
| Offline image                | `apps/web/src/offline-ocr.ts`, Tesseract.js 7 worker/WASM and cached English language assets                             | Explicit offline runtime enabled, installed/checksummed assets, controlling service worker; receipt UI accepts JPEG, PNG or WebP up to 10 MiB. Matching/confirmation need reconnection. |
| Already extracted text       | `POST /businesses/:businessId/receipt-ocr/jobs`                                                                          | Authenticated, authorized business; nonempty text required. Optional structured fields are validated. Plain text is labeled `provided_text`, not attributed to an OCR model.            |
| Digital PDF/DOCX/spreadsheet | Existing `/businesses/:businessId/documents/extract`                                                                     | Text/document extraction is separate from receipt field confirmation. Image-only PDFs have no complete receipt OCR path.                                                                |

The retired Python PaddleOCR service is not an active dependency. There is no server OCR worker to start, and the old `/businesses/:businessId/documents/ocr` route is absent. Uploading receipt image/PDF bytes without extracted text to the receipt-job endpoint returns `receipt_text_required`; it does not run OCR.

Online receipt-image extraction returns transcription and, for recognized receipts, structured fields. `apps/web/src/chat-message-plumbing.ts` submits those fields and image bytes through the existing receipt-job route. Business permissions are checked separately before saving a draft. Model output cannot select record IDs or execute tools. Instructions printed inside a receipt are treated as untrusted content.

## Review and stock confirmation

1. Extract text with the existing image reader or the offline scanner, or provide text explicitly.
2. Save a draft; validate fields and rank authorized supplier/contact/sales-agent candidates.
3. Review and save corrections in `ReceiptFieldsForm` and `DeliveryReceiptReviewPanel` or the Suppliers workspace.
4. Explicitly confirm the supplier/agent and, where requested, receive inventory.
5. The existing confirmation path matches exact SKU or unambiguous case-insensitive name, creates missing products when authorized, updates **this business's** stock, and binds receipt lines to products and movements.
6. Repeated confirmation of the same completed job reuses the saved receipt. Failure restores the local snapshot; PostgreSQL/Edge persistence remains the durable boundary.

The receipt network endpoint shows documentary links within the authorized shop. It does not prove another business accepted the transaction or authorize cross-account posting. Receipt `COMPLETED` currently describes local processing, not fully committed network synchronization. Financial reconciliation, verified unit conversions and semantic deduplication across different photographs remain on the checklist.

## Endpoints

- `POST /v1/chat/images/read`: online image extraction.
- `POST`, `GET /businesses/:businessId/receipt-ocr/jobs`: create/list drafts.
- `PATCH /businesses/:businessId/receipt-ocr/jobs/:ocrJobId`: save corrections.
- `POST /businesses/:businessId/receipt-ocr/jobs/:ocrJobId/confirm`: confirm purchase; `receiveInventory: true` invokes local delivery stock posting.
- `POST /businesses/:businessId/receipt-ocr/jobs/:ocrJobId/cancel`: cancel an unposted draft.
- `GET /businesses/:businessId/purchase-receipts`: purchase history.
- `GET /businesses/:businessId/purchase-receipts/:receiptId`: one receipt.
- `GET /businesses/:businessId/purchase-receipts/:receiptId/network`: authorized documentary bindings.

## Configuration and provenance

Active receipt configuration: `OCR_MAX_UPLOAD_MB`, `OCR_CONTACT_MATCH_AUTO_SELECT`, `OCR_CONTACT_MATCH_CONFIRMATION_REQUIRED`, `OCR_CONTACT_MATCH_REJECT_BELOW` and `LUNA_RECEIPT_MAX_OUTPUT_TOKENS`. Existing OpenRouter configuration supplies online inference. Offline support uses `VITE_OFFLINE_RUNTIME_ENABLED` and the install flow in Settings.

Worker-engine/profile/language/version environment variables were removed: the API does not run that engine. New plain-text drafts report `engine: provided_text`, non-applicable engine/model versions, no guessed language hints, no fallback and zero OCR confidence. Actual supplied Tesseract or Luna extraction retains its engine metadata. Saving field-only corrections preserves the original OCR evidence; changing the transcription records supplied-text provenance instead of manufacturing 100-percent OCR confidence. Historical PaddleOCR records remain readable; their type is compatibility, not evidence of a deployed worker.

`fieldEvidence` includes heuristic confidence values and must not be presented as calibrated model confidence. Unknown or contradictory receipt values require review; current financial checks do not establish authenticity.

## Offline behavior

Install the pinned scanner assets while connected. Downloads are checksummed and require sufficient storage and an active service worker. A failed/interrupted installation remains unavailable until retried. Recognition is serialized, initialization and each recognition have 60-second timeouts, and the scanner can recreate its worker after failure. Automatic rotation is enabled; live camera boundary detection and perspective correction are not implemented.

IndexedDB atomically stores extracted text/metadata and a pending sync operation. Image bytes are not queued or retained by the offline receipt path. Reloading can recover locally captured jobs. Sync creates/reconciles server IDs; then supplier matching, corrections and confirmation use the online service. Existing images stored separately as chat attachments follow their own private-media retention rules.

## Verification

```bash
node node_modules/vitest/vitest.mjs run tests/receipt-ocr.test.ts tests/delivery-receipt-fields.test.ts tests/offline-ocr-engine.test.ts tests/offline-receipt-ui.test.ts tests/offline-runtime.test.ts services/api/src/cp2/chat-image-routes.test.ts --maxWorkers=1 --minWorkers=1
node scripts/verify-offline-ocr-browser.mjs
```

The browser harness needs Playwright Chromium (or `OCR_BROWSER_CHANNEL=chrome`) and a local listening port. Unit tests use mocks/synthetic extracted text where defined; passing them does not certify live OCR accuracy, camera quality, production deployments or three-account receipt synchronization.

Related: [data lifecycle](ocr-data-lifecycle.md), [dependency notices](ocr-licensing.md), [chat receipt integration](integrations/chat-receipt-reading.md).
