# DocRead Format

Status: repository implementation reference
Scope: Grogoni document ingestion, text extraction, structured mapping, OCR, review, and persistence
Last verified: 2026-07-17

## 1. Scope and naming

“DocRead” is the name used in this document for the document-reading capabilities implemented in
this repository. It does not describe private OpenAI systems or hidden model tooling.

The repository does not currently contain one component literally named `docread`. It contains
three related capabilities:

1. Structured supplier and product imports.
2. Purchase-receipt OCR, receipt parsing, and supplier/sales-agent matching.
3. Chat file attachments, which transport files but do not extract their contents.

This document describes the implemented behavior, the intended architecture, the data contracts,
and the gaps between accepted file types and formats that are genuinely decoded.

A fourth OCR consumer, camera-based product capture (`POST
/businesses/:businessId/product-captures`, see `services/api/src/cp2/domains/commerce/`), reuses
the same underlying OCR extraction bridge as capability 2 but is out of this document's scope: it
captures catalogue products from a photo rather than reading a structured document. See "A shared
OCR capability, not a receipt-only one" in `docs/receipt-ocr.md` for how the OCR bridge itself is
generalized across all of these consumers.

## 2. Executive summary

| Capability                     | Current state                                 | What works                                                                               |
| ------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Supplier import                | Operational for CSV-style text                | Header inference, row validation, preview, correction, selection, confirmation           |
| Product import                 | Operational for multiple text representations | CSV, TSV, JSON, SQL `INSERT`, and loose text lines                                       |
| PDF/Word/Excel generic import  | Operational for supported binary formats      | PDF text, DOCX, XLS/XLSX, and ODS extraction with signature checks                       |
| Receipt field parser           | Operational when extracted text is supplied   | Supplier, contact, receipt, payment, total, date, and simple line-item parsing           |
| OCR worker                     | Connected HTTP service                        | Binary upload, bounded processing, PaddleOCR primary, Tesseract fallback, validated JSON |
| OCR worker/API integration     | Operational                                   | Authenticated binary image/PDF requests use the bounded OCR worker adapter               |
| Receipt image upload in web UI | Operational                                   | Receipt images and PDFs are submitted for OCR and returned for review                    |
| Review-before-write            | Operational                                   | No suppliers or products are created until the user confirms valid rows                  |
| PostgreSQL persistence         | Operational for normalized job records        | Jobs, mapped rows, OCR metadata, evidence, matches, and structured records               |
| Chat attachment extraction     | Operational                                   | Text documents use native extraction; images and scanned PDFs use OCR                    |

The production-safe interpretation is:

- Use CSV for suppliers.
- Use CSV, TSV, JSON, supported SQL `INSERT`, or clean text for products.
- Use receipt OCR for supported image/PDF inputs and review extracted evidence before confirming.
- Upload supported PDF, DOCX, and spreadsheet binaries directly; legacy DOC remains unsupported.

## 3. System architecture

```text
                           ┌────────────────────────────┐
                           │ Browser / owner workspace  │
                           └─────────────┬──────────────┘
                                         │
                ┌────────────────────────┴────────────────────────┐
                │                                                 │
                ▼                                                 ▼
     Generic document import                            Receipt OCR workflow
     file.text() / pasted text                          file metadata + extractedText
                │                                                 │
                ▼                                                 ▼
     Supplier or product parser                         Upload validation
                │                                                 │
                ▼                                                 ▼
     Header/field inference                             Receipt text parser
                │                                                 │
                ▼                                                 ▼
     Row validation and preview                         Structured field extraction
                │                                                 │
                ▼                                                 ▼
     User correction and selection                      Supplier/contact candidate matching
                │                                                 │
                ▼                                                 ▼
     Explicit confirmation                              Explicit confirmation
                │                                                 │
                ▼                                                 ▼
     Supplier/product records                           Purchase receipt + line items
                │                                                 │
                └────────────────────────┬────────────────────────┘
                                         ▼
                              Store snapshot / PostgreSQL
```

The API connects binary receipt uploads to the OCR worker over its internal HTTP scan endpoint:

```text
binary receipt → authenticated API → OCR worker → validated OCR JSON → parser/matcher
```

## 4. Capability and format matrix

### 4.1 Generic structured import

“Accepted” means the file extension and MIME type pass validation. “Decoded” means the repository
contains a parser that correctly interprets that representation.

| Format          |         Accepted |             Supplier decoded |                  Product decoded | Notes                                                       |
| --------------- | ---------------: | ---------------------------: | -------------------------------: | ----------------------------------------------------------- |
| CSV             |              Yes |                          Yes |                              Yes | Primary supported format                                    |
| TSV             |              Yes |    No reliable supplier path |                              Yes | Product parser detects tab delimiters                       |
| Plain text      |              Yes |           Only if CSV-shaped |                              Yes | Product parser has a loose-line fallback                    |
| JSON            |              Yes | No dedicated supplier parser |                              Yes | Array or `{ "products": [...] }`                            |
| SQL             |              Yes | No dedicated supplier parser |                              Yes | Limited single `INSERT INTO ... (...) VALUES (...)` grammar |
| PDF             |              Yes |                          Yes |                              Yes | Text-bearing PDFs are decoded; scanned PDFs use receipt OCR |
| DOC/DOCX        |     DOCX decoded |                          Yes |                              Yes | DOCX is decoded; legacy binary DOC remains unsupported      |
| ODT             |              Yes |                           No |                               No | Binary OpenDocument text extraction is not implemented      |
| XLS/XLSX        |              Yes |                          Yes |                              Yes | Workbook sheets are converted to CSV text                   |
| ODS             |              Yes |                          Yes |                              Yes | Workbook sheets are converted to CSV text                   |
| Google Sheets   | Via export/paste |                   Yes if CSV |                   Yes if CSV/TSV | No live Google Sheets connector                             |
| Database export | Via paste/upload |              CSV-shaped only | CSV, TSV, JSON, or supported SQL | “Database link” is a UI label, not a live DB connector      |

### 4.2 Receipt OCR inputs

The receipt API accepts these normalized MIME types:

- `image/jpeg`
- `image/png`
- `image/webp`
- `image/heic`
- `image/heif`
- `application/pdf`
- `text/plain`
- `text/csv`
- `application/vnd.ms-excel`

Signature checks exist for JPEG, PNG, WebP, HEIC/HEIF, and PDF when the browser supplies an initial
hex signature.

The authenticated API accepts bounded base64 binary bodies, verifies the declared image/PDF
signature, runs the upload-security pipeline when configured, and sends the content to the OCR
worker. A deployment without `OCR_WORKER_URL` returns an explicit service-unavailable error.

### 4.3 Chat attachments

Chat accepts document, image, video, audio, and other files. Small files are represented as data
URLs and may also use HTTPS object-storage URLs.

For an agent conversation, text-bearing PDF, DOCX, spreadsheet, and text files use the generic
extractor. Images use `/businesses/:businessId/documents/ocr`; scanned PDFs fall back to the same
OCR route when native PDF extraction cannot find readable text. Extracted text is marked as
untrusted reference data before it enters the runtime prompt. The composer offers simple
“Extract text,” “Summarize,” and “Extract fields” instructions. Extraction does not persist the
attachment as agent knowledge or write business records without the existing confirmation flow.

## 5. Generic import pipeline

### 5.1 Ingestion

The web import screen supports:

- file selection;
- pasted document or export text;
- predefined examples;
- a source-reference text field for human-readable provenance in the form.

The create-import request persists the source type and human-readable source reference alongside
the file metadata and checksum for provenance.

The browser uses `File.text()` for every selected generic-import file. This is appropriate for text
files but not for binary PDF, DOCX, XLSX, ODT, or ODS files.

The API receives JSON:

```json
{
  "fileName": "products.csv",
  "contentType": "text/csv",
  "content": "name,sku,unit,quantity,buyingPrice,sellingPrice\nRice,RIC-001,kg,10,100,140"
}
```

There is no multipart upload in the generic import route.

### 5.2 Source validation

Generic imports validate:

- a supported filename extension;
- an optional supported MIME type;
- non-empty content;
- content length of at most 250,000 JavaScript characters.

The resulting source metadata contains:

- source ID;
- business ID;
- filename;
- content type;
- byte size;
- SHA-256 checksum;
- creation timestamp.

The public source summary intentionally excludes raw content. The in-memory source temporarily
contains it for parsing, but snapshots retain only source metadata. After hydration, the source
record is reconstructed with empty raw content because previews already contain the mapped rows.

### 5.3 Supplier parser

Supplier imports use the CSV parser directly.

Recognized header aliases:

| Destination field | Recognized headers after normalization |
| ----------------- | -------------------------------------- |
| `name`            | `name`, `supplier`, `suppliername`     |
| `phone`           | `phone`, `mobile`, `tel`               |
| `email`           | `email`, `emailaddress`                |
| `notes`           | `note`, `notes`                        |

Supplier output:

```json
{
  "name": "Wholesale Depot",
  "phone": "+254700000010",
  "email": "supply@example.com",
  "notes": "Main supplier"
}
```

Each row is validated using the normal supplier/contact validation rules. Invalid rows remain
visible in preview but are unselected by default.

### 5.4 Product parser

Product imports use a flexible parser in this order:

1. JSON.
2. SQL `INSERT`.
3. TSV.
4. CSV.
5. Loose text lines.

Recognized header aliases:

| Destination field | Recognized headers after normalization                           |
| ----------------- | ---------------------------------------------------------------- |
| `name`            | `name`, `product`, `productname`, `item`, `itemname`             |
| `sku`             | `sku`, `code`, `barcode`                                         |
| `unit`            | `unit`, `measure`, `uom`, `pack`                                 |
| `quantity`        | `quantity`, `qty`, `stock`, `onhand`                             |
| `buyingPrice`     | `buyingprice`, `buyprice`, `cost`, `costprice`, `purchaseprice`  |
| `sellingPrice`    | `sellingprice`, `sellprice`, `price`, `retailprice`, `saleprice` |

Numbers are normalized by removing non-numeric characters other than `.` and `-`, then parsing a
floating-point number.

Product output:

```json
{
  "name": "Rice",
  "sku": "RIC-001",
  "unit": "kg",
  "quantity": 10,
  "buyingPrice": 100,
  "sellingPrice": 140
}
```

#### JSON grammar

Accepted JSON shapes:

```json
[
  {
    "name": "Rice",
    "sku": "RIC-001",
    "quantity": 10
  }
]
```

or:

```json
{
  "products": [
    {
      "name": "Rice",
      "sku": "RIC-001",
      "quantity": 10
    }
  ]
}
```

#### SQL grammar

The SQL parser recognizes a bounded pattern similar to:

```sql
INSERT INTO products
  (name, sku, unit, quantity, buying_price, selling_price)
VALUES
  ('Rice', 'RIC-001', 'kg', 10, 100, 140);
```

It is not a general SQL parser. Nested expressions, `SELECT` statements, vendor-specific dump
syntax, escaped structures, and complex multi-statement files are outside its contract.

#### Loose-line grammar

When other parsers do not produce records, each non-empty line becomes a possible product. The
parser tries to split on:

- two or more spaces;
- a spaced pipe;
- a spaced hyphen;
- a spaced comma.

It assigns the resulting segments to:

1. name;
2. quantity;
3. unit;
4. selling price.

This is a recovery heuristic and should always be reviewed.

### 5.5 Preview and review

No business records are created during preview.

Every preview row contains:

```json
{
  "rowNumber": 1,
  "raw": {
    "Product": "Rice",
    "Stock": "10"
  },
  "mapped": {
    "name": "Rice",
    "sku": null,
    "unit": "unit",
    "quantity": 10,
    "buyingPrice": null,
    "sellingPrice": null
  },
  "errors": [],
  "warnings": [],
  "selected": true
}
```

The user can:

- inspect the inferred mapping;
- edit mapped values;
- select or deselect rows;
- save corrected rows;
- confirm only valid selected rows.

Confirmation fails if any explicitly selected row is invalid.

### 5.6 Confirmation

Supplier confirmation creates supplier records through the normal supplier creation path.

Product confirmation creates product records through the normal product creation path.

The import job then records:

- `status = "confirmed"`;
- confirmed record count;
- updated timestamp;
- confirmation timestamp.

Import lifecycle events are written for:

- `document_import.previewed`;
- `document_import.failed`;
- `document_import.confirmed`.

## 6. Receipt OCR pipeline

### 6.1 Intended OCR worker

The self-hosted Python worker lives in:

```text
services/receipt-ocr-service/
├── Dockerfile
├── requirements.txt
└── worker.py
```

Primary engine:

- PaddleOCR 2.8.1.

Fallback:

- Tesseract through `pytesseract`.
- Used only after PaddleOCR throws and `OCR_FALLBACK_ENABLED` is not `false`.

Default execution profile:

- `balanced`;
- CPU-oriented;
- English and Swahili language hints.

Worker commands:

```bash
python worker.py health
python worker.py scan --input /path/to/receipt.jpg
python worker.py worker
```

Example worker output:

```json
{
  "engine": "paddleocr",
  "engineVersion": "paddleocr-2.8.1",
  "modelVersion": "balanced-cpu",
  "profile": "balanced",
  "fallbackUsed": false,
  "blocks": [
    {
      "id": "p1-b1",
      "page": 1,
      "text": "Wholesale Depot",
      "confidence": 0.96,
      "boundingBox": [
        { "x": 12, "y": 18 },
        { "x": 280, "y": 18 },
        { "x": 280, "y": 48 },
        { "x": 12, "y": 48 }
      ]
    }
  ],
  "fullText": "Wholesale Depot",
  "averageConfidence": 0.96,
  "warnings": []
}
```

The `worker` command runs a bounded HTTP service with `/health` and `/scan`. The API applies retry,
timeout, concurrency, size, image-edge, and PDF-page controls around this service.

### 6.2 API-side receipt upload validation

The API validates:

- authenticated business access;
- `import:write` permission;
- normalized content type;
- maximum file size;
- optional magic-byte signature.

Default maximum size:

- `OCR_MAX_UPLOAD_MB=10`.

Signature rules:

| Type      | Expected signature      |
| --------- | ----------------------- |
| JPEG      | starts with `ffd8ff`    |
| PNG       | starts with `89504e47`  |
| WebP      | RIFF plus `WEBP` brand  |
| PDF       | starts with `25504446`  |
| HEIC/HEIF | recognized `ftyp` brand |

Text and legacy Excel MIME types are accepted without binary signature matching.

### 6.3 Receipt text parser

Once text exists, the deterministic parser extracts:

#### Supplier fields

- supplier name;
- trading name;
- legal name;
- phone;
- alternate phone;
- email;
- physical address;
- tax PIN;
- registration number;
- branch;
- supplier account number.

#### Sales-agent fields

- name;
- phone;
- email;
- agent/employee number;
- represented supplier;
- branch;
- notes.

#### Receipt and payment fields

- receipt number;
- invoice number;
- order number;
- purchase date;
- purchase time;
- currency;
- subtotal;
- discount;
- tax/VAT;
- total;
- amount paid;
- balance;
- payment method;
- till number;
- paybill number;
- transaction reference or M-Pesa code.

#### Product line items

The current line-item grammar is deliberately narrow:

```text
Item name,quantity,unit price,total
```

or:

```text
Item name|quantity|unit price|total
```

The total is calculated as `quantity × unit price` when the fourth value is absent.

The current parser does not derive item code, SKU, unit, batch number, or expiry date from line
text; those fields remain `null`.

### 6.4 Normalization

The parser performs:

- Kenyan phone normalization for common `07...`, `01...`, and `254...` forms;
- lowercased validated email normalization;
- ISO timestamp conversion for recognized dates;
- 24-hour time matching;
- currency normalization, including `KSH` to `KES`;
- two-decimal monetary rounding.

Date recognition is currently limited to:

- `YYYY-MM-DD`;
- slash-delimited day/month or month/day patterns accepted by JavaScript `Date.parse`.

### 6.5 OCR evidence and warnings

Receipt jobs retain:

- OCR blocks;
- full text;
- average confidence;
- warnings;
- field-level evidence;
- structured extraction;
- matching candidates and explanations.

The API-created placeholder blocks use:

- one block per non-empty text line;
- page number `1`;
- confidence `0.9` when text exists;
- no bounding box.

Real PaddleOCR block geometry is available from the worker but is not yet passed into the API.

Warnings include:

- no OCR text;
- no parsed line items;
- line-item sum not matching the receipt total by more than one currency unit.

### 6.6 Supplier and sales-agent matching

The matching process is deterministic and business-scoped.

Default thresholds:

| Threshold             | Default |
| --------------------- | ------: |
| Auto-select           |  `0.95` |
| Confirmation required |  `0.80` |
| Reject below          |  `0.50` |

Strong identifiers include:

- confirmed contact links;
- exact tax PIN;
- exact registration number;
- exact normalized phone;
- exact verified email.

Name matching is more conservative. High-confidence ties require confirmation.

Candidate output contains:

- candidate ID;
- entity type;
- record ID;
- contact ID;
- display name;
- confidence;
- matching reasons;
- source systems;
- whether user confirmation is required.

Matching only searches records and authorized contact nodes that belong to the active business and
owner context.

### 6.7 Receipt confirmation

The user must confirm or create a supplier before completing a receipt.

On confirmation the system can:

- use an existing supplier;
- create a supplier from extracted fields;
- use an existing sales agent;
- create a sales agent under the confirmed supplier;
- create a purchase receipt;
- create receipt line items;
- refresh supplier and agent metrics.

After successful confirmation:

- the OCR job becomes `COMPLETED`;
- the image is marked not retained;
- `imageDeletedAt` is set;
- cleanup is marked complete;
- the saved purchase receipt reports `imageStored=false`.

## 7. DocRead normalized envelope

The repository currently uses separate import and OCR response types. The following DocRead
envelope is a recommended unifying interchange format for future extractors. It is a documentation
contract, not yet a single exported TypeScript type.

```json
{
  "docreadVersion": "1.0",
  "document": {
    "id": "uuid",
    "businessId": "uuid",
    "fileName": "source-file.pdf",
    "contentType": "application/pdf",
    "sizeBytes": 10240,
    "checksumSha256": "hex",
    "source": "upload",
    "createdAt": "2026-07-16T12:00:00.000Z"
  },
  "extraction": {
    "status": "review_required",
    "extractor": "paddleocr",
    "extractorVersion": "2.8.1",
    "modelVersion": "balanced-cpu",
    "fallbackUsed": false,
    "languageHints": ["en", "sw"],
    "fullText": "Extracted document text",
    "averageConfidence": 0.91,
    "blocks": [],
    "warnings": []
  },
  "classification": {
    "documentType": "purchase_receipt",
    "target": "receipt",
    "confidence": 0.97
  },
  "fields": {
    "supplier": {},
    "salesAgent": {},
    "receipt": {},
    "products": []
  },
  "rows": [],
  "matches": {
    "supplierCandidates": [],
    "salesAgentCandidates": []
  },
  "review": {
    "required": true,
    "selectedRows": [],
    "confirmedAt": null,
    "confirmedBy": null
  },
  "privacy": {
    "originalRetained": false,
    "temporaryObjectKey": null,
    "temporaryExpiresAt": null,
    "deletedAt": null
  }
}
```

Recommended status vocabulary:

- `received`;
- `validating`;
- `extracting`;
- `mapping`;
- `review_required`;
- `confirmed`;
- `failed`;
- `cleanup_pending`;
- `completed`.

Recommended document types:

- `supplier_list`;
- `product_catalogue`;
- `purchase_receipt`;
- `invoice`;
- `bank_statement`;
- `identity_document`;
- `contract`;
- `generic_document`;

Only the first three have repository workflows today, and supplier/product inputs are import
targets rather than automatic document classifications.

## 8. API contracts

### 8.1 Generic imports

Create supplier preview:

```http
POST /businesses/:businessId/imports/supplier-csv
```

Create product preview:

```http
POST /businesses/:businessId/imports/product-catalogue
```

List jobs:

```http
GET /businesses/:businessId/imports
```

Get one job:

```http
GET /businesses/:businessId/imports/:importJobId
```

Correct supplier row:

```http
PATCH /businesses/:businessId/imports/:importJobId/rows/:rowNumber
```

Correct product row:

```http
PATCH /businesses/:businessId/imports/:importJobId/product-rows/:rowNumber
```

Confirm suppliers:

```http
POST /businesses/:businessId/imports/:importJobId/confirm
```

Confirm products:

```http
POST /businesses/:businessId/imports/:importJobId/confirm-products
```

### 8.2 Receipt OCR

Create OCR job:

```http
POST /businesses/:businessId/receipt-ocr/jobs
```

Request:

```json
{
  "fileName": "receipt.jpg",
  "contentType": "image/jpeg",
  "extractedText": "Supplier: Wholesale Depot\nTotal: 200",
  "fileSizeBytes": 4096,
  "fileSignature": "ffd8ffe000104a464946"
}
```

Confirm OCR job:

```http
POST /businesses/:businessId/receipt-ocr/jobs/:ocrJobId/confirm
```

Request:

```json
{
  "supplierId": "uuid-or-null",
  "salesAgentId": "uuid-or-null",
  "createSupplier": false,
  "createSalesAgent": false
}
```

Read saved receipts:

```http
GET /businesses/:businessId/purchase-receipts
GET /businesses/:businessId/purchase-receipts/:receiptId
```

## 9. Authorization model

Document operations are business-scoped and session-authenticated.

| Role        | Import read | Import write |
| ----------- | ----------: | -----------: |
| Owner       |         Yes |          Yes |
| Manager     |         Yes |          Yes |
| Sales agent |         Yes |           No |
| Cashier     |         Yes |           No |
| View only   |          No |           No |

Receipt OCR job creation and confirmation require `import:write`.

Listing and reading purchase receipts require `import:read`.

Cross-business IDs return not-found or authorization errors rather than exposing another business’s
document data.

## 10. Persistence

### 10.1 Generic imports

The schema includes:

- `document_import_sources`;
- `document_import_jobs`;
- `document_import_rows`.

The active snapshot persistence path uses the normalized compatibility tables:

- `cp2_document_imports`;
- `cp2_document_import_sources`.

The older relational tables exist in migration `006_cp9_document_import.sql`, but the inspected
PostgreSQL adapter loads and saves the current import jobs through the normalized compatibility
collections.

Persisted import information includes:

- source metadata and checksum;
- target;
- status;
- field mapping;
- mapped and raw row objects;
- row errors and warnings;
- selection state;
- confirmed count;
- timestamps.

Raw uploaded source content is not exposed in API summaries and is not restored into the in-memory
source record after snapshot hydration.

### 10.2 Receipt OCR

Receipt OCR persistence includes:

- job identity and tenant/business scope;
- source filename and content type;
- engine/model/profile metadata;
- full OCR text;
- confidence;
- warnings and evidence;
- structured extraction;
- matching results and candidates;
- lifecycle and cleanup fields.

Confirmed business data is stored separately as:

- purchase receipts;
- receipt line items;
- supplier and sales-agent references.

## 11. Security and privacy

Implemented controls:

- authenticated, role-based business access;
- business/tenant scoping;
- generic import extension and MIME allowlists;
- generic content length limit;
- receipt MIME allowlist;
- receipt size limit;
- receipt magic-byte checks;
- SHA-256 source checksums;
- review-before-write;
- explicit confirmation for ambiguous contact matches;
- temporary-image metadata and deletion state;
- no required paid/external OCR API.

Important caveats:

- The generic import limit is checked with JavaScript string length, although the error message
  calls it 250KB.
- Reverse-proxy and API request-body limits are still required in production.
- The generic importer does not protect against every spreadsheet formula or CSV-injection risk
  because it ingests values rather than producing executable spreadsheets; any future re-export
  should escape formula-leading values.
- File extension and declared MIME acceptance do not prove a binary office document was decoded.
- OCR full text is retained in job records even after image deletion and may contain personal data.
- Retention policies should cover OCR text and structured fields, not only source images.

## 12. Configuration

| Variable                                  | Default           |                                                           Used by current code |
| ----------------------------------------- | ----------------- | -----------------------------------------------------------------------------: |
| `OCR_ENGINE_PRIMARY`                      | `paddleocr`       |                                                                            Yes |
| `OCR_ENGINE_FALLBACK`                     | `tesseract`       |                                                        Worker metadata/default |
| `OCR_FALLBACK_ENABLED`                    | `true`            |                                                                         Worker |
| `OCR_PROFILE`                             | `balanced`        |                                                                            Yes |
| `OCR_LANGUAGE_HINTS`                      | `en,sw`           |                                                                            Yes |
| `OCR_ENGINE_VERSION`                      | `paddleocr-2.8.1` |                                                                   API metadata |
| `OCR_MODEL_VERSION`                       | `<profile>-cpu`   |                                                                   API metadata |
| `OCR_TEMP_IMAGE_TTL_HOURS`                | `24`              |                                                                            Yes |
| `OCR_FAILED_IMAGE_TTL_HOURS`              | `24`              | Not applicable while source bytes are processed ephemerally and never retained |
| `OCR_DELETE_AFTER_CONFIRM`                | `true`            | Not applicable while source bytes are processed ephemerally and never retained |
| `OCR_MAX_UPLOAD_MB`                       | `10`              |                                                                            Yes |
| `OCR_MAX_IMAGE_EDGE`                      | `3000`            |                                                     Enforced by the OCR worker |
| `OCR_MAX_PDF_PAGES`                       | `5`               |                                                     Enforced by the OCR worker |
| `OCR_JOB_TIMEOUT_SECONDS`                 | `120`             |                                                     Enforced by the API bridge |
| `OCR_MAX_RETRIES`                         | `2`               |                                                     Enforced by the API bridge |
| `OCR_CONCURRENCY`                         | `1`               |                                          Enforced by API and worker semaphores |
| `OCR_CONTACT_MATCH_AUTO_SELECT`           | `0.95`            |                                                                            Yes |
| `OCR_CONTACT_MATCH_CONFIRMATION_REQUIRED` | `0.80`            | Stored in result; candidate decision mainly uses auto-select/reject thresholds |
| `OCR_CONTACT_MATCH_REJECT_BELOW`          | `0.50`            |                                                                            Yes |

## 13. Error and state behavior

### 13.1 Generic import states

- `previewed`: rows exist and can be edited.
- `confirmed`: selected valid rows were written.
- `failed`: no usable data rows were produced.

Representative errors:

- invalid extension or MIME;
- empty content;
- content too large;
- target mismatch;
- job not editable;
- row not found;
- no rows selected;
- invalid selected rows;
- job not confirmable.

### 13.2 Receipt OCR states

The shared contract includes detailed uppercase lifecycle states and legacy lowercase compatibility
states. The current synchronous API path primarily produces:

- `FAILED` when no extracted text exists;
- `REVIEW_REQUIRED` when supplier or line items remain unresolved;
- `MATCHING` when supplier matching and items are available;
- `COMPLETED` after confirmation.

Representative errors:

- `receipt_ocr_unsupported_type`;
- `receipt_ocr_file_too_large`;
- `receipt_ocr_signature_mismatch`;
- `receipt_ocr_not_found`;
- `receipt_ocr_failed`;
- `receipt_supplier_required`.

## 14. Test coverage

Relevant automated tests:

- `tests/cp9-document-import.test.ts`
  - supplier preview/correction/confirmation;
  - no writes before confirmation;
  - product TSV import;
  - product SQL import;
  - empty import failure;
  - audit events.
- `tests/business-core.test.ts`
  - source validation;
  - supplier field mapping;
  - invalid-row selection;
  - immutable lifecycle events.
- `tests/receipt-ocr.test.ts`
  - OCR metadata;
  - upload signature rejection;
  - deterministic supplier and sales-agent matching;
  - structured extraction;
  - receipt confirmation;
  - image-deletion state;
  - receipt command routing.

Tests cover pre-extracted text, binary API handoff through a mock processor, worker response
validation, retry behavior, and Python worker startup/health syntax.

## 15. Known gaps

### Integration dependencies

1. Image/PDF OCR requires the worker container and `OCR_WORKER_URL`; `render.yaml` now deploys
   the worker as a private service (`grogoni-ocr-worker`) and wires `OCR_WORKER_URL`
   automatically (see "Production deployment" in `docs/receipt-ocr.md`), but its `starter` plan and
   lack of a persistent model-weights disk have not yet been load-tested against real traffic.
2. Legacy binary DOC and ODT text extraction remain unsupported.
3. Full native-engine OCR quality requires PaddleOCR/Tesseract models in the worker image.

### Parsing gaps

1. Supplier TSV, JSON, and SQL do not have dedicated parsers.
2. Receipt line-item parsing requires a narrow comma/pipe layout.
3. Receipt item SKU, unit, batch, and expiry extraction are not implemented.
4. PDF page limits are enforced before OCR, while field parsing still combines the returned pages.
5. Handwriting, tables, rotated receipts, and mixed-language quality depend on native OCR model quality.

### Operational gaps

1. There is no binary object-storage upload contract; receipt bytes are processed ephemerally.
2. There is no malware scanning or document sandboxing service.
3. There is no unified extractor registry or automatic document classification.
4. There is no live database connector despite “database link” wording in the UI.

## 16. Recommended production completion plan

### Phase 1: truthful UI

- Restrict generic file selection to text formats that are actually decoded.
- Relabel PDF/Word/Excel options as “paste extracted text” until binary extractors exist.
- Show an explicit failure when a binary file is passed to `File.text()`.

### Phase 2: binary upload foundation

- Add a signed object-storage upload flow.
- Store only a temporary object key in API requests.
- Validate size, MIME, signature, and malware-scan status server-side.
- Add idempotency keys and upload checksums.

### Phase 3: worker integration

- Define a Redis queue payload containing business ID, object key, content type, checksum, and
  requested extraction profile.
- Make the worker consume jobs and publish structured OCR results.
- Add job leases, timeouts, retries, dead-letter handling, and concurrency enforcement.
- Pass worker blocks, confidence, geometry, engine metadata, and warnings to the API.

### Phase 4: office and PDF extraction

- PDF text: use a bounded text-layer extractor before OCR fallback.
- Scanned PDF: render only the configured maximum pages, then OCR.
- DOCX: extract XML text and tables without executing macros.
- XLSX/ODS: parse cell values with formula execution disabled.
- DOC/XLS: either convert in an isolated service or reject legacy binaries.

### Phase 5: unified DocRead contract

- Export a shared `DocReadEnvelope` type.
- Add an extractor registry keyed by MIME type.
- Separate extraction, classification, mapping, review, and persistence stages.
- Record extractor version, model version, checksum, confidence, and evidence for every field.

### Phase 6: quality and safety

- Add real fixture documents for JPEG, PNG, WebP, HEIC, PDF, DOCX, XLSX, and ODS.
- Add multilingual receipts and difficult camera conditions.
- Add adversarial filenames, spoofed MIME types, oversized files, malformed archives, and formula
  injection fixtures.
- Define text and structured-data retention periods.

## 17. Source map

Primary implementation files:

- `apps/web/src/GrogoniApplication.tsx`
  - generic import UI;
  - file-to-text handling;
  - receipt upload UI;
  - receipt metadata request.
- `packages/business-core/src/index.ts`
  - source validation;
  - CSV, TSV, JSON, SQL, and loose-line parsing;
  - field inference;
  - row mapping and validation.
- `packages/shared-types/src/index.ts`
  - import job and OCR result contracts.
- `services/api/src/cp2/routes.ts`
  - HTTP request parsing and endpoints.
- `services/api/src/cp2/store.ts`
  - authorization;
  - import lifecycle;
  - receipt parsing;
  - contact matching;
  - confirmation and record creation.
- `services/api/src/cp2/ocr-provider.ts`
  - generic OCR extraction bridge to the worker (`OcrExtractionProcessor`);
  - shared by receipt parsing, chat document extraction, and camera product capture - see
    "A shared OCR capability, not a receipt-only one" in `docs/receipt-ocr.md`.
- `services/api/src/cp2/domains/commerce/routes.ts` and `domains/commerce/store.ts`
  - camera product-capture jobs (`POST /businesses/:businessId/product-captures`), the
    Camera → Catalogue consumer of the shared OCR capability; out of scope for the rest of this
    document, which covers supplier/product imports and purchase-receipt OCR only.
- `services/api/src/cp2/postgres-store.ts`
  - PostgreSQL load/save integration.
- `services/receipt-ocr-service/worker.py`
  - PaddleOCR/Tesseract worker scaffold.
- `infra/db/migrations/006_cp9_document_import.sql`
  - document-import relational tables.
- `docs/receipt-ocr.md`
- `docs/ocr-data-lifecycle.md`
- `docs/ocr-licensing.md`
- `tests/cp9-document-import.test.ts`
- `tests/receipt-ocr.test.ts`
- `tests/ocr-provider.test.ts`

## 18. Definition of done for a fully operational DocRead

DocRead should be considered fully operational only when:

- each advertised binary file type has a real decoder or is rejected;
- uploaded binaries reach a sandboxed extraction worker;
- worker results are consumed by the API;
- extraction status can be polled or streamed;
- field evidence comes from real OCR/text geometry;
- no business records are written without review or an explicit safe auto-confirm policy;
- original-file and extracted-text retention policies are enforced;
- tests exercise real files through the complete browser/API/worker/database path.
