/**
 * Fourth slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns suppliers, sales agents, supplier
 * contact links, and purchase receipts/receipt-OCR - six Maps combined into one domain rather than
 * split, because reading the method bodies during investigation showed they're bidirectionally
 * coupled: `createReceiptOCRJob`/`confirmReceiptOCRJob` call `matchSupplier`/`requireSupplier`/
 * `createSupplier`/`matchSalesAgent`/`requireSalesAgent`/`createSalesAgent`, while
 * `supplierBusinessCard`/`salesAgentCard` (the supplier-domain report builders) call back into
 * `purchaseReceiptsForSupplier`/`purchaseReceiptsForSalesAgent`. Splitting them would only have
 * recreated the same circular-dependency problem `cp2-error.ts`/`text-normalization.ts`/
 * `money.ts` were pulled out to avoid.
 *
 * `networkNodes`/`networkSources` are read here (phonebook contact search, receipt contact
 * matching) but not owned here - they belong to `NetworkDomain` (extracted as the sixth slice),
 * so they're injected as raw Map references via `SupplierDomainDeps`, pointed at
 * `NetworkDomain`'s own map getters from `Cp2Store`'s constructor - the same pattern
 * `CommerceDomainDeps` uses for `networkNodes`. `sanitizeNetworkNode` has no `this` dependency,
 * so it's imported directly from `NetworkDomain`'s `shared.ts` rather than injected.
 */
import { randomUUID, createHash } from "node:crypto";
import {
  normalizeContactRecordInput,
  supplierCreatedEvent,
  supplierUpdatedEvent,
  validateContactRecordInput,
  type BusinessPermission,
  type ContactRecordInput
} from "@grogoni/business-core";
import type { BusinessEvent } from "@grogoni/event-core";
import type {
  AuthenticatedActorView,
  NetworkNodeSummary,
  NetworkSyncSourceSummary,
  PurchaseReceiptSummary,
  ReceiptLineItemSummary,
  ReceiptOCRJobSummary,
  SalesAgentSummary,
  SupplierBusinessCardSummary,
  SupplierContactLinkSummary,
  SupplierSummary
} from "@grogoni/shared-types";
import { Cp2Error, assertValid } from "../../cp2-error.js";
import { roundMoney } from "../../money.js";
import { normalizeDestination } from "../../phone-identity.js";
import { sanitizeNetworkNode } from "../../network-node-view.js";
import {
  averageReceiptBlockConfidence,
  buildReceiptFieldEvidence,
  buildReceiptOCRBlocks,
  buildReceiptOCRWarnings,
  buildReceiptStructuredExtraction,
  compareReceiptCandidates,
  contactSourceLabel,
  createReceiptCandidate,
  hasTiedHighConfidenceCandidates,
  normalizeReceiptContentType,
  normalizeReceiptName,
  parseReceiptText,
  readReceiptContactMatchThresholds,
  readReceiptOCRConfig,
  receiptIdentifierConfidence,
  receiptOCRDefaultFallbackEngine,
  receiptSalesAgentMatchedBy,
  receiptSupplierMatchedBy,
  selectReceiptCandidate,
  validateReceiptUpload,
  type ParsedReceiptText
} from "./shared.js";

export interface SupplierDomainDeps {
  requireAuthorizedSession: (
    sessionId: string | null,
    businessId: string,
    permission: BusinessPermission,
    now?: Date
  ) => AuthenticatedActorView;
  appendBusinessEvent: (event: BusinessEvent) => void;
  requirePhonebookNode: (ownerUserId: string, networkNodeId: string) => NetworkNodeSummary;
  networkNodes: Map<string, NetworkNodeSummary>;
  networkSources: Map<string, NetworkSyncSourceSummary>;
  /**
   * How the owner may see their phonebook nodes (NetworkDomain.phonebookNodeViewer): hides
   * which shop a contact runs until the two are connected. Defaults to sanitizeNetworkNode.
   */
  phonebookNodeViewer?: (ownerUserId: string) => (node: NetworkNodeSummary) => NetworkNodeSummary;
}

export class SupplierDomain {
  private readonly suppliers = new Map<string, SupplierSummary>();
  private readonly salesAgents = new Map<string, SalesAgentSummary>();
  private readonly supplierContactLinks = new Map<string, SupplierContactLinkSummary>();
  private readonly purchaseReceipts = new Map<string, PurchaseReceiptSummary>();
  private readonly receiptLineItems = new Map<string, ReceiptLineItemSummary>();
  private readonly receiptOCRJobs = new Map<string, ReceiptOCRJobSummary>();

  constructor(private readonly deps: SupplierDomainDeps) {}

  get suppliersMap(): Map<string, SupplierSummary> {
    return this.suppliers;
  }

  get salesAgentsMap(): Map<string, SalesAgentSummary> {
    return this.salesAgents;
  }

  get supplierContactLinksMap(): Map<string, SupplierContactLinkSummary> {
    return this.supplierContactLinks;
  }

  get purchaseReceiptsMap(): Map<string, PurchaseReceiptSummary> {
    return this.purchaseReceipts;
  }

  get receiptLineItemsMap(): Map<string, ReceiptLineItemSummary> {
    return this.receiptLineItems;
  }

  get receiptOCRJobsMap(): Map<string, ReceiptOCRJobSummary> {
    return this.receiptOCRJobs;
  }

  clear(): void {
    this.suppliers.clear();
    this.salesAgents.clear();
    this.supplierContactLinks.clear();
    this.purchaseReceipts.clear();
    this.receiptLineItems.clear();
    this.receiptOCRJobs.clear();
  }

  listSuppliers(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): SupplierBusinessCardSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:read",
      input.now
    );
    return [...this.suppliers.values()]
      .filter((supplier) => supplier.businessId === input.businessId)
      .map((supplier) => this.supplierBusinessCard(supplier));
  }

  createSupplier(input: {
    sessionId: string | null;
    businessId: string;
    supplier: ContactRecordInput;
    now?: Date;
  }): SupplierSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:write",
      now
    );
    assertValid(validateContactRecordInput(input.supplier, "Supplier"));
    const normalized = normalizeContactRecordInput(input.supplier);
    const supplier: SupplierSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      name: normalized.name,
      phone: normalized.phone,
      linkedPhonebookContactId: null,
      linkedPhonebookContactName: null,
      email: normalized.email,
      notes: normalized.notes,
      salesAgentCount: 0,
      purchaseReceiptCount: 0,
      lastPurchaseDate: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    this.suppliers.set(supplier.id, supplier);
    this.deps.appendBusinessEvent(
      supplierCreatedEvent({
        id: randomUUID(),
        supplier,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return supplier;
  }

  updateSupplier(input: {
    sessionId: string | null;
    businessId: string;
    supplierId: string;
    supplier: ContactRecordInput;
    now?: Date;
  }): SupplierSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:write",
      now
    );
    const existing = this.requireSupplier(input.businessId, input.supplierId);
    assertValid(validateContactRecordInput(input.supplier, "Supplier"));
    const normalized = normalizeContactRecordInput(input.supplier);
    const updated: SupplierSummary = {
      ...existing,
      name: normalized.name,
      phone: normalized.phone,
      email: normalized.email,
      notes: normalized.notes,
      updatedAt: now.toISOString()
    };

    this.suppliers.set(updated.id, updated);
    this.deps.appendBusinessEvent(
      supplierUpdatedEvent({
        id: randomUUID(),
        supplier: updated,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return updated;
  }

  deleteSupplier(input: {
    sessionId: string | null;
    businessId: string;
    supplierId: string;
    now?: Date;
  }): { deleted: true; supplierId: string } {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:write",
      input.now
    );
    this.requireSupplier(input.businessId, input.supplierId);

    for (const agent of this.salesAgentsForSupplier(input.supplierId)) {
      this.salesAgents.delete(agent.id);
    }

    for (const link of [...this.supplierContactLinks.values()]) {
      if (link.supplierId === input.supplierId) {
        this.supplierContactLinks.delete(link.id);
      }
    }

    this.suppliers.delete(input.supplierId);

    return {
      deleted: true,
      supplierId: input.supplierId
    };
  }

  listSalesAgents(input: {
    sessionId: string | null;
    businessId: string;
    supplierId?: string;
    now?: Date;
  }): SalesAgentSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:read",
      input.now
    );
    return [...this.salesAgents.values()]
      .filter(
        (agent) =>
          agent.businessId === input.businessId &&
          (input.supplierId === undefined || agent.supplierId === input.supplierId)
      )
      .map((agent) => this.salesAgentCard(agent));
  }

  createSalesAgent(input: {
    sessionId: string | null;
    businessId: string;
    supplierId: string;
    agent: ContactRecordInput;
    now?: Date;
  }): SalesAgentSummary {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "supplier:write", now);
    const supplier = this.requireSupplier(input.businessId, input.supplierId);
    assertValid(validateContactRecordInput(input.agent, "Sales agent"));
    const normalized = normalizeContactRecordInput(input.agent);
    const agent: SalesAgentSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      supplierId: supplier.id,
      supplierName: supplier.name,
      name: normalized.name,
      phone: normalized.phone,
      linkedPhonebookContactId: null,
      linkedPhonebookContactName: null,
      notes: normalized.notes,
      receiptsHandled: 0,
      lastTransactionDate: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    this.salesAgents.set(agent.id, agent);
    this.refreshSupplierMetrics(supplier.id);

    return this.salesAgentCard(agent);
  }

  updateSalesAgent(input: {
    sessionId: string | null;
    businessId: string;
    salesAgentId: string;
    agent: ContactRecordInput;
    now?: Date;
  }): SalesAgentSummary {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "supplier:write", now);
    const existing = this.requireSalesAgent(input.businessId, input.salesAgentId);
    assertValid(validateContactRecordInput(input.agent, "Sales agent"));
    const normalized = normalizeContactRecordInput(input.agent);
    const updated: SalesAgentSummary = {
      ...existing,
      name: normalized.name,
      phone: normalized.phone,
      notes: normalized.notes,
      updatedAt: now.toISOString()
    };

    this.salesAgents.set(updated.id, updated);
    this.refreshSupplierMetrics(updated.supplierId);

    return this.salesAgentCard(updated);
  }

  deleteSalesAgent(input: {
    sessionId: string | null;
    businessId: string;
    salesAgentId: string;
    now?: Date;
  }): { deleted: true; salesAgentId: string } {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:write",
      input.now
    );
    const agent = this.requireSalesAgent(input.businessId, input.salesAgentId);

    for (const link of [...this.supplierContactLinks.values()]) {
      if (link.salesAgentId === agent.id) {
        this.supplierContactLinks.delete(link.id);
      }
    }

    this.salesAgents.delete(agent.id);
    this.refreshSupplierMetrics(agent.supplierId);

    return {
      deleted: true,
      salesAgentId: agent.id
    };
  }

  searchSupplierPhonebookContacts(input: {
    sessionId: string | null;
    businessId: string;
    query: string;
    now?: Date;
  }): NetworkNodeSummary[] {
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:read",
      input.now
    );
    const query = input.query.trim().toLowerCase();

    return [...this.deps.networkNodes.values()]
      .filter(
        (node) =>
          node.ownerUserId === session.user.id &&
          node.sourceType === "phone_contact" &&
          node.displayName.toLowerCase().includes(query)
      )
      .slice(0, 25)
      .map(
        this.deps.phonebookNodeViewer === undefined
          ? sanitizeNetworkNode
          : this.deps.phonebookNodeViewer(session.user.id)
      );
  }

  createSupplierFromPhoneContact(input: {
    sessionId: string | null;
    businessId: string;
    networkNodeId: string;
    notes?: string | null;
    now?: Date;
  }): SupplierBusinessCardSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:write",
      now
    );
    const node = this.deps.requirePhonebookNode(session.user.id, input.networkNodeId);
    const supplier = this.createSupplier({
      sessionId: input.sessionId,
      businessId: input.businessId,
      supplier: {
        name: node.displayName,
        phone: null,
        email: null,
        notes: input.notes ?? "Created from phone contact"
      },
      now
    });

    this.linkSupplierContact({
      sessionId: input.sessionId,
      businessId: input.businessId,
      supplierId: supplier.id,
      networkNodeId: node.id,
      now
    });

    return this.supplierBusinessCard(this.requireSupplier(input.businessId, supplier.id));
  }

  createSalesAgentFromPhoneContact(input: {
    sessionId: string | null;
    businessId: string;
    supplierId: string;
    networkNodeId: string;
    notes?: string | null;
    now?: Date;
  }): SalesAgentSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:write",
      now
    );
    const node = this.deps.requirePhonebookNode(session.user.id, input.networkNodeId);
    const agent = this.createSalesAgent({
      sessionId: input.sessionId,
      businessId: input.businessId,
      supplierId: input.supplierId,
      agent: {
        name: node.displayName,
        phone: null,
        email: null,
        notes: input.notes ?? "Created from phone contact"
      },
      now
    });

    this.linkSalesAgentContact({
      sessionId: input.sessionId,
      businessId: input.businessId,
      salesAgentId: agent.id,
      networkNodeId: node.id,
      now
    });

    return this.salesAgentCard(this.requireSalesAgent(input.businessId, agent.id));
  }

  linkSupplierContact(input: {
    sessionId: string | null;
    businessId: string;
    supplierId: string;
    networkNodeId: string;
    now?: Date;
  }): SupplierBusinessCardSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:write",
      now
    );
    const supplier = this.requireSupplier(input.businessId, input.supplierId);
    const node = this.deps.requirePhonebookNode(session.user.id, input.networkNodeId);
    const link = this.upsertSupplierContactLink({
      businessId: input.businessId,
      linkType: "supplier",
      supplierId: supplier.id,
      salesAgentId: null,
      node,
      now
    });
    const updated: SupplierSummary = {
      ...supplier,
      linkedPhonebookContactId: link.networkNodeId,
      linkedPhonebookContactName: link.contactName,
      updatedAt: now.toISOString()
    };

    this.suppliers.set(updated.id, updated);
    return this.supplierBusinessCard(updated);
  }

  linkSalesAgentContact(input: {
    sessionId: string | null;
    businessId: string;
    salesAgentId: string;
    networkNodeId: string;
    now?: Date;
  }): SalesAgentSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:write",
      now
    );
    const agent = this.requireSalesAgent(input.businessId, input.salesAgentId);
    const node = this.deps.requirePhonebookNode(session.user.id, input.networkNodeId);
    const link = this.upsertSupplierContactLink({
      businessId: input.businessId,
      linkType: "sales_agent",
      supplierId: agent.supplierId,
      salesAgentId: agent.id,
      node,
      now
    });
    const updated: SalesAgentSummary = {
      ...agent,
      linkedPhonebookContactId: link.networkNodeId,
      linkedPhonebookContactName: link.contactName,
      updatedAt: now.toISOString()
    };

    this.salesAgents.set(updated.id, updated);
    return this.salesAgentCard(updated);
  }

  createReceiptOCRJob(input: {
    sessionId: string | null;
    businessId: string;
    sourceFileName: string;
    contentType: string;
    extractedText: string;
    fileSizeBytes?: number | null;
    fileSignature?: string | null;
    sourceChecksum?: string;
    extraction?: Pick<
      ReceiptOCRJobSummary,
      | "engine"
      | "engineVersion"
      | "modelVersion"
      | "profile"
      | "fallbackUsed"
      | "blocks"
      | "fullText"
      | "averageConfidence"
      | "warnings"
    >;
    now?: Date;
  }): ReceiptOCRJobSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "import:write",
      now
    );
    const contentType = normalizeReceiptContentType(input.contentType);
    const validation = validateReceiptUpload({
      contentType,
      fileSizeBytes: input.fileSizeBytes ?? null,
      fileSignature: input.fileSignature ?? null
    });

    if (!validation.ok) {
      throw new Cp2Error(400, validation.code, validation.message);
    }

    const extractedText = input.extraction?.fullText ?? input.extractedText;
    const parsed = parseReceiptText(extractedText);
    const matchedSupplier = this.matchSupplier(input.businessId, parsed.supplierName, parsed.phone);
    const matchedAgent =
      matchedSupplier === null
        ? null
        : this.matchSalesAgent(
            input.businessId,
            matchedSupplier.id,
            parsed.salesAgentName,
            parsed.phone
          );
    const hasContent = extractedText.trim().length > 0;
    const ocrConfig = readReceiptOCRConfig();
    const blocks =
      input.extraction?.blocks ?? buildReceiptOCRBlocks(extractedText, hasContent ? 0.9 : 0);
    const warnings = [
      ...(input.extraction?.warnings ?? []),
      ...buildReceiptOCRWarnings(parsed, hasContent)
    ];
    const sourceFileName = input.sourceFileName.trim() || "receipt-upload";
    const jobId = randomUUID();
    const structuredExtraction = buildReceiptStructuredExtraction(parsed);
    const contactMatchingResult = this.createReceiptContactMatchingResult({
      businessId: input.businessId,
      ownerUserId: session.user.id,
      ocrJobId: jobId,
      parsed,
      matchedSupplier,
      matchedAgent
    });
    const imageStorageKey = null;
    const imageHash =
      input.sourceChecksum ??
      createHash("sha256")
        .update(`${sourceFileName}:${contentType}:${extractedText}`)
        .digest("hex");
    const job: ReceiptOCRJobSummary = {
      id: jobId,
      businessId: input.businessId,
      tenantId: input.businessId,
      shopId: input.businessId,
      uploadedBy: session.user.id,
      status: !hasContent
        ? "FAILED"
        : matchedSupplier === null || parsed.items.length === 0
          ? "REVIEW_REQUIRED"
          : "MATCHING",
      sourceFileName,
      contentType,
      engine: input.extraction?.engine ?? ocrConfig.primaryEngine,
      engineVersion: input.extraction?.engineVersion ?? ocrConfig.engineVersion,
      modelVersion: input.extraction?.modelVersion ?? ocrConfig.modelVersion,
      profile: input.extraction?.profile ?? ocrConfig.profile,
      fallbackUsed:
        input.extraction?.fallbackUsed ??
        ocrConfig.primaryEngine === receiptOCRDefaultFallbackEngine,
      languageHints: ocrConfig.languageHints,
      blocks,
      fullText: extractedText,
      averageConfidence:
        input.extraction?.averageConfidence ?? averageReceiptBlockConfidence(blocks),
      warnings,
      fieldEvidence: buildReceiptFieldEvidence(parsed, extractedText),
      structuredExtraction,
      contactMatchingResult,
      supplierCandidates: contactMatchingResult.supplier.candidates,
      salesAgentCandidates: contactMatchingResult.salesAgent.candidates,
      supplierName: parsed.supplierName,
      salesAgentName: parsed.salesAgentName,
      phone: parsed.phone,
      receiptDate: parsed.receiptDate,
      total: parsed.total,
      items: parsed.items,
      matchedSupplierId: matchedSupplier?.id ?? null,
      matchedSalesAgentId: matchedAgent?.id ?? null,
      errorMessage: hasContent
        ? null
        : "OCR could not read this receipt. Retry upload or enter receipt details manually.",
      failureCode: hasContent ? null : "ocr_empty_text",
      imageStorageKey,
      imageHash,
      imageRetained: false,
      imageDeletedAt: null,
      cleanupPending: false,
      retryCount: 0,
      processingStartedAt: now.toISOString(),
      completedAt: hasContent ? now.toISOString() : null,
      temporaryImageExpiresAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      confirmedAt: null
    };

    this.receiptOCRJobs.set(job.id, job);
    return job;
  }

  confirmReceiptOCRJob(input: {
    sessionId: string | null;
    businessId: string;
    ocrJobId: string;
    supplierId?: string | null;
    salesAgentId?: string | null;
    createSupplier?: boolean;
    createSalesAgent?: boolean;
    now?: Date;
  }): PurchaseReceiptSummary {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "import:write", now);
    const job = this.requireReceiptOCRJob(input.businessId, input.ocrJobId);

    if (["CONFIRMED", "PURCHASE_RECORDED", "COMPLETED", "confirmed"].includes(job.status)) {
      const existing = [...this.purchaseReceipts.values()].find(
        (receipt) => receipt.businessId === input.businessId && receipt.ocrJobId === input.ocrJobId
      );
      if (existing !== undefined) {
        return { ...existing, lineItems: this.receiptLineItemsForReceipt(existing.id) };
      }
      throw new Cp2Error(
        409,
        "receipt_ocr_already_confirmed",
        "This receipt scan was already confirmed."
      );
    }

    if (job.status === "CANCELLED") {
      throw new Cp2Error(
        409,
        "receipt_ocr_cancelled",
        "A cancelled receipt scan cannot be confirmed."
      );
    }

    if (job.status === "failed" || job.status === "FAILED") {
      throw new Cp2Error(409, "receipt_ocr_failed", job.errorMessage ?? "Receipt OCR failed.");
    }

    let supplier =
      input.supplierId === null || input.supplierId === undefined
        ? job.matchedSupplierId === null
          ? null
          : this.requireSupplier(input.businessId, job.matchedSupplierId)
        : this.requireSupplier(input.businessId, input.supplierId);

    if (supplier === null && input.createSupplier === true && job.supplierName !== null) {
      supplier = this.createSupplier({
        sessionId: input.sessionId,
        businessId: input.businessId,
        supplier: {
          name: job.supplierName,
          phone: job.phone,
          email: null,
          notes: "Created from purchase receipt"
        },
        now
      });
    }

    if (supplier === null) {
      throw new Cp2Error(409, "receipt_supplier_required", "Confirm or create a supplier first.");
    }

    let salesAgent =
      input.salesAgentId === null || input.salesAgentId === undefined
        ? job.matchedSalesAgentId === null
          ? null
          : this.requireSalesAgent(input.businessId, job.matchedSalesAgentId)
        : this.requireSalesAgent(input.businessId, input.salesAgentId);

    if (
      salesAgent === null &&
      input.createSalesAgent === true &&
      job.salesAgentName !== null &&
      job.salesAgentName.trim() !== ""
    ) {
      salesAgent = this.createSalesAgent({
        sessionId: input.sessionId,
        businessId: input.businessId,
        supplierId: supplier.id,
        agent: {
          name: job.salesAgentName,
          phone: job.phone,
          email: null,
          notes: "Created from purchase receipt"
        },
        now
      });
    }

    const receiptId = randomUUID();
    const lineItems = job.items.map((item): ReceiptLineItemSummary => ({
      id: randomUUID(),
      receiptId,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.total
    }));
    const receipt: PurchaseReceiptSummary = {
      id: receiptId,
      businessId: input.businessId,
      supplierId: supplier.id,
      supplierName: supplier.name,
      salesAgentId: salesAgent?.id ?? null,
      salesAgentName: salesAgent?.name ?? job.salesAgentName,
      receiptDate: job.receiptDate ?? now.toISOString(),
      total:
        job.total ??
        lineItems.reduce((sum, item) => {
          return roundMoney(sum + item.total);
        }, 0),
      sourceFileName: job.sourceFileName,
      ocrJobId: job.id,
      imageStored: false,
      createdAt: now.toISOString(),
      lineItems
    };
    const confirmedJob: ReceiptOCRJobSummary = {
      ...job,
      status: "COMPLETED",
      matchedSupplierId: supplier.id,
      matchedSalesAgentId: salesAgent?.id ?? null,
      imageRetained: false,
      imageDeletedAt: job.imageRetained ? now.toISOString() : job.imageDeletedAt,
      cleanupPending: false,
      completedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      confirmedAt: now.toISOString()
    };

    this.purchaseReceipts.set(receipt.id, { ...receipt, lineItems: [] });
    for (const item of lineItems) {
      this.receiptLineItems.set(item.id, item);
    }
    this.receiptOCRJobs.set(confirmedJob.id, confirmedJob);
    this.refreshSupplierMetrics(supplier.id);
    if (salesAgent !== null) {
      this.refreshSalesAgentMetrics(salesAgent.id);
    }

    return receipt;
  }

  correctReceiptOCRJob(input: {
    sessionId: string | null;
    businessId: string;
    ocrJobId: string;
    extractedText: string;
    now?: Date;
  }): ReceiptOCRJobSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "import:write",
      now
    );
    const job = this.requireReceiptOCRJob(input.businessId, input.ocrJobId);

    if (
      ["CONFIRMED", "PURCHASE_RECORDED", "COMPLETED", "CANCELLED", "confirmed"].includes(job.status)
    ) {
      throw new Cp2Error(
        409,
        "receipt_ocr_already_confirmed",
        "A completed receipt scan cannot be corrected."
      );
    }

    const extractedText = input.extractedText.trim();
    if (extractedText.length === 0) {
      throw new Cp2Error(
        400,
        "receipt_ocr_correction_required",
        "Corrected receipt text is required."
      );
    }

    const parsed = parseReceiptText(extractedText);
    const matchedSupplier = this.matchSupplier(input.businessId, parsed.supplierName, parsed.phone);
    const matchedAgent =
      matchedSupplier === null
        ? null
        : this.matchSalesAgent(
            input.businessId,
            matchedSupplier.id,
            parsed.salesAgentName,
            parsed.phone
          );
    const blocks = buildReceiptOCRBlocks(extractedText, 1);
    const warnings = buildReceiptOCRWarnings(parsed, true);
    const contactMatchingResult = this.createReceiptContactMatchingResult({
      businessId: input.businessId,
      ownerUserId: session.user.id,
      ocrJobId: job.id,
      parsed,
      matchedSupplier,
      matchedAgent
    });
    const corrected: ReceiptOCRJobSummary = {
      ...job,
      status:
        matchedSupplier === null || parsed.items.length === 0 ? "REVIEW_REQUIRED" : "MATCHING",
      blocks,
      fullText: extractedText,
      averageConfidence: averageReceiptBlockConfidence(blocks),
      warnings,
      fieldEvidence: buildReceiptFieldEvidence(parsed, extractedText),
      structuredExtraction: buildReceiptStructuredExtraction(parsed),
      contactMatchingResult,
      supplierCandidates: contactMatchingResult.supplier.candidates,
      salesAgentCandidates: contactMatchingResult.salesAgent.candidates,
      supplierName: parsed.supplierName,
      salesAgentName: parsed.salesAgentName,
      phone: parsed.phone,
      receiptDate: parsed.receiptDate,
      total: parsed.total,
      items: parsed.items,
      matchedSupplierId: matchedSupplier?.id ?? null,
      matchedSalesAgentId: matchedAgent?.id ?? null,
      errorMessage: null,
      failureCode: null,
      processingStartedAt: now.toISOString(),
      completedAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    this.receiptOCRJobs.set(corrected.id, corrected);
    return corrected;
  }

  cancelReceiptOCRJob(input: {
    sessionId: string | null;
    businessId: string;
    ocrJobId: string;
    now?: Date;
  }): ReceiptOCRJobSummary {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "import:write", now);
    const job = this.requireReceiptOCRJob(input.businessId, input.ocrJobId);

    if (job.status === "CANCELLED") {
      return job;
    }

    if (["CONFIRMED", "PURCHASE_RECORDED", "COMPLETED", "confirmed"].includes(job.status)) {
      throw new Cp2Error(
        409,
        "receipt_ocr_already_confirmed",
        "A confirmed receipt scan cannot be cancelled."
      );
    }

    const cancelled: ReceiptOCRJobSummary = {
      ...job,
      status: "CANCELLED",
      imageRetained: false,
      imageDeletedAt: job.imageRetained ? now.toISOString() : job.imageDeletedAt,
      cleanupPending: false,
      completedAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.receiptOCRJobs.set(cancelled.id, cancelled);
    return cancelled;
  }

  listReceiptOCRJobs(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): ReceiptOCRJobSummary[] {
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "import:read", input.now);
    return [...this.receiptOCRJobs.values()]
      .filter((job) => job.businessId === input.businessId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listPurchaseReceipts(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): PurchaseReceiptSummary[] {
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "import:read", input.now);
    return [...this.purchaseReceipts.values()]
      .filter((receipt) => receipt.businessId === input.businessId)
      .map((receipt) => ({
        ...receipt,
        lineItems: this.receiptLineItemsForReceipt(receipt.id)
      }))
      .sort((left, right) => right.receiptDate.localeCompare(left.receiptDate));
  }

  getPurchaseReceipt(input: {
    sessionId: string | null;
    businessId: string;
    receiptId: string;
    now?: Date;
  }): PurchaseReceiptSummary {
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "import:read", input.now);
    const receipt = this.purchaseReceipts.get(input.receiptId);

    if (receipt === undefined || receipt.businessId !== input.businessId) {
      throw new Cp2Error(404, "purchase_receipt_not_found", "Purchase receipt was not found.");
    }

    return {
      ...receipt,
      lineItems: this.receiptLineItemsForReceipt(receipt.id)
    };
  }

  suppliersForBusiness(businessId: string): SupplierSummary[] {
    return [...this.suppliers.values()].filter((supplier) => supplier.businessId === businessId);
  }

  salesAgentsForBusiness(businessId: string): SalesAgentSummary[] {
    return [...this.salesAgents.values()].filter((agent) => agent.businessId === businessId);
  }

  requireSupplier(businessId: string, supplierId: string): SupplierSummary {
    const supplier = this.suppliers.get(supplierId);

    if (supplier === undefined || supplier.businessId !== businessId) {
      throw new Cp2Error(404, "supplier_not_found", "Supplier was not found.");
    }

    return supplier;
  }

  private requireSalesAgent(businessId: string, salesAgentId: string): SalesAgentSummary {
    const agent = this.salesAgents.get(salesAgentId);

    if (agent === undefined || agent.businessId !== businessId) {
      throw new Cp2Error(404, "sales_agent_not_found", "Sales agent was not found.");
    }

    return agent;
  }

  private requireReceiptOCRJob(businessId: string, ocrJobId: string): ReceiptOCRJobSummary {
    const job = this.receiptOCRJobs.get(ocrJobId);

    if (job === undefined || job.businessId !== businessId) {
      throw new Cp2Error(404, "receipt_ocr_not_found", "Receipt OCR job was not found.");
    }

    return job;
  }

  private createReceiptContactMatchingResult(input: {
    businessId: string;
    ownerUserId: string;
    ocrJobId: string;
    parsed: ParsedReceiptText;
    matchedSupplier: SupplierSummary | null;
    matchedAgent: SalesAgentSummary | null;
  }): ReceiptOCRJobSummary["contactMatchingResult"] {
    const thresholds = readReceiptContactMatchThresholds();
    const supplierCandidates = this.buildSupplierContactCandidates({
      businessId: input.businessId,
      ownerUserId: input.ownerUserId,
      parsed: input.parsed,
      matchedSupplier: input.matchedSupplier,
      thresholds
    });
    const selectedSupplier = selectReceiptCandidate(supplierCandidates, thresholds);
    const salesAgentCandidates = this.buildSalesAgentContactCandidates({
      businessId: input.businessId,
      ownerUserId: input.ownerUserId,
      supplierId: selectedSupplier?.recordId ?? input.matchedSupplier?.id ?? null,
      parsed: input.parsed,
      matchedAgent: input.matchedAgent,
      thresholds
    });
    const selectedSalesAgent = selectReceiptCandidate(salesAgentCandidates, thresholds);
    const unmatchedFields = [
      ...(supplierCandidates.length === 0 ? ["supplier"] : []),
      ...(input.parsed.salesAgentName !== null && salesAgentCandidates.length === 0
        ? ["salesAgent"]
        : [])
    ];
    const warnings = [
      ...(hasTiedHighConfidenceCandidates(supplierCandidates, thresholds)
        ? ["Supplier contact matching produced tied high-confidence candidates."]
        : []),
      ...(hasTiedHighConfidenceCandidates(salesAgentCandidates, thresholds)
        ? ["Sales-agent contact matching produced tied high-confidence candidates."]
        : [])
    ];

    return {
      matched: supplierCandidates.length > 0 || salesAgentCandidates.length > 0,
      scriptId: "receipt_contact_matching",
      intent: "RECEIPT_CONTACT_MATCH",
      source: "context_script",
      ocrJobId: input.ocrJobId,
      supplier: {
        extractedName: input.parsed.supplierName,
        extractedPhone: input.parsed.phone,
        extractedEmail: input.parsed.supplierEmail,
        selectedRecordId: selectedSupplier?.recordId ?? null,
        selectedContactId: selectedSupplier?.contactId ?? null,
        confidence: selectedSupplier?.confidence ?? 0,
        matchedBy: selectedSupplier?.matchedBy ?? [],
        sources: selectedSupplier?.sources ?? [],
        requiresConfirmation: selectedSupplier?.requiresConfirmation ?? true,
        candidates: supplierCandidates
      },
      salesAgent: {
        extractedName: input.parsed.salesAgentName,
        extractedPhone: input.parsed.salesAgentPhone ?? input.parsed.phone,
        extractedEmail: input.parsed.salesAgentEmail,
        selectedRecordId: selectedSalesAgent?.recordId ?? null,
        selectedContactId: selectedSalesAgent?.contactId ?? null,
        confidence: selectedSalesAgent?.confidence ?? 0,
        matchedBy: selectedSalesAgent?.matchedBy ?? [],
        sources: selectedSalesAgent?.sources ?? [],
        requiresConfirmation: selectedSalesAgent?.requiresConfirmation ?? true,
        candidates: salesAgentCandidates
      },
      unmatchedFields,
      warnings,
      thresholds
    };
  }

  private buildSupplierContactCandidates(input: {
    businessId: string;
    ownerUserId: string;
    parsed: ParsedReceiptText;
    matchedSupplier: SupplierSummary | null;
    thresholds: ReceiptOCRJobSummary["contactMatchingResult"]["thresholds"];
  }): ReceiptOCRJobSummary["supplierCandidates"] {
    const candidates: ReceiptOCRJobSummary["supplierCandidates"] = [];
    const addCandidate = (candidate: ReceiptOCRJobSummary["supplierCandidates"][number]) => {
      const existingIndex = candidates.findIndex(
        (existing) =>
          existing.recordId === candidate.recordId && existing.contactId === candidate.contactId
      );

      if (existingIndex === -1) {
        candidates.push(candidate);
        return;
      }

      const existing = candidates[existingIndex]!;
      candidates[existingIndex] = {
        ...existing,
        confidence: Math.max(existing.confidence, candidate.confidence),
        matchedBy: [...new Set([...existing.matchedBy, ...candidate.matchedBy])],
        sources: [...new Set([...existing.sources, ...candidate.sources])],
        reason: `${existing.reason} ${candidate.reason}`.trim(),
        requiresConfirmation:
          Math.max(existing.confidence, candidate.confidence) < input.thresholds.autoSelect
      };
    };

    for (const link of [...this.supplierContactLinks.values()]) {
      if (link.businessId !== input.businessId || link.linkType !== "supplier") {
        continue;
      }

      const supplier =
        link.supplierId === null ? null : (this.suppliers.get(link.supplierId) ?? null);
      const node = this.getAuthorizedContactNode(input.ownerUserId, link.networkNodeId);

      if (supplier === null || node === null) {
        continue;
      }

      const matchedBy = receiptSupplierMatchedBy(input.parsed, supplier, node);

      if (matchedBy.includes("confirmed_contact_link") || matchedBy.length > 1) {
        addCandidate(
          createReceiptCandidate({
            entityType: "supplier",
            recordId: supplier.id,
            contactId: node.id,
            displayName: supplier.name,
            confidence: matchedBy.includes("phone_exact") ? 0.98 : 0.96,
            matchedBy,
            sources: [contactSourceLabel(node), "confirmed_suppliers"],
            thresholds: input.thresholds,
            reason: "Matched supplier through an existing confirmed supplier-contact link."
          })
        );
      }
    }

    for (const supplier of [...this.suppliers.values()].filter(
      (supplier) => supplier.businessId === input.businessId
    )) {
      const linkedNode =
        supplier.linkedPhonebookContactId === null
          ? null
          : this.getAuthorizedContactNode(input.ownerUserId, supplier.linkedPhonebookContactId);
      const matchedBy = receiptSupplierMatchedBy(input.parsed, supplier, linkedNode).filter(
        (match) =>
          match === "tax_pin_exact" ||
          match === "registration_number_exact" ||
          match === "phone_exact" ||
          match === "email_exact" ||
          match === "name_exact"
      );

      if (matchedBy.length === 0) {
        continue;
      }

      addCandidate(
        createReceiptCandidate({
          entityType: "supplier",
          recordId: supplier.id,
          contactId: linkedNode?.id ?? null,
          displayName: supplier.name,
          confidence: receiptIdentifierConfidence(matchedBy),
          matchedBy,
          sources: [
            ...(linkedNode === null ? [] : [contactSourceLabel(linkedNode)]),
            "confirmed_suppliers"
          ],
          thresholds: input.thresholds,
          reason: "Matched supplier through deterministic supplier record identifiers."
        })
      );
    }

    for (const receipt of [...this.purchaseReceipts.values()].filter(
      (receipt) => receipt.businessId === input.businessId
    )) {
      if (
        input.parsed.supplierName === null ||
        normalizeReceiptName(receipt.supplierName) !==
          normalizeReceiptName(input.parsed.supplierName)
      ) {
        continue;
      }

      addCandidate(
        createReceiptCandidate({
          entityType: "supplier",
          recordId: receipt.supplierId,
          contactId: null,
          displayName: receipt.supplierName,
          confidence: 0.88,
          matchedBy: ["previous_receipt_pattern"],
          sources: ["previous_receipts"],
          thresholds: input.thresholds,
          reason: "Matched supplier through a previous confirmed receipt pattern."
        })
      );
    }

    if (input.matchedSupplier !== null) {
      const linkedNode =
        input.matchedSupplier.linkedPhonebookContactId === null
          ? null
          : this.getAuthorizedContactNode(
              input.ownerUserId,
              input.matchedSupplier.linkedPhonebookContactId
            );
      const matchedBy = receiptSupplierMatchedBy(input.parsed, input.matchedSupplier, linkedNode);

      addCandidate(
        createReceiptCandidate({
          entityType: "supplier",
          recordId: input.matchedSupplier.id,
          contactId: linkedNode?.id ?? null,
          displayName: input.matchedSupplier.name,
          confidence: matchedBy.includes("phone_exact") ? 0.97 : 0.9,
          matchedBy: matchedBy.length === 0 ? ["previous_receipt_pattern"] : matchedBy,
          sources: [
            ...(linkedNode === null ? [] : [contactSourceLabel(linkedNode)]),
            "previous_receipts",
            "confirmed_suppliers"
          ],
          thresholds: input.thresholds,
          reason: "Matched supplier from OCR fields against confirmed supplier records."
        })
      );
    }

    for (const node of this.authorizedReceiptContactNodes(input.ownerUserId)) {
      if (
        input.parsed.supplierName !== null &&
        normalizeReceiptName(node.displayName) === normalizeReceiptName(input.parsed.supplierName)
      ) {
        addCandidate(
          createReceiptCandidate({
            entityType: "contact",
            recordId: null,
            contactId: node.id,
            displayName: node.displayName,
            confidence: 0.82,
            matchedBy: ["name_exact"],
            sources: [contactSourceLabel(node)],
            thresholds: input.thresholds,
            reason: "Matched OCR supplier name against an authorized synced contact."
          })
        );
      }
    }

    return candidates.sort(compareReceiptCandidates);
  }

  private buildSalesAgentContactCandidates(input: {
    businessId: string;
    ownerUserId: string;
    supplierId: string | null;
    parsed: ParsedReceiptText;
    matchedAgent: SalesAgentSummary | null;
    thresholds: ReceiptOCRJobSummary["contactMatchingResult"]["thresholds"];
  }): ReceiptOCRJobSummary["salesAgentCandidates"] {
    const candidates: ReceiptOCRJobSummary["salesAgentCandidates"] = [];
    const addCandidate = (candidate: ReceiptOCRJobSummary["salesAgentCandidates"][number]) => {
      const existingIndex = candidates.findIndex(
        (existing) =>
          existing.recordId === candidate.recordId && existing.contactId === candidate.contactId
      );

      if (existingIndex === -1) {
        candidates.push(candidate);
        return;
      }

      const existing = candidates[existingIndex]!;
      candidates[existingIndex] = {
        ...existing,
        confidence: Math.max(existing.confidence, candidate.confidence),
        matchedBy: [...new Set([...existing.matchedBy, ...candidate.matchedBy])],
        sources: [...new Set([...existing.sources, ...candidate.sources])],
        requiresConfirmation:
          Math.max(existing.confidence, candidate.confidence) < input.thresholds.autoSelect
      };
    };

    for (const link of [...this.supplierContactLinks.values()]) {
      if (
        link.businessId !== input.businessId ||
        link.linkType !== "sales_agent" ||
        (input.supplierId !== null && link.supplierId !== input.supplierId)
      ) {
        continue;
      }

      const agent =
        link.salesAgentId === null ? null : (this.salesAgents.get(link.salesAgentId) ?? null);
      const node = this.getAuthorizedContactNode(input.ownerUserId, link.networkNodeId);

      if (agent === null || node === null) {
        continue;
      }

      const matchedBy = receiptSalesAgentMatchedBy(input.parsed, agent, node, input.supplierId);

      if (matchedBy.includes("confirmed_contact_link") || matchedBy.length > 1) {
        addCandidate(
          createReceiptCandidate({
            entityType: "sales_agent",
            recordId: agent.id,
            contactId: node.id,
            displayName: agent.name,
            confidence: matchedBy.includes("phone_exact") ? 0.97 : 0.86,
            matchedBy,
            sources: [contactSourceLabel(node), "confirmed_sales_agents"],
            thresholds: input.thresholds,
            reason: "Matched sales agent through an existing confirmed contact link."
          })
        );
      }
    }

    for (const agent of [...this.salesAgents.values()].filter(
      (agent) =>
        agent.businessId === input.businessId &&
        (input.supplierId === null || agent.supplierId === input.supplierId)
    )) {
      const linkedNode =
        agent.linkedPhonebookContactId === null
          ? null
          : this.getAuthorizedContactNode(input.ownerUserId, agent.linkedPhonebookContactId);
      const matchedBy = receiptSalesAgentMatchedBy(
        input.parsed,
        agent,
        linkedNode,
        input.supplierId
      ).filter(
        (match) =>
          match === "phone_exact" ||
          match === "name_exact" ||
          match === "name_supplier_combination" ||
          match === "confirmed_contact_link"
      );

      if (matchedBy.length === 0) {
        continue;
      }

      addCandidate(
        createReceiptCandidate({
          entityType: "sales_agent",
          recordId: agent.id,
          contactId: linkedNode?.id ?? null,
          displayName: agent.name,
          confidence: receiptIdentifierConfidence(matchedBy),
          matchedBy,
          sources: [
            ...(linkedNode === null ? [] : [contactSourceLabel(linkedNode)]),
            "confirmed_sales_agents"
          ],
          thresholds: input.thresholds,
          reason: "Matched sales agent through deterministic supplier-scoped identifiers."
        })
      );
    }

    if (input.matchedAgent !== null) {
      const linkedNode =
        input.matchedAgent.linkedPhonebookContactId === null
          ? null
          : this.getAuthorizedContactNode(
              input.ownerUserId,
              input.matchedAgent.linkedPhonebookContactId
            );
      const matchedBy = receiptSalesAgentMatchedBy(
        input.parsed,
        input.matchedAgent,
        linkedNode,
        input.supplierId
      );

      addCandidate(
        createReceiptCandidate({
          entityType: "sales_agent",
          recordId: input.matchedAgent.id,
          contactId: linkedNode?.id ?? null,
          displayName: input.matchedAgent.name,
          confidence: matchedBy.includes("phone_exact") ? 0.94 : 0.86,
          matchedBy: matchedBy.length === 0 ? ["previous_receipt_association"] : matchedBy,
          sources: [
            ...(linkedNode === null ? [] : [contactSourceLabel(linkedNode)]),
            "previous_receipts",
            "confirmed_sales_agents"
          ],
          thresholds: input.thresholds,
          reason: "Matched sales agent from OCR fields against confirmed sales-agent records."
        })
      );
    }

    for (const node of this.authorizedReceiptContactNodes(input.ownerUserId)) {
      if (
        input.parsed.salesAgentName !== null &&
        normalizeReceiptName(node.displayName) === normalizeReceiptName(input.parsed.salesAgentName)
      ) {
        addCandidate(
          createReceiptCandidate({
            entityType: "contact",
            recordId: null,
            contactId: node.id,
            displayName: node.displayName,
            confidence: 0.8,
            matchedBy: ["name_exact"],
            sources: [contactSourceLabel(node)],
            thresholds: input.thresholds,
            reason: "Matched OCR sales-agent name against an authorized synced contact."
          })
        );
      }
    }

    return candidates.sort(compareReceiptCandidates);
  }

  private authorizedReceiptContactNodes(ownerUserId: string): NetworkNodeSummary[] {
    return [...this.deps.networkNodes.values()].filter(
      (node) =>
        node.ownerUserId === ownerUserId &&
        node.degree === 1 &&
        node.visibilityStatus === "direct" &&
        node.consentStatus !== "revoked" &&
        this.isNetworkSourceActive(node.sourceId)
    );
  }

  private getAuthorizedContactNode(
    ownerUserId: string,
    networkNodeId: string
  ): NetworkNodeSummary | null {
    const node = this.deps.networkNodes.get(networkNodeId);

    if (
      node === undefined ||
      node.ownerUserId !== ownerUserId ||
      node.consentStatus === "revoked" ||
      !this.isNetworkSourceActive(node.sourceId)
    ) {
      return null;
    }

    return node;
  }

  private isNetworkSourceActive(sourceId: string | null): boolean {
    if (sourceId === null) {
      return true;
    }

    return this.deps.networkSources.get(sourceId)?.status === "active";
  }

  private supplierBusinessCard(supplier: SupplierSummary): SupplierBusinessCardSummary {
    const salesAgents = this.salesAgentsForSupplier(supplier.id).map((agent) =>
      this.salesAgentCard(agent)
    );
    const purchaseReceipts = this.purchaseReceiptsForSupplier(supplier.id);
    const lastPurchaseDate =
      purchaseReceipts
        .map((receipt) => receipt.receiptDate)
        .sort((left, right) => right.localeCompare(left))[0] ?? null;

    return {
      ...supplier,
      salesAgentCount: salesAgents.length,
      purchaseReceiptCount: purchaseReceipts.length,
      lastPurchaseDate,
      salesAgents,
      purchaseReceipts
    };
  }

  private salesAgentCard(agent: SalesAgentSummary): SalesAgentSummary {
    const receipts = this.purchaseReceiptsForSalesAgent(agent.id);
    const lastTransactionDate =
      receipts
        .map((receipt) => receipt.receiptDate)
        .sort((left, right) => right.localeCompare(left))[0] ?? null;

    return {
      ...agent,
      supplierName: this.suppliers.get(agent.supplierId)?.name ?? agent.supplierName,
      receiptsHandled: receipts.length,
      lastTransactionDate
    };
  }

  private salesAgentsForSupplier(supplierId: string): SalesAgentSummary[] {
    return [...this.salesAgents.values()].filter((agent) => agent.supplierId === supplierId);
  }

  private purchaseReceiptsForSupplier(supplierId: string): PurchaseReceiptSummary[] {
    return [...this.purchaseReceipts.values()]
      .filter((receipt) => receipt.supplierId === supplierId)
      .map((receipt) => ({
        ...receipt,
        lineItems: this.receiptLineItemsForReceipt(receipt.id)
      }))
      .sort((left, right) => right.receiptDate.localeCompare(left.receiptDate));
  }

  private purchaseReceiptsForSalesAgent(salesAgentId: string): PurchaseReceiptSummary[] {
    return [...this.purchaseReceipts.values()]
      .filter((receipt) => receipt.salesAgentId === salesAgentId)
      .map((receipt) => ({
        ...receipt,
        lineItems: this.receiptLineItemsForReceipt(receipt.id)
      }));
  }

  receiptLineItemsForReceipt(receiptId: string): ReceiptLineItemSummary[] {
    return [...this.receiptLineItems.values()].filter((item) => item.receiptId === receiptId);
  }

  private refreshSupplierMetrics(supplierId: string): void {
    const supplier = this.suppliers.get(supplierId);

    if (supplier === undefined) {
      return;
    }

    const card = this.supplierBusinessCard(supplier);
    this.suppliers.set(supplierId, {
      ...supplier,
      salesAgentCount: card.salesAgentCount,
      purchaseReceiptCount: card.purchaseReceiptCount,
      lastPurchaseDate: card.lastPurchaseDate
    });
  }

  private refreshSalesAgentMetrics(salesAgentId: string): void {
    const agent = this.salesAgents.get(salesAgentId);

    if (agent === undefined) {
      return;
    }

    const card = this.salesAgentCard(agent);
    this.salesAgents.set(salesAgentId, {
      ...agent,
      receiptsHandled: card.receiptsHandled,
      lastTransactionDate: card.lastTransactionDate
    });
  }

  private matchSupplier(
    businessId: string,
    supplierName: string | null,
    phone: string | null
  ): SupplierSummary | null {
    const normalizedName = supplierName?.trim().toLowerCase() ?? "";
    const normalizedPhone = phone === null ? null : normalizeDestination("phone", phone);

    return (
      this.suppliersForBusiness(businessId).find(
        (supplier) =>
          (normalizedPhone !== null && supplier.phone === normalizedPhone) ||
          (normalizedName.length > 0 && supplier.name.trim().toLowerCase() === normalizedName)
      ) ?? null
    );
  }

  private matchSalesAgent(
    businessId: string,
    supplierId: string,
    salesAgentName: string | null,
    phone: string | null
  ): SalesAgentSummary | null {
    const normalizedName = salesAgentName?.trim().toLowerCase() ?? "";
    const normalizedPhone = phone === null ? null : normalizeDestination("phone", phone);

    return (
      this.salesAgentsForSupplier(supplierId).find(
        (agent) =>
          agent.businessId === businessId &&
          ((normalizedPhone !== null && agent.phone === normalizedPhone) ||
            (normalizedName.length > 0 && agent.name.trim().toLowerCase() === normalizedName))
      ) ?? null
    );
  }

  private upsertSupplierContactLink(input: {
    businessId: string;
    linkType: "supplier" | "sales_agent";
    supplierId: string | null;
    salesAgentId: string | null;
    node: NetworkNodeSummary;
    now: Date;
  }): SupplierContactLinkSummary {
    const existing = [...this.supplierContactLinks.values()].find(
      (link) =>
        link.businessId === input.businessId &&
        link.linkType === input.linkType &&
        link.supplierId === input.supplierId &&
        link.salesAgentId === input.salesAgentId
    );
    const link: SupplierContactLinkSummary = {
      id: existing?.id ?? randomUUID(),
      businessId: input.businessId,
      linkType: input.linkType,
      supplierId: input.supplierId,
      salesAgentId: input.salesAgentId,
      networkNodeId: input.node.id,
      contactName: input.node.displayName,
      linkedAt: input.now.toISOString()
    };

    this.supplierContactLinks.set(link.id, link);
    return link;
  }
}
