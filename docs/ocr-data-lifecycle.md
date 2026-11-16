# Receipt data lifecycle

Verified against repository code on 2026-11-16. See [receipt processing](receipt-ocr.md) and [remaining implementation work](audits/receipt-to-commerce-checklist-2026-11-16.md).

## Capture and extraction

Online images are sent to the authenticated OpenRouter-backed image reader for transcription. The API validates size, encoding and image signatures, returns `Cache-Control: no-store`, and keeps provider credentials server-side. Business receipt creation is a separate authorized request. Supplying bytes to the draft route does not itself trigger OCR. The configured binary upload pipeline processes bytes with `retain: false`; malware scanning depends on deployment configuration and must not be assumed enabled everywhere.

Offline Tesseract runs in a browser worker using verified locally cached assets. Receipt text and extraction metadata, not original image bytes, are saved with a pending operation in IndexedDB. This local receipt store is not application-level encrypted by the chat E2EE feature.

## Retained records

Receipt jobs keep structured fields, extracted text/blocks, engine provenance, warnings, heuristic field evidence, consent-scoped match candidates and source checksum/filename. Confirmed local purchases retain supplier/agent references, line items and product/movement bindings. New supplied text is labeled `provided_text` with no model confidence; historical engine labels remain readable.

The receipt-job pipeline does not retain original source images. `imageStorageKey` is null, `imageRetained` is false and cleanup/expiry fields do not imply an active temporary-file deletion worker. Former worker image-TTL/deletion settings are not implemented controls. Separately saved chat attachments and retained document imports have independent storage/access/retention paths; do not infer their deletion from a receipt job's flags.

## State and access

Jobs can require review, fail, be cancelled, or complete a local purchase. Corrections are refused after confirmation/cancellation. `COMPLETED` is not a statement that other accounts committed stock, sales, commissions or financial projections. Those receipt-driven updates are not implemented.

Every private receipt read/write is business-authorized. Contact matching uses the current owner's visible, active, non-revoked sources. Documentary supplier/agent matches never grant another account's authority.

Same-source draft reuse and same-job confirmation protect ordinary retries. Different photographs/OCR of the same commercial receipt still need semantic replay controls. Post-commit financial/stock reversals need a separate auditable implementation; deleting a draft is not a reversal.

## Required operational evidence

Before advertising full receipt synchronization, verify protected source-evidence retention, account/device isolation, semantic duplicate handling, unit conversions, participant grants, committed per-account projections, compensation and restart recovery. The current implementation checklist records these gaps explicitly.
