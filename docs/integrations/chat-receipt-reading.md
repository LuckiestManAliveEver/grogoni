# Receipt images and delivery records

Online buyer and seller chats send private receipt images to Luna through authenticated `POST /v1/chat/images/read`. No scanner installation is required. The server holds the OpenRouter key, sends actual pixels as a private base64 image input, verifies the returned model identity, and disables provider fallback.

Luna returns both a transcription and structured receipt fields: wholesaler contacts, sales-agent contacts, receipt references/dates/currency/totals, and delivered products with quantities, units, SKUs, prices, batches and expiry dates where readable. Missing values remain empty. Wholesaler and sales-agent phone numbers are kept separate. The model cannot select record IDs or run tools through extraction output.

A seller upload creates a receipt draft through the existing receipt workflow and adds a durable supplier card in the chat for review. Fields can be corrected before confirmation. Unsaved corrections disable confirmation. Buyer uploads remain assistant conversations and do not create private shop records. Human-directed messages bypass image extraction. Image-reader failures preserve the draft and attachment for retry.

Confirming a delivery creates or matches its wholesaler and sales agent, records the purchase receipt, and receives the delivered products into stock. Products match by exact SKU or an unambiguous name. New products retain the supplier unit price as buying price. Confirmation checks permissions and rejects ambiguous products; failures roll back the operation. A durable delivery binding makes confirmation idempotent, so retries do not receive stock twice.

`GET /businesses/:businessId/purchase-receipts/:receiptId/network` exposes the document's links to the wholesaler, sales agent, products and inventory movements within the authorized shop. The original upload checksum and filename remain with the extraction. Bindings refer to durable receipt-line IDs, preserving relationships after database reloads and row reordering. These are relationships evidenced by the document, not assertions that another business accepted a public network connection. Normal chat attachment storage and the existing receipt-image retention policy still apply.

## HTTP 503 changes

Production error logs identified SQLSTATE `40001` snapshot conflicts on seller runtime and session/read routes. GET handlers can refresh sessions, mark messages read and initialize defaults, so Edge now coordinates their snapshots using the same account/business locks as writes. Identical concurrent catalog seeds are accepted while different stale replacements still fail the optimistic concurrency guard. The image-reader authentication lookup completes before model work starts: Luna inference holds no snapshot lock or database connection. Receipt draft creation and confirmation use short, separate requests.

Supported image inputs are JPEG, PNG, WebP and GIF up to 10 MB. The endpoint returns `Cache-Control: no-store`; the Node API limits it to 12 requests per minute per IP. `LUNA_RECEIPT_MAX_OUTPUT_TOKENS` controls extraction output, defaulting to 8192. Chat image reading requires an online connection. Offline receipt scanning and the existing shop text-document/PDF extractor remain separate paths; this endpoint does not read scanned PDFs.

Verification includes real Luna browser uploads, field review/correction, confirmed inventory and document-network links; receipt and chat regressions; detached Edge inference; normalized receipt-field restoration; and a PostgreSQL temporary-table check proving identical seeds succeed while conflicting replacements remain protected.
