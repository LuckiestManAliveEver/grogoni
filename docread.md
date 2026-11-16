# Document and receipt reading

Repository implementation reference, verified 2026-11-16. This replaces the obsolete server-worker design formerly described here.

## Current paths

| Capability                    | Code                                                                                      | Current behavior                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Online image transcription    | `services/api/src/cp2/chat-image-reader.ts`, `chat-image-routes.ts`                       | Authenticated image pixels sent to the existing OpenRouter Luna adapter; validated transcription/receipt fields returned for review.    |
| Offline receipt OCR           | `apps/web/src/offline-ocr.ts`, `packages/offline-runtime/providers/receipt-ocr-entity.ts` | Browser Tesseract worker with pinned English assets; extracted text/metadata and pending sync persisted locally.                        |
| Document text extraction      | `services/api/src/cp2/domains/document-imports/routes.ts`, `document-extraction.ts`       | Existing supported digital PDF, DOCX and spreadsheet extraction; not a general image-only PDF receipt OCR service.                      |
| Structured imports            | `services/api/src/cp2/domains/document-imports/store.ts`                                  | Preview, mapping, validation, correction/selection and explicit confirmation into existing product/supplier records.                    |
| Receipt purchase confirmation | `services/api/src/cp2/domains/suppliers/`, `services/api/src/cp2/store.ts`                | Supplier/agent suggestions, saved field corrections, local purchase receipt and authorized optional stock receipt, with retry bindings. |
| Product photo capture         | `services/api/src/cp2/domains/commerce/`, `apps/web/src/ProductCapturePanel.tsx`          | Existing private capture/review/confirm path; offline capture uses the shared browser scanner.                                          |

`apps/web/src/chat-message-plumbing.ts` connects image extraction to receipt drafts for a selected business. A filename/MIME type alone is not proof that an extractor actually supports the binary format. Missing OCR text does not invoke a hidden worker: the receipt endpoint returns `receipt_text_required`.

## API entry points

- `POST /v1/chat/images/read`
- `POST /businesses/:businessId/documents/extract`
- Existing document import preview/confirmation routes in `domains/document-imports/routes.ts`
- Receipt draft/review/confirmation routes in [Receipt processing](docs/receipt-ocr.md)
- Existing product capture routes in `domains/commerce/routes.ts`

The former generic `/businesses/:businessId/documents/ocr` route is absent. There is no Python OCR deployment to start. Online scanned-PDF receipt processing, live receipt boundary detection and a three-account receipt transaction engine remain incomplete.

## Data and safety

Reuse existing uploads, deterministic parsing, business permissions, validation, contacts, product/invoice/movement records and agent approval paths. Image instructions remain untrusted data. Models cannot authorize financial/stock operations or choose arbitrary record IDs through extraction fields.

Original receipt-job image bytes are ephemeral; separately saved chat attachments and retained document imports have their own access and retention policies. Offline receipt jobs queue text/metadata, not source images. New plain text has `provided_text` provenance; old engine metadata is retained only for compatibility.

Canonical references:

- [Receipt processing](docs/receipt-ocr.md)
- [Receipt data lifecycle](docs/ocr-data-lifecycle.md)
- [Chat receipt integration](docs/integrations/chat-receipt-reading.md)
- [Receipt-to-commerce implementation checklist](docs/audits/receipt-to-commerce-checklist-2026-11-16.md)
- [Data pipeline infrastructure](docs/data-pipeline-infrastructure.md)

The complete attached receipt-to-commerce prompt is partially implemented. A local supplier contact or receipt graph does not establish that a wholesaler/salesperson account accepted or posted the transaction. Use the checklist's code/test evidence rather than historical implementation claims.
