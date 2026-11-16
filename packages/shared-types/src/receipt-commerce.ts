/**
 * Receipt-to-commerce contract (schema version 1).
 *
 * One scanned receipt becomes ONE canonical `CommerceTransaction`. Each participating
 * account (buyer, seller, salesperson) gets its own `TransactionProjection` that records
 * which effects were applied to that account and whether they committed.
 *
 * Units: money is integer minor units (`...Minor`, cents of the currency). Quantities are
 * integer thousandths (`...Milli`). Neither is ever a float. Conversion to the legacy
 * `number` fields on products and purchase receipts happens only at the projection edge.
 *
 * Trust rule encoded by these types: an OCR-extracted name or phone never authorizes a
 * cross-account write. A counterparty is a `grogoni_business` party only when the
 * scanning business holds an explicit link to that business id AND both sides hold an
 * active `TradingGrant` naming each other.
 */

export const receiptCommerceSchemaVersion = 1 as const;

// ---------------------------------------------------------------------------
// Document classification
// ---------------------------------------------------------------------------

export const receiptDocumentTypes = [
  "sales_receipt",
  "invoice",
  "quotation",
  "pro_forma_invoice",
  "delivery_note",
  "credit_note",
  "return_receipt",
  "refund_receipt",
  "payment_receipt",
  "unknown"
] as const;
export type ReceiptDocumentType = (typeof receiptDocumentTypes)[number];

/** Direction-neutral transaction kinds. Goods always flow seller to buyer for `goods_sale`. */
export const commerceTransactionKinds = [
  "goods_sale",
  "return",
  "refund",
  "credit_note",
  "quotation",
  "pro_forma",
  "delivery_confirmation",
  "payment"
] as const;
export type CommerceTransactionKind = (typeof commerceTransactionKinds)[number];

/** The role the scanning account plays in the transaction. Wrong direction is a top bug class. */
export type TransactionRole = "buyer" | "seller" | "salesperson";

/**
 * What a document of a given type is allowed to do. Deterministic policy, never model output.
 * A quotation posts nothing. An invoice never marks itself paid.
 */
export interface DocumentEffectPolicy {
  kind: CommerceTransactionKind;
  /** May move stock once fulfillment is satisfied. */
  postsInventory: boolean;
  /** May create a payable/receivable balance entry. */
  postsBalance: boolean;
  /** May record money as paid, limited to the amount the document itself evidences. */
  postsPayment: boolean;
  /** Stock direction for the buyer when inventory posts: +1 goods in, -1 goods out. */
  buyerStockSign: 1 | -1 | 0;
}

// ---------------------------------------------------------------------------
// Luna interpretation (validated server-side; the model never produces this type directly)
// ---------------------------------------------------------------------------

export interface ConfidentField<T> {
  value: T | null;
  /** 0..1 as reported by the model, clamped. 0 when the value is null. */
  confidence: number;
  /** Verbatim receipt text the value was read from, when the model supplied it. */
  sourceText: string | null;
  /** True when confidence is below the review threshold or the model flagged doubt. */
  uncertain: boolean;
}

export interface ReceiptInterpretedParty {
  name: ConfidentField<string>;
  phone: ConfidentField<string>;
  email: ConfidentField<string>;
  taxPin: ConfidentField<string>;
  registrationNumber: ConfidentField<string>;
  address: ConfidentField<string>;
}

export interface ReceiptInterpretedSalesperson {
  name: ConfidentField<string>;
  phone: ConfidentField<string>;
  agentNumber: ConfidentField<string>;
}

export type ReceiptPaymentStatus = "unpaid" | "partially_paid" | "paid" | "unknown";

export interface ReceiptInterpretedTransaction {
  receiptNumber: ConfidentField<string>;
  invoiceNumber: ConfidentField<string>;
  /** ISO date `YYYY-MM-DD`. */
  date: ConfidentField<string>;
  /** `HH:MM` 24h. */
  time: ConfidentField<string>;
  /** ISO 4217, upper case. */
  currency: ConfidentField<string>;
  paymentMethod: ConfidentField<string>;
  paymentStatus: ConfidentField<ReceiptPaymentStatus>;
  transactionReference: ConfidentField<string>;
  subtotalMinor: ConfidentField<number>;
  discountMinor: ConfidentField<number>;
  taxMinor: ConfidentField<number>;
  totalMinor: ConfidentField<number>;
  amountPaidMinor: ConfidentField<number>;
  balanceMinor: ConfidentField<number>;
}

export interface ReceiptInterpretedLine {
  name: ConfidentField<string>;
  sku: ConfidentField<string>;
  barcode: ConfidentField<string>;
  quantityMilli: ConfidentField<number>;
  unit: ConfidentField<string>;
  /** Only when printed on the receipt (for example "12 x 500ml"). Never inferred. */
  unitsPerPack: ConfidentField<number>;
  unitPriceMinor: ConfidentField<number>;
  discountMinor: ConfidentField<number>;
  lineTotalMinor: ConfidentField<number>;
}

export interface ReceiptInterpretation {
  schemaVersion: typeof receiptCommerceSchemaVersion;
  documentType: ConfidentField<ReceiptDocumentType>;
  language: "en" | "sw" | "mixed" | "unknown";
  seller: ReceiptInterpretedParty;
  buyer: ReceiptInterpretedParty;
  salesperson: ReceiptInterpretedSalesperson;
  transaction: ReceiptInterpretedTransaction;
  lines: ReceiptInterpretedLine[];
  /** Model-reported contradictions between values on the receipt. Informational. */
  contradictions: string[];
  /** True when receipt text contained instruction-like content. Forces human review. */
  injectionSuspected: boolean;
  warnings: string[];
  engine: { modelId: string; provider: string; source: "image" | "text" };
}

// ---------------------------------------------------------------------------
// Mathematical validation (deterministic)
// ---------------------------------------------------------------------------

export type ReceiptMathFindingCode =
  | "line_total_mismatch"
  | "line_incomplete"
  | "lines_sum_mismatch"
  | "total_mismatch"
  | "balance_mismatch"
  | "paid_exceeds_total"
  | "total_missing"
  | "no_lines"
  | "negative_value"
  | "non_integer_value"
  | "currency_missing";

export interface ReceiptMathFinding {
  code: ReceiptMathFindingCode;
  /** `blocking` findings stop automatic posting. They are never silently corrected. */
  severity: "blocking" | "warning";
  lineIndex: number | null;
  expectedMinor: number | null;
  actualMinor: number | null;
  message: string;
}

export interface ReceiptMathValidation {
  ok: boolean;
  findings: ReceiptMathFinding[];
  computed: {
    linesTotalMinor: number;
    expectedTotalMinor: number | null;
    expectedBalanceMinor: number | null;
  };
  /** Per-line rounding tolerance used, in minor units. */
  lineToleranceMinor: number;
  /** Aggregate tolerance used, in minor units. */
  totalToleranceMinor: number;
}

// ---------------------------------------------------------------------------
// Product matching and unit conversion
// ---------------------------------------------------------------------------

/** A packaging definition a human with `product:write` confirmed. The only conversion source. */
export interface ProductPackaging {
  id: string;
  businessId: string;
  productId: string;
  /** Normalized pack unit, for example "carton". */
  packUnit: string;
  /** Normalized base unit the product's stock is counted in, for example "packet". */
  baseUnit: string;
  /** Integer count of base units in one pack. */
  unitsPerPack: number;
  verifiedBy: string;
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ProductMatchBasis =
  | "sku"
  | "barcode"
  | "supplier_code"
  | "alias"
  | "normalized_name"
  | "purchase_history"
  | "fuzzy_name";

export interface ProductMatchCandidate {
  productId: string;
  productName: string;
  basis: ProductMatchBasis;
  /** 0..1. Exact identifier bases are 1. */
  confidence: number;
}

export interface ProductMatchResult {
  lineIndex: number;
  /** Set only when exactly one candidate clears the auto-select threshold. */
  selected: ProductMatchCandidate | null;
  candidates: ProductMatchCandidate[];
  /** `ambiguous` and `none` both require a human decision before stock posts. */
  status: "matched" | "ambiguous" | "none";
}

export type UnitConversionBasis = "same_unit" | "verified_packaging" | "unresolved";

export interface UnitConversionResult {
  basis: UnitConversionBasis;
  /** Quantity in the product's stock unit. Null when `unresolved`. Never guessed. */
  baseQuantityMilli: number | null;
  packagingId: string | null;
  /** Human-readable reason, shown in review when unresolved. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Canonical transaction
// ---------------------------------------------------------------------------

export type TransactionPartyType = "grogoni_business" | "trading_partner" | "unknown";

export interface TransactionParty {
  role: "buyer" | "seller";
  partyType: TransactionPartyType;
  /** Set only for `grogoni_business`, and only via an explicit account link. */
  businessId: string | null;
  /**
   * The scanning business's own record for this party: a supplier id when the scanner is
   * the buyer, a customer id when the scanner is the seller. Null for the scanner itself.
   */
  localPartnerRef: { type: "supplier" | "customer"; id: string } | null;
  displayName: string;
  phoneE164: string | null;
  taxPin: string | null;
  /** 0..1 confidence of the local-record match. Informational, never an authorization. */
  identityConfidence: number;
  identityBasis: string[];
}

export interface TransactionSalesperson {
  /** The scanning business's sales-agent record, when matched. */
  localSalesAgentId: string | null;
  /** Business account acting for the seller. Set only through an authorized representation. */
  businessId: string | null;
  representationId: string | null;
  displayName: string;
  phoneE164: string | null;
  identityConfidence: number;
  identityBasis: string[];
}

export interface TransactionLineProductRef {
  productId: string;
  basis: ProductMatchBasis | "manual" | "created";
  confidence: number;
  conversion: UnitConversionResult;
}

export interface CommerceTransactionLine {
  id: string;
  lineIndex: number;
  description: string;
  sku: string | null;
  barcode: string | null;
  quantityMilli: number;
  unit: string | null;
  unitsPerPack: number | null;
  unitPriceMinor: number;
  discountMinor: number;
  lineTotalMinor: number;
  /** Per participating business id: which of ITS products this line is. */
  productRefs: Record<string, TransactionLineProductRef>;
}

export type CommerceTransactionStatus =
  /** Extracted, editable, nothing posted. */
  | "draft"
  /** Blocked on a human decision (math, identity, product, duplicate, injection). */
  | "review_required"
  /** Scanner-side effects committed. Other participants may still be pending. */
  | "posted"
  | "reversed"
  | "rejected";

export type TransactionVerificationStatus =
  | "unverified"
  | "math_verified"
  /** A counterparty account confirmed the transaction happened. */
  | "counterparty_verified"
  | "disputed";

export type TransactionAuthorizationState =
  "pending" | "authorized" | "partially_authorized" | "denied";

export type TransactionSyncState =
  | "not_started"
  | "pending"
  | "partially_synced"
  /** Every required projection is `applied`. Only then may the UI say "synchronized". */
  | "synced"
  | "failed"
  | "reversed";

export type TransactionFulfillmentStatus =
  | "not_applicable"
  | "pending"
  /** The buyer attested goods received. Enough for buyer stock-in. */
  | "received_by_buyer"
  /** The seller confirmed dispatch. Required before seller stock-out. */
  | "confirmed_by_seller";

export interface CommerceTransactionSource {
  type: "receipt_scan" | "agent_tool" | "offline_capture";
  ocrJobId: string | null;
  scannedByBusinessId: string;
  scannedByUserId: string;
  scannerRole: TransactionRole;
  /** SHA-256 of each captured page, in order. Evidence handles; bytes are not in this record. */
  pageSha256: string[];
}

export interface CommerceTransaction {
  id: string;
  schemaVersion: typeof receiptCommerceSchemaVersion;
  kind: CommerceTransactionKind;
  documentType: ReceiptDocumentType;
  status: CommerceTransactionStatus;
  /** Content fingerprint: seller key + document number + date + total + currency + lines. */
  receiptFingerprint: string;
  documentNumber: string | null;
  source: CommerceTransactionSource;
  buyer: TransactionParty;
  seller: TransactionParty;
  salesperson: TransactionSalesperson | null;
  lines: CommerceTransactionLine[];
  currency: string;
  subtotalMinor: number | null;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  amountPaidMinor: number | null;
  balanceMinor: number | null;
  paymentStatus: ReceiptPaymentStatus;
  fulfillmentStatus: TransactionFulfillmentStatus;
  verificationStatus: TransactionVerificationStatus;
  authorizationState: TransactionAuthorizationState;
  syncState: TransactionSyncState;
  mathValidation: ReceiptMathValidation;
  /** Open reasons the transaction needs review. Empty when it can post. */
  reviewReasons: TransactionReviewReason[];
  /** Set when this transaction looks like an earlier one. */
  duplicateOfTransactionId: string | null;
  reversalOfTransactionId: string | null;
  reversedByTransactionId: string | null;
  /** Client-supplied key; a repeat submit with the same key returns the same transaction. */
  idempotencyKey: string | null;
  /** Optimistic concurrency. Every mutation increments it. */
  revision: number;
  /** Date and time printed on the document, when read. */
  occurredAt: string | null;
  createdAt: string;
  updatedAt: string;
  postedAt: string | null;
}

export type TransactionReviewReasonCode =
  | "math_discrepancy"
  | "low_confidence_field"
  | "document_type_uncertain"
  | "direction_uncertain"
  | "seller_unmatched"
  | "seller_ambiguous"
  | "buyer_unmatched"
  | "salesperson_ambiguous"
  | "product_unmatched"
  | "product_ambiguous"
  | "unit_conversion_unresolved"
  | "possible_duplicate"
  | "injection_suspected"
  | "currency_mismatch"
  | "amount_over_limit";

export interface TransactionReviewReason {
  code: TransactionReviewReasonCode;
  /** Dotted path of the field needing attention, for example `lines.2.quantityMilli`. */
  field: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Participant projections
// ---------------------------------------------------------------------------

export type ProjectionEffect =
  | "partner_link"
  | "purchase_record"
  | "sale_record"
  | "stock_in"
  | "stock_out"
  | "payable"
  | "receivable"
  | "payment_record"
  | "sales_attribution"
  | "commission_eligibility";

export type ProjectionState =
  /** No active grant covers this. Waits for the account owner; nothing is written. */
  | "pending_authorization"
  /** Authorized and waiting on a precondition (for example seller fulfillment). */
  | "waiting"
  | "queued"
  | "applied"
  /** Will be retried. */
  | "failed"
  /** Retries exhausted. Needs an operator or the reconciler. */
  | "dead_letter"
  | "rejected"
  | "reversed";

export interface AppliedProjectionEffect {
  effect: ProjectionEffect;
  recordType: string;
  recordId: string;
}

export interface TransactionProjection {
  id: string;
  transactionId: string;
  businessId: string;
  role: TransactionRole;
  state: ProjectionState;
  /** Effects this projection will apply, decided by policy at authorization time. */
  plannedEffects: ProjectionEffect[];
  appliedEffects: AppliedProjectionEffect[];
  /** Grant that authorized the write, or null when the account's own member authorized it. */
  grantId: string | null;
  authorizedBy: { type: "member" | "grant" | "owner_approval"; id: string } | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Trusted trading relationships
// ---------------------------------------------------------------------------

export interface TradingGrantPermissions {
  postInventory: boolean;
  recordBalance: boolean;
  recordPayment: boolean;
  /** Seller side only: allow sales to be attributed to salespeople on this partner's scans. */
  attributeSales: boolean;
}

/**
 * A standing, owner-issued authorization from `businessId` letting transactions with
 * `partnerBusinessId` post into `businessId`'s own records without per-transaction approval.
 * It never lets the partner read or write anything else.
 */
export interface TradingGrant {
  id: string;
  businessId: string;
  partnerBusinessId: string;
  /** What the partner is to the grantor. */
  partnerRole: "supplier" | "customer" | "salesperson";
  /** The grantor's own supplier/customer record this partner business is linked to. */
  localPartnerRef: { type: "supplier" | "customer"; id: string } | null;
  status: "active" | "revoked";
  allowedKinds: CommerceTransactionKind[];
  /** Per-transaction ceiling in minor units of `currency`. Null means no automatic posting. */
  maxTransactionMinor: number | null;
  currency: string;
  permissions: TradingGrantPermissions;
  /** Whether the grantor's AI agents may act on these transactions, and up to what value. */
  agentDelegation: { enabled: boolean; maxTransactionMinor: number | null };
  /** For `partnerRole: "salesperson"`: the authorized representation it rests on. */
  representationId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type GrantDecisionReason =
  | "authorized"
  | "no_grant"
  | "grant_revoked"
  | "grant_expired"
  | "kind_not_allowed"
  | "amount_over_limit"
  | "currency_mismatch"
  | "permission_missing"
  | "representation_not_authorized";

export interface GrantDecision {
  authorized: boolean;
  reason: GrantDecisionReason;
  grantId: string | null;
  /** Effects the grant permits out of those requested. */
  permittedEffects: ProjectionEffect[];
}

// ---------------------------------------------------------------------------
// Non-Grogoni trading partners and identity claiming
// ---------------------------------------------------------------------------

/**
 * An offer from a business to link its history with an unregistered partner to a business
 * that has since joined. Both sides must consent. Accepting links FUTURE transactions and
 * shares only the listed historical transactions as read-only evidence. It never back-posts
 * stock or balances into the claimant's account.
 */
export interface PartnerIdentityClaim {
  id: string;
  /** Business holding the history. */
  businessId: string;
  localPartnerRef: { type: "supplier" | "customer"; id: string };
  claimantBusinessId: string;
  status: "offered" | "accepted" | "declined" | "withdrawn";
  /** Historical transactions the offering business agreed to share. */
  sharedTransactionIds: string[];
  offeredBy: string;
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

// ---------------------------------------------------------------------------
// Balances, attribution, commission
// ---------------------------------------------------------------------------

/** Append-only. A balance is the sum of its entries; reversals add an opposite entry. */
export interface TradeBalanceEntry {
  id: string;
  businessId: string;
  transactionId: string;
  direction: "payable" | "receivable";
  counterparty: {
    businessId: string | null;
    localPartnerRef: { type: "supplier" | "customer"; id: string } | null;
  };
  /** Signed. Positive increases what is owed; payments and reversals are negative. */
  amountMinor: number;
  currency: string;
  reason: "document_total" | "payment" | "reversal";
  createdAt: string;
}

export interface CommissionRule {
  id: string;
  /** The seller (principal) that pays commission. */
  businessId: string;
  /** Null applies to every authorized representation of this business. */
  representationId: string | null;
  /** Basis points of the transaction total excluding tax. */
  rateBps: number;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SalesAttribution {
  id: string;
  /** The seller whose sale this is. */
  businessId: string;
  transactionId: string;
  salespersonBusinessId: string;
  representationId: string;
  buyerBusinessId: string | null;
  amountMinor: number;
  currency: string;
  commissionEligible: boolean;
  commissionRuleId: string | null;
  commissionMinor: number | null;
  status: "recorded" | "reversed";
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Durable events
// ---------------------------------------------------------------------------

export type CommerceOutboxEventType = "projection.apply" | "projection.reverse" | "agent.notify";

/**
 * Transactional outbox row. Written in the same commit as the state change that needs it.
 * Consumers are idempotent on `eventKey`.
 */
export interface CommerceOutboxEvent {
  id: string;
  /** Unique. `<type>:<transactionId>:<projectionId or businessId>:<revision>`. */
  eventKey: string;
  type: CommerceOutboxEventType;
  transactionId: string;
  projectionId: string | null;
  businessId: string;
  status: "pending" | "delivered" | "dead_letter";
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export type CommerceLedgerEventType =
  | "transaction.created"
  | "transaction.corrected"
  | "transaction.submitted"
  | "transaction.posted"
  | "transaction.rejected"
  | "transaction.disputed"
  | "transaction.reversed"
  | "transaction.duplicate_detected"
  | "projection.authorized"
  | "projection.applied"
  | "projection.failed"
  | "projection.dead_lettered"
  | "projection.rejected"
  | "projection.reversed"
  | "grant.created"
  | "grant.updated"
  | "grant.revoked"
  | "claim.offered"
  | "claim.decided"
  | "agent.notified";

/**
 * Tamper-evident audit event. `hash = sha256(prevHash + canonicalJson(event without hash))`.
 * Rows are immutable in the database (update and delete rejected by trigger).
 */
export interface CommerceLedgerEvent {
  id: string;
  /** Monotonic per chain, starting at 1. */
  sequence: number;
  type: CommerceLedgerEventType;
  transactionId: string | null;
  /** Account whose records the event concerns, when it concerns exactly one. */
  businessId: string | null;
  actor: { type: "user" | "agent" | "system"; id: string };
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
  occurredAt: string;
}

/** Event delivered to an account's agents. Carries ids and totals only, no counterparty private data. */
export interface CommerceAgentEvent {
  id: string;
  businessId: string;
  transactionId: string;
  type:
    | "transaction.posted"
    | "transaction.pending_authorization"
    | "transaction.discrepancy"
    | "transaction.reversed";
  role: TransactionRole;
  summary: string;
  totalMinor: number;
  currency: string;
  /** Tools the account's grants allow an agent to run as follow-up. */
  permittedFollowUps: string[];
  createdAt: string;
  acknowledgedAt: string | null;
}

// ---------------------------------------------------------------------------
// API views
// ---------------------------------------------------------------------------

/** What one account sees of a transaction: the transaction plus only ITS OWN projection in full. */
export interface CommerceTransactionView {
  transaction: CommerceTransaction;
  /** The caller's projection. */
  ownProjection: TransactionProjection | null;
  /** Other participants: role, display name and state only. No ids of their records. */
  participants: {
    role: TransactionRole;
    displayName: string;
    onGrogoni: boolean;
    state: ProjectionState | "not_on_grogoni";
  }[];
  /** Stock change this posts (or would post) to the caller's products. */
  inventoryImpact: { productId: string; productName: string; deltaMilli: number; unit: string }[];
}
