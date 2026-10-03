export type Entity = Record<string, unknown> & { id: string; businessId?: string };
export type Collection =
  | "products"
  | "customers"
  | "invoices"
  | "orders"
  | "productFields"
  | "receiptOcrJobs"
  | "productCaptureJobs";
export type Mutation =
  | "catalogue.create"
  | "catalogue.update"
  | "inventory.adjust"
  | "customers.create"
  | "receipts.ocr.create"
  | "productCaptures.ocr.create"
  | "orders.createInvoice"
  | "orders.updateInvoice"
  | "orders.confirmInvoice";
export type SyncStatus = "PENDING" | "PUSHED" | "ACKED" | "REJECTED" | "CONFLICT";
export interface Scope {
  accountId: string;
  storeId: string;
  deviceId: string;
}
export interface Operation extends Scope {
  id: string;
  localSeq: number;
  opType: Mutation;
  collection: Collection;
  entityLocalId: string;
  entityCloudId: string | null;
  base: Entity | null;
  payload: Record<string, unknown>;
  createdAtLocal: string;
  syncStatus: SyncStatus;
  attempts: number;
  nextAttemptAt: number;
  serverOpId: string | null;
  conflictInfo: string | null;
}
export interface MirrorRow {
  local_id: string;
  cloud_id: string | null;
  store_id: string;
  updated_at_local: string;
  synced_at: string | null;
  dirty: boolean;
  collection: Collection;
  payload: Entity;
}
export interface Artifact {
  url: string;
  sha256: string;
  bytes: number;
}
/** What the on-device OCR engine produces for one captured receipt image. */
export interface ReceiptOcrExtraction {
  engine: OcrEngine;
  engineVersion: string;
  modelVersion: string;
  profile: OcrProfile;
  fallbackUsed: boolean;
  blocks: OcrBlockSummary[];
  fullText: string;
  averageConfidence: number;
  warnings: string[];
}
export interface RuntimeBinding {
  agentId: string;
  agentVersion: string;
  modelId: string;
  modelVersion: string;
  artifacts: Artifact[];
}
export interface RuntimePin extends RuntimeBinding, Scope {
  pinnedAt: string;
  explicitSwap: boolean;
  active: boolean;
}
export interface PendingConflict {
  id: string;
  operationId: string;
  collection: Collection;
  entityLocalId: string;
  message: string;
  local: Entity | null;
  server: Entity | null;
}
export interface LocalState extends Scope {
  schemaVersion: 1;
  installed: boolean;
  offlineModeActive: boolean;
  installedAt: string | null;
  rows: MirrorRow[];
  operations: Operation[];
  conflicts: PendingConflict[];
  pin: RuntimePin | null;
  nextLocalSeq: number;
  lastPushedLocalSeq: number;
  pullCursor: string | null;
  /** RuntimeHandoff is the execution checkpoint; conversation content stays separate. */
  runtimeHandoffSession?: LocalRuntimeHandoffSession;
  /** Mirrors providers/peer-provider.ts's PeerQueuedMessage/PeerOutboxEnvelope shape - kept as an
   *  inline structural type here (rather than imported) so types.ts, the package's base module,
   *  never depends on providers/. */
  peerOutbox?: Array<{
    id: string;
    envelope:
      | { kind: "conversation_message"; message: ConversationMessageSummary }
      | { kind: "order_intent"; intent: OfflineOrderIntent };
    expiresAt: number;
    attempts: number;
  }>;
  pendingOfflineOrders?: PendingOfflineOrder[];
}

/** OfflineOrderIntent/OfflineOrderIntentOutcome/CatalogueDigest and friends are defined in
 *  @grogoni/shared-types (not here) and re-exported, because services/api's NativeSmsInboundResult
 *  (also in shared-types) needs to reference OfflineOrderIntentOutcome, and shared-types cannot
 *  depend on this package (this package already depends on shared-types, e.g.
 *  ConversationMessageSummary below - the dependency only goes one way). */
export type {
  OfflineOrderTransport,
  OfflineOrderIntentStatus,
  OfflineOrderCustomerClaim,
  OfflineOrderItemIntent,
  OfflineOrderIntent,
  OfflineOrderItemOutcome,
  OfflineOrderIntentOutcome,
  CatalogueDigest
} from "@grogoni/shared-types";

/** Local record of one captured intent plus its last known reconciliation outcome. Never
 *  decrements local product stock - `provisionalReservation` is purely a merchant-facing
 *  "someone already asked for this" signal until the server confirms it. */
export interface PendingOfflineOrder {
  intent: OfflineOrderIntent;
  status: OfflineOrderIntentStatus;
  createdAtLocal: string;
  syncedAt: string | null;
  outcome: OfflineOrderIntentOutcome | null;
}
export interface LocalRuntimeMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
export interface LocalRuntimeHandoffSession {
  transferId?: string;
  targetExecutionHostId?: string;
  transferKey?: string;
  returnTransferKey?: string;
  adapterId: string;
  hostedExecutionHostId: string;
  cloudHandoffId: string;
  handoff: RuntimeHandoff;
  checkpoints: RuntimeHandoff[];
  messages: LocalRuntimeMessage[];
  pendingMessages: LocalRuntimeMessage[];
  status: "prepared" | "offline" | "returning" | "hosted";
}
export interface Ack {
  id: string;
  localSeq: number;
  status: "ACKED" | "REJECTED" | "CONFLICT";
  serverOpId: string;
  entity: Entity | null;
  message: string | null;
}
export interface BusinessChange {
  id: string;
  businessId: string;
  sequence: number;
  collection: Collection;
  entityId: string;
  entity: Entity | null;
}
export interface PullPage {
  accountId: string;
  storeId: string;
  fromCursor: string | null;
  newCursor: string;
  changes: BusinessChange[];
  hasMore: boolean;
}
export function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.accountId, scope.storeId, scope.deviceId]);
}
export function emptyState(scope: Scope): LocalState {
  return {
    ...scope,
    schemaVersion: 1,
    installed: false,
    offlineModeActive: false,
    installedAt: null,
    rows: [],
    operations: [],
    conflicts: [],
    pin: null,
    nextLocalSeq: 1,
    lastPushedLocalSeq: 0,
    pullCursor: null,
    pendingOfflineOrders: []
  };
}
export class OfflineError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "OfflineError";
  }
}
import type {
  RuntimeHandoff,
  ConversationMessageSummary,
  OcrEngine,
  OcrProfile,
  OcrBlockSummary,
  OfflineOrderIntent,
  OfflineOrderIntentOutcome,
  OfflineOrderIntentStatus
} from "@grogoni/shared-types";
