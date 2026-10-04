/**
 * Third slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns the `logistics` and
 * `logisticsByInvoice` (a derived invoice-id -> logistics-id index, never snapshotted) Maps and
 * the delivery-fulfilment CRUD that reads/writes them.
 *
 * Deliberately scoped narrower than the roadmap's original "Logistics & receipts" row: reading
 * the purchase-receipt/receipt-OCR method bodies during this extraction showed they are tightly,
 * bidirectionally coupled to the not-yet-extracted supplier/sales-agent domain (contact matching,
 * metric refresh callbacks) rather than to logistics. That cluster is deferred to be extracted
 * together with suppliers/sales-agents instead of forced into this slice - see the roadmap doc for
 * the full correction note.
 */
import { randomUUID } from "node:crypto";
import {
  logisticsCreatedEvent,
  logisticsStatusUpdatedEvent,
  normalizeLogisticsInput,
  normalizeLogisticsStatusInput,
  validateLogisticsInput,
  validateLogisticsStatusInput,
  validateLogisticsStatusTransition,
  type BusinessPermission,
  type LogisticsInput,
  type LogisticsStatusInput
} from "@grogoni/business-core";
import type { BusinessEvent } from "@grogoni/event-core";
import type {
  AuthenticatedActorView,
  InvoiceSummary,
  LogisticsSummary
} from "@grogoni/shared-types";
import { Cp2Error, assertValid } from "../../cp2-error.js";

export interface LogisticsDomainDeps {
  requireAuthorizedSession: (
    sessionId: string | null,
    businessId: string,
    permission: BusinessPermission,
    now?: Date
  ) => AuthenticatedActorView;
  appendBusinessEvent: (event: BusinessEvent) => void;
  requireInvoice: (businessId: string, invoiceId: string) => InvoiceSummary;
  /** Called after a logistics record is created (a delivery record marks delivery intent). */
  onLogisticsCreated?: (logistics: LogisticsSummary) => void;
}

export class LogisticsDomain {
  private readonly logistics = new Map<string, LogisticsSummary>();
  private readonly logisticsByInvoice = new Map<string, string>();

  constructor(private readonly deps: LogisticsDomainDeps) {}

  get logisticsMap(): Map<string, LogisticsSummary> {
    return this.logistics;
  }

  get logisticsByInvoiceMap(): Map<string, string> {
    return this.logisticsByInvoice;
  }

  clear(): void {
    this.logistics.clear();
    this.logisticsByInvoice.clear();
  }

  rebuildLogisticsByInvoiceIndex(): void {
    this.logisticsByInvoice.clear();
    for (const item of this.logistics.values()) {
      this.logisticsByInvoice.set(item.invoiceId, item.id);
    }
  }

  listLogistics(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): LogisticsSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "logistics:read",
      input.now
    );
    return this.logisticsForBusiness(input.businessId).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
  }

  createLogistics(input: {
    sessionId: string | null;
    businessId: string;
    logistics: LogisticsInput;
    now?: Date;
  }): LogisticsSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "logistics:write",
      now
    );
    return this.createLogisticsAsActor({
      businessId: input.businessId,
      logistics: input.logistics,
      actorId: session.user.id,
      now
    });
  }

  /** Trusted channel adapter entry point; creates the same canonical logistics record. */
  createChannelDelivery(input: {
    businessId: string;
    invoiceId: string;
    actorId: string;
    now: Date;
  }): LogisticsSummary {
    return this.createLogisticsAsActor({
      businessId: input.businessId,
      logistics: {
        invoiceId: input.invoiceId,
        method: "delivery",
        destination: null,
        note: null
      },
      actorId: input.actorId,
      now: input.now
    });
  }

  private createLogisticsAsActor(input: {
    businessId: string;
    logistics: LogisticsInput;
    actorId: string;
    now: Date;
  }): LogisticsSummary {
    const now = input.now;
    assertValid(validateLogisticsInput(input.logistics));
    const normalized = normalizeLogisticsInput(input.logistics);
    const invoice = this.deps.requireInvoice(input.businessId, normalized.invoiceId);

    if (invoice.status !== "confirmed") {
      throw new Cp2Error(
        409,
        "invoice_not_confirmed",
        "Logistics records require a confirmed invoice."
      );
    }

    if (this.logisticsByInvoice.has(invoice.id)) {
      throw new Cp2Error(
        409,
        "logistics_invoice_exists",
        "This invoice already has a logistics record."
      );
    }

    const logistics: LogisticsSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      method: normalized.method,
      status: "pending",
      destination: normalized.destination,
      note: normalized.note,
      actorId: input.actorId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
      cancelledAt: null
    };

    this.logistics.set(logistics.id, logistics);
    this.logisticsByInvoice.set(invoice.id, logistics.id);
    this.deps.onLogisticsCreated?.(logistics);
    this.deps.appendBusinessEvent(
      logisticsCreatedEvent({
        id: randomUUID(),
        logistics,
        actorId: input.actorId,
        occurredAt: now.toISOString()
      })
    );

    return logistics;
  }

  updateLogisticsStatus(input: {
    sessionId: string | null;
    businessId: string;
    logisticsId: string;
    status: LogisticsStatusInput;
    now?: Date;
  }): LogisticsSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "logistics:write",
      now
    );
    const existing = this.requireLogistics(input.businessId, input.logisticsId);
    assertValid(validateLogisticsStatusInput(input.status));
    const normalized = normalizeLogisticsStatusInput(input.status);
    assertValid(
      validateLogisticsStatusTransition(existing.status, normalized.status, existing.method)
    );
    const updated: LogisticsSummary = {
      ...existing,
      status: normalized.status,
      note: normalized.note ?? existing.note,
      updatedAt: now.toISOString(),
      completedAt:
        normalized.status === "completed" ? (existing.completedAt ?? now.toISOString()) : null,
      cancelledAt:
        normalized.status === "cancelled" ? (existing.cancelledAt ?? now.toISOString()) : null
    };

    this.logistics.set(updated.id, updated);
    this.deps.appendBusinessEvent(
      logisticsStatusUpdatedEvent({
        id: randomUUID(),
        logistics: updated,
        previousStatus: existing.status,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return updated;
  }

  logisticsForBusiness(businessId: string): LogisticsSummary[] {
    return [...this.logistics.values()].filter((item) => item.businessId === businessId);
  }

  private requireLogistics(businessId: string, logisticsId: string): LogisticsSummary {
    const logistics = this.logistics.get(logisticsId);

    if (logistics === undefined || logistics.businessId !== businessId) {
      throw new Cp2Error(404, "logistics_not_found", "Logistics record was not found.");
    }

    return logistics;
  }
}
