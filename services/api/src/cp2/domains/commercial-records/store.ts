import { randomUUID } from "node:crypto";
import { normalizeInternationalPhoneInput } from "@grogoni/shared-types";
import type {
  AccountSummary,
  AuthenticatedActorView,
  CanonicalContactSummary,
  ContactSource,
  CustomerSummary,
  DeliveryRouteStatus,
  DeliveryRouteStopSummary,
  DeliveryRouteSummary,
  InvoiceSummary,
  LocationSummary,
  ProductPurchasePriceSummary,
  ProductSummary,
  PurchaseRecordSummary,
  SaleRecordSummary,
  SalesAgentSummary,
  SupplierContactRelationshipSummary,
  SupplierContactRole,
  SupplierSummary
} from "@grogoni/shared-types";
import type { BusinessPermission } from "@grogoni/business-core";
import { Cp2Error } from "../../cp2-error.js";
import { roundMoney } from "../../money.js";

export interface GeoProvider {
  geocode(input: { address: string }): Promise<Partial<LocationSummary>>;
  reverseGeocode(input: { latitude: number; longitude: number }): Promise<Partial<LocationSummary>>;
  calculateRoute(input: {
    origin: LocationSummary;
    destination: LocationSummary;
    stops: LocationSummary[];
  }): Promise<{
    externalRouteId?: string;
    distanceMeters?: number;
    durationSeconds?: number;
    geometry?: string;
  }>;
  normalizeLocation(input: Partial<LocationSummary>): Partial<LocationSummary>;
}

interface AuditInput {
  type: string;
  aggregateType: string;
  aggregateId: string;
  actorId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface CommercialRecordsDomainDeps {
  requireAuthorizedSession: (
    sessionId: string | null,
    businessId: string,
    permission: BusinessPermission,
    now?: Date
  ) => AuthenticatedActorView;
  recordAuditEvent: (input: AuditInput) => void;
  requireAccount: (accountId: string) => AccountSummary;
  requireProduct: (businessId: string, productId: string) => ProductSummary;
  setProductBuyingPrice: (businessId: string, productId: string, price: number, now: Date) => void;
  requireSupplier: (businessId: string, supplierId: string) => SupplierSummary;
  requireCustomer: (businessId: string, customerId: string) => CustomerSummary;
  // SALES_AGENT is the one role that already has a real, tested implementation - the supplier
  // domain's sales-agent CRUD and OCR receipt-agent matching. Attaching/detaching that role
  // delegates here instead of writing a second, disconnected "who is this supplier's agent"
  // record, so both the legacy sales-agent API and this role-based API share one store of truth.
  listSalesAgentsForSupplier: (input: {
    sessionId: string | null;
    businessId: string;
    supplierId?: string;
    now?: Date;
  }) => SalesAgentSummary[];
  createSalesAgent: (input: {
    sessionId: string | null;
    businessId: string;
    supplierId: string;
    agent: { name: string; phone?: string | null; notes?: string | null };
    now?: Date;
  }) => SalesAgentSummary;
  linkSalesAgentContact: (input: {
    sessionId: string | null;
    businessId: string;
    salesAgentId: string;
    networkNodeId: string;
    now?: Date;
  }) => SalesAgentSummary;
  deleteSalesAgent: (input: {
    sessionId: string | null;
    businessId: string;
    salesAgentId: string;
    now?: Date;
  }) => { deleted: true; salesAgentId: string };
  createInvoice: (input: {
    sessionId: string | null;
    businessId: string;
    invoice: {
      customerId?: string | null;
      customerName?: string | null;
      taxRate?: number | null;
      items: Array<{ productId: string; quantity: number; unitPrice: number }>;
    };
    now?: Date;
  }) => InvoiceSummary;
  confirmInvoice: (input: {
    sessionId: string | null;
    businessId: string;
    invoiceId: string;
    now?: Date;
  }) => { invoice: InvoiceSummary };
}

export class CommercialRecordsDomain {
  private readonly contacts = new Map<string, CanonicalContactSummary>();
  private readonly supplierContacts = new Map<string, SupplierContactRelationshipSummary>();
  private readonly purchasePrices = new Map<string, ProductPurchasePriceSummary>();
  private readonly purchases = new Map<string, PurchaseRecordSummary>();
  private readonly sales = new Map<string, SaleRecordSummary>();
  private readonly locations = new Map<string, LocationSummary>();
  private readonly routes = new Map<string, DeliveryRouteSummary>();
  private readonly routeStops = new Map<string, DeliveryRouteStopSummary>();

  constructor(private readonly deps: CommercialRecordsDomainDeps) {}

  get contactsMap() {
    return this.contacts;
  }
  get supplierContactsMap() {
    return this.supplierContacts;
  }
  get purchasePricesMap() {
    return this.purchasePrices;
  }
  get purchasesMap() {
    return this.purchases;
  }
  get salesMap() {
    return this.sales;
  }
  get locationsMap() {
    return this.locations;
  }
  get routesMap() {
    return this.routes;
  }
  get routeStopsMap() {
    return this.routeStops;
  }

  clear(): void {
    this.contacts.clear();
    this.supplierContacts.clear();
    this.purchasePrices.clear();
    this.purchases.clear();
    this.sales.clear();
    this.locations.clear();
    this.routes.clear();
    this.routeStops.clear();
  }

  listContacts(input: {
    sessionId: string | null;
    businessId: string;
    query?: string | undefined;
    now?: Date;
  }) {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:read",
      input.now
    );
    const query = input.query?.trim().toLowerCase() ?? "";
    return [...this.contacts.values()]
      .filter((contact) => contact.businessId === input.businessId)
      .filter(
        (contact) =>
          query === "" ||
          contact.displayName.toLowerCase().includes(query) ||
          contact.normalizedPhone?.includes(query) === true ||
          contact.normalizedEmail?.includes(query) === true
      )
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  getContact(input: {
    sessionId: string | null;
    businessId: string;
    contactId: string;
    now?: Date;
  }) {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:read",
      input.now
    );
    return this.requireContact(input.businessId, input.contactId);
  }

  importContacts(input: {
    sessionId: string | null;
    businessId: string;
    contacts: Array<{
      displayName: string;
      givenName?: string | null;
      familyName?: string | null;
      phones?: string[];
      emails?: string[];
      externalIdentities?: Array<{ provider: string; externalId: string }>;
      source?: ContactSource | undefined;
      sourceExternalId?: string | null;
      avatarRef?: string | null;
    }>;
    source?: ContactSource | undefined;
    now?: Date;
  }): { contacts: CanonicalContactSummary[]; created: number; updated: number } {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    if (
      !Array.isArray(input.contacts) ||
      input.contacts.length === 0 ||
      input.contacts.length > 5_000
    ) {
      throw new Cp2Error(
        400,
        "contacts_invalid",
        "Import between one and 5,000 explicitly selected contacts."
      );
    }
    let created = 0;
    let updated = 0;
    const contacts = input.contacts.map((raw) => {
      const normalized = normalizeContact(raw, input.source ?? "MANUAL");
      const existing = this.findDuplicateContact(input.businessId, normalized);
      if (existing !== null) {
        const merged: CanonicalContactSummary = {
          ...existing,
          ...normalized,
          id: existing.id,
          businessId: input.businessId,
          linkedAccountId: existing.linkedAccountId,
          createdAt: existing.createdAt,
          updatedAt: now.toISOString(),
          lastSyncedAt: now.toISOString()
        };
        this.contacts.set(merged.id, merged);
        updated += 1;
        return merged;
      }
      const contact: CanonicalContactSummary = {
        ...normalized,
        id: randomUUID(),
        businessId: input.businessId,
        linkedAccountId: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastSyncedAt: normalized.source === "MANUAL" ? null : now.toISOString()
      };
      this.contacts.set(contact.id, contact);
      created += 1;
      return contact;
    });
    this.deps.recordAuditEvent({
      type: "CONTACT_SYNCED",
      aggregateType: "contact_import",
      aggregateId: randomUUID(),
      actorId: actor.user.id,
      occurredAt: now.toISOString(),
      payload: { businessId: input.businessId, created, updated, source: input.source ?? "MANUAL" }
    });
    return { contacts, created, updated };
  }

  linkContactAccount(input: {
    sessionId: string | null;
    businessId: string;
    contactId: string;
    accountId: string | null;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    const contact = this.requireContact(input.businessId, input.contactId);
    if (input.accountId !== null) this.deps.requireAccount(input.accountId);
    const updated = { ...contact, linkedAccountId: input.accountId, updatedAt: now.toISOString() };
    this.contacts.set(updated.id, updated);
    this.deps.recordAuditEvent({
      type: "CONTACT_LINKED",
      aggregateType: "contact",
      aggregateId: contact.id,
      actorId: actor.user.id,
      occurredAt: now.toISOString(),
      payload: { businessId: input.businessId, linked: input.accountId !== null }
    });
    return updated;
  }

  listSupplierContacts(input: {
    sessionId: string | null;
    businessId: string;
    supplierId: string;
    includeHistorical?: boolean;
    now?: Date;
  }): SupplierContactRelationshipSummary[] {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "supplier:read", now);
    this.deps.requireSupplier(input.businessId, input.supplierId);
    const salesAgents = this.deps
      .listSalesAgentsForSupplier({
        sessionId: input.sessionId,
        businessId: input.businessId,
        supplierId: input.supplierId,
        now
      })
      .map((agent) => this.salesAgentRelationshipView(input.businessId, agent));
    const otherRoles = [...this.supplierContacts.values()].filter(
      (link) =>
        link.businessId === input.businessId &&
        link.supplierId === input.supplierId &&
        (input.includeHistorical === true || link.validTo === null)
    );
    return [...salesAgents, ...otherRoles].sort(
      (left, right) =>
        Number(right.isPrimary) - Number(left.isPrimary) ||
        right.validFrom.localeCompare(left.validFrom)
    );
  }

  attachSupplierContact(input: {
    sessionId: string | null;
    businessId: string;
    supplierId: string;
    contactId: string;
    role: SupplierContactRole;
    isPrimary?: boolean;
    validFrom?: string | undefined;
    now?: Date;
  }): SupplierContactRelationshipSummary {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:write",
      now
    );
    this.deps.requireSupplier(input.businessId, input.supplierId);
    const contact = this.requireContact(input.businessId, input.contactId);

    // SALES_AGENT already has a real, tested home - the supplier domain's sales-agent CRUD and
    // OCR receipt-agent matching - so it delegates there instead of writing a second, disconnected
    // "who is this supplier's agent" record.
    if (input.role === "SALES_AGENT") {
      const existingAgent = this.deps
        .listSalesAgentsForSupplier({
          sessionId: input.sessionId,
          businessId: input.businessId,
          supplierId: input.supplierId,
          now
        })
        .find(
          (agent) =>
            (contact.normalizedPhone !== null && agent.phone === contact.normalizedPhone) ||
            agent.name.trim().toLowerCase() === contact.displayName.trim().toLowerCase()
        );
      const agent =
        existingAgent ??
        this.deps.createSalesAgent({
          sessionId: input.sessionId,
          businessId: input.businessId,
          supplierId: input.supplierId,
          agent: {
            name: contact.displayName,
            phone: contact.phones[0] ?? null,
            notes: null
          },
          now
        });
      // A PHONEBOOK-source contact does not always have a matching NetworkDomain node - device-
      // selected contacts can be imported directly (spec: the backend is not required to hold its
      // own phone-graph sync of the same device contact). Link when a real node exists; otherwise
      // the agent stays backed by the contact's name/phone alone, same as a MANUAL contact.
      let linked = agent;
      if (contact.source === "PHONEBOOK" && contact.sourceExternalId !== null) {
        try {
          linked = this.deps.linkSalesAgentContact({
            sessionId: input.sessionId,
            businessId: input.businessId,
            salesAgentId: agent.id,
            networkNodeId: contact.sourceExternalId,
            now
          });
        } catch (error) {
          if (!(error instanceof Cp2Error) || error.code !== "phonebook_contact_not_found")
            throw error;
        }
      }
      return this.salesAgentRelationshipView(input.businessId, linked, contact.id);
    }

    const duplicate = [...this.supplierContacts.values()].find(
      (link) =>
        link.businessId === input.businessId &&
        link.supplierId === input.supplierId &&
        link.contactId === input.contactId &&
        link.role === input.role &&
        link.validTo === null
    );
    if (duplicate !== undefined) return duplicate;
    if (input.isPrimary === true) {
      for (const [id, link] of this.supplierContacts) {
        if (
          link.businessId === input.businessId &&
          link.supplierId === input.supplierId &&
          link.role === input.role &&
          link.validTo === null &&
          link.isPrimary
        ) {
          this.supplierContacts.set(id, {
            ...link,
            isPrimary: false,
            updatedAt: now.toISOString()
          });
        }
      }
    }
    const relationship: SupplierContactRelationshipSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      supplierId: input.supplierId,
      contactId: input.contactId,
      role: input.role,
      isPrimary: input.isPrimary === true,
      validFrom: normalizeTimestamp(input.validFrom, now),
      validTo: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.supplierContacts.set(relationship.id, relationship);
    this.deps.recordAuditEvent({
      type: "SUPPLIER_CONTACT_ADDED",
      aggregateType: "supplier_contact",
      aggregateId: relationship.id,
      actorId: actor.user.id,
      occurredAt: now.toISOString(),
      payload: {
        businessId: input.businessId,
        supplierId: input.supplierId,
        contactId: input.contactId,
        role: input.role
      }
    });
    return relationship;
  }

  detachSupplierContact(input: {
    sessionId: string | null;
    businessId: string;
    relationshipId: string;
    now?: Date;
  }): SupplierContactRelationshipSummary {
    const now = input.now ?? new Date();
    const existing = this.supplierContacts.get(input.relationshipId);

    if (existing === undefined) {
      // Not a native (non-sales-agent-role) relationship - it may be a delegated SALES_AGENT
      // relationship, whose id is the underlying sales agent's id.
      const actor = this.deps.requireAuthorizedSession(
        input.sessionId,
        input.businessId,
        "supplier:write",
        now
      );
      const salesAgent = this.deps
        .listSalesAgentsForSupplier({
          sessionId: input.sessionId,
          businessId: input.businessId,
          now
        })
        .map((agent) => this.salesAgentRelationshipView(input.businessId, agent))
        .find((agent) => agent.id === input.relationshipId);
      if (salesAgent !== undefined) {
        this.deps.deleteSalesAgent({
          sessionId: input.sessionId,
          businessId: input.businessId,
          salesAgentId: salesAgent.id,
          now
        });
        const closed = { ...salesAgent, validTo: now.toISOString(), isPrimary: false };
        this.deps.recordAuditEvent({
          type: "SUPPLIER_CONTACT_REMOVED",
          aggregateType: "supplier_contact",
          aggregateId: closed.id,
          actorId: actor.user.id,
          occurredAt: now.toISOString(),
          payload: {
            businessId: input.businessId,
            supplierId: closed.supplierId,
            contactId: closed.contactId
          }
        });
        return closed;
      }
      throw new Cp2Error(
        404,
        "supplier_contact_not_found",
        "Supplier contact relationship was not found."
      );
    }

    if (existing.businessId !== input.businessId)
      throw new Cp2Error(
        404,
        "supplier_contact_not_found",
        "Supplier contact relationship was not found."
      );
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "supplier:write",
      now
    );
    const closed =
      existing.validTo === null
        ? {
            ...existing,
            validTo: now.toISOString(),
            isPrimary: false,
            updatedAt: now.toISOString()
          }
        : existing;
    this.supplierContacts.set(closed.id, closed);
    this.deps.recordAuditEvent({
      type: "SUPPLIER_CONTACT_REMOVED",
      aggregateType: "supplier_contact",
      aggregateId: closed.id,
      actorId: actor.user.id,
      occurredAt: now.toISOString(),
      payload: {
        businessId: input.businessId,
        supplierId: closed.supplierId,
        contactId: closed.contactId
      }
    });
    return closed;
  }

  private salesAgentRelationshipView(
    businessId: string,
    agent: SalesAgentSummary,
    contactId: string | null = null
  ): SupplierContactRelationshipSummary {
    return {
      id: agent.id,
      businessId,
      supplierId: agent.supplierId,
      contactId: contactId ?? this.findContactIdForAgent(businessId, agent),
      role: "SALES_AGENT",
      isPrimary: false,
      validFrom: agent.createdAt,
      validTo: null,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt
    };
  }

  private isContactLinkedToSupplier(
    sessionId: string | null,
    businessId: string,
    supplierId: string,
    contactId: string,
    now: Date
  ): boolean {
    if (
      [...this.supplierContacts.values()].some(
        (link) =>
          link.businessId === businessId &&
          link.supplierId === supplierId &&
          link.contactId === contactId &&
          link.validTo === null
      )
    )
      return true;
    return this.deps
      .listSalesAgentsForSupplier({ sessionId, businessId, supplierId, now })
      .some((agent) => this.findContactIdForAgent(businessId, agent) === contactId);
  }

  private findContactIdForAgent(businessId: string, agent: SalesAgentSummary): string | null {
    const match = [...this.contacts.values()].find(
      (contact) =>
        contact.businessId === businessId &&
        ((agent.linkedPhonebookContactId !== null &&
          contact.source === "PHONEBOOK" &&
          contact.sourceExternalId === agent.linkedPhonebookContactId) ||
          contact.displayName.trim().toLowerCase() === agent.name.trim().toLowerCase())
    );
    return match?.id ?? null;
  }

  recordProductPriceMutation(input: {
    businessId: string;
    product: ProductSummary;
    previousPrice: number | null;
    supplierId?: string | null;
    supplierContactId?: string | null;
    price: number;
    currency?: string | undefined;
    effectiveAt?: string | undefined;
    deliveredAt?: string | null;
    purchaseRecordId?: string | null;
    actorId: string;
    source: ProductPurchasePriceSummary["source"];
    now: Date;
  }): ProductPurchasePriceSummary {
    const current = this.currentPriceRecord(input.businessId, input.product.id);
    if (
      current !== null &&
      current.price === input.price &&
      current.supplierId === (input.supplierId ?? null) &&
      current.supplierContactId === (input.supplierContactId ?? null)
    )
      return current;
    const effectiveFrom = normalizeTimestamp(input.effectiveAt, input.now);
    if (current !== null)
      this.purchasePrices.set(current.id, { ...current, effectiveTo: effectiveFrom });
    const supplier =
      input.supplierId == null
        ? null
        : this.deps.requireSupplier(input.businessId, input.supplierId);
    const contact =
      input.supplierContactId == null
        ? null
        : this.requireContact(input.businessId, input.supplierContactId);
    const record: ProductPurchasePriceSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      productId: input.product.id,
      productNameSnapshot: input.product.name,
      supplierId: supplier?.id ?? null,
      supplierNameSnapshot: supplier?.name ?? null,
      supplierContactId: contact?.id ?? null,
      contactNameSnapshot: contact?.displayName ?? null,
      price: roundMoney(input.price),
      currency: normalizeCurrency(input.currency),
      effectiveFrom,
      effectiveTo: null,
      deliveredAt: input.deliveredAt ?? null,
      purchaseRecordId: input.purchaseRecordId ?? null,
      createdBy: input.actorId,
      source: input.source,
      createdAt: input.now.toISOString(),
      supersedesId: current?.id ?? null
    };
    this.purchasePrices.set(record.id, record);
    return record;
  }

  changePurchasePrice(input: {
    sessionId: string | null;
    businessId: string;
    productId: string;
    price: number;
    currency?: string | undefined;
    supplierId?: string | null;
    supplierContactId?: string | null;
    effectiveAt?: string | undefined;
    deliveredAt?: string | null;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:write",
      now
    );
    if (!Number.isFinite(input.price) || input.price < 0)
      throw new Cp2Error(
        400,
        "buying_price_invalid",
        "Buying price must be a finite non-negative amount."
      );
    const product = this.deps.requireProduct(input.businessId, input.productId);
    const previous = this.currentPriceRecord(input.businessId, input.productId);
    const record = this.recordProductPriceMutation({
      ...input,
      product,
      previousPrice: previous?.price ?? product.buyingPrice,
      actorId: actor.user.id,
      source: "MANUAL",
      now
    });
    this.deps.setProductBuyingPrice(input.businessId, product.id, record.price, now);
    this.deps.recordAuditEvent({
      type: "PURCHASE_PRICE_CHANGED",
      aggregateType: "product_purchase_price",
      aggregateId: record.id,
      actorId: actor.user.id,
      occurredAt: now.toISOString(),
      payload: {
        businessId: input.businessId,
        productId: product.id,
        previousPrice: previous?.price ?? product.buyingPrice,
        newPrice: record.price,
        currency: record.currency
      }
    });
    return { current: record, previous };
  }

  listPurchasePriceHistory(input: {
    sessionId: string | null;
    businessId: string;
    productId: string;
    now?: Date;
  }) {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:read",
      input.now
    );
    this.deps.requireProduct(input.businessId, input.productId);
    return [...this.purchasePrices.values()]
      .filter(
        (record) => record.businessId === input.businessId && record.productId === input.productId
      )
      .sort(
        (a, b) =>
          b.effectiveFrom.localeCompare(a.effectiveFrom) || b.createdAt.localeCompare(a.createdAt)
      );
  }

  createPurchase(input: {
    sessionId: string | null;
    businessId: string;
    supplierId: string;
    supplierContactId?: string | null;
    productId: string;
    quantity: number;
    unit?: string | undefined;
    buyingPrice: number;
    currency?: string | undefined;
    deliveredAt?: string | null;
    effectiveAt?: string | undefined;
    source?: string | undefined;
    notes?: string | null;
    routeId?: string | null;
    locationId?: string | null;
    externalSourceId?: string | null;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "import:write",
      now
    );
    if (input.externalSourceId) {
      const existing = [...this.purchases.values()].find(
        (item) =>
          item.businessId === input.businessId && item.externalSourceId === input.externalSourceId
      );
      if (existing !== undefined) return existing;
    }
    if (
      !Number.isFinite(input.quantity) ||
      input.quantity <= 0 ||
      !Number.isFinite(input.buyingPrice) ||
      input.buyingPrice < 0
    )
      throw new Cp2Error(
        400,
        "purchase_invalid",
        "Purchase quantity and buying price are invalid."
      );
    const supplier = this.deps.requireSupplier(input.businessId, input.supplierId);
    const product = this.deps.requireProduct(input.businessId, input.productId);
    const contact =
      input.supplierContactId == null
        ? null
        : this.requireContact(input.businessId, input.supplierContactId);
    if (
      contact !== null &&
      !this.isContactLinkedToSupplier(
        input.sessionId,
        input.businessId,
        supplier.id,
        contact.id,
        now
      )
    )
      throw new Cp2Error(
        409,
        "supplier_contact_not_linked",
        "The contact is not currently linked to this supplier."
      );
    if (input.routeId) this.requireRoute(input.businessId, input.routeId);
    if (input.locationId) this.requireLocation(input.businessId, input.locationId);
    const effectiveAt = normalizeTimestamp(input.effectiveAt, now);
    const purchase: PurchaseRecordSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      supplierId: supplier.id,
      supplierNameSnapshot: supplier.name,
      supplierContactId: contact?.id ?? null,
      contactNameSnapshot: contact?.displayName ?? null,
      productId: product.id,
      productNameSnapshot: product.name,
      quantity: input.quantity,
      unit: input.unit?.trim() || product.unit,
      buyingPrice: roundMoney(input.buyingPrice),
      currency: normalizeCurrency(input.currency),
      totalCost: roundMoney(input.quantity * input.buyingPrice),
      deliveredAt: input.deliveredAt ?? null,
      effectiveAt,
      recordedBy: actor.user.id,
      source: input.source?.trim() || "MANUAL",
      notes: input.notes?.trim() || null,
      routeId: input.routeId ?? null,
      locationId: input.locationId ?? null,
      externalSourceId: input.externalSourceId?.trim() || null,
      createdAt: now.toISOString()
    };
    this.purchases.set(purchase.id, purchase);
    const price = this.recordProductPriceMutation({
      businessId: input.businessId,
      product,
      previousPrice: product.buyingPrice,
      supplierId: supplier.id,
      supplierContactId: contact?.id ?? null,
      price: purchase.buyingPrice,
      currency: purchase.currency,
      effectiveAt,
      deliveredAt: purchase.deliveredAt,
      purchaseRecordId: purchase.id,
      actorId: actor.user.id,
      source: "PURCHASE",
      now
    });
    this.deps.setProductBuyingPrice(input.businessId, product.id, price.price, now);
    this.deps.recordAuditEvent({
      type: "PURCHASE_RECORDED",
      aggregateType: "purchase",
      aggregateId: purchase.id,
      actorId: actor.user.id,
      occurredAt: now.toISOString(),
      payload: {
        businessId: input.businessId,
        supplierId: supplier.id,
        productId: product.id,
        quantity: purchase.quantity,
        currency: purchase.currency
      }
    });
    return purchase;
  }

  listPurchaseHistory(input: {
    sessionId: string | null;
    businessId: string;
    productId?: string | undefined;
    supplierId?: string | undefined;
    now?: Date;
  }) {
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "import:read", input.now);
    return [...this.purchases.values()]
      .filter(
        (record) =>
          record.businessId === input.businessId &&
          (!input.productId || record.productId === input.productId) &&
          (!input.supplierId || record.supplierId === input.supplierId)
      )
      .sort(
        (a, b) =>
          b.effectiveAt.localeCompare(a.effectiveAt) || b.createdAt.localeCompare(a.createdAt)
      );
  }

  createSale(input: {
    sessionId: string | null;
    businessId: string;
    customerId?: string | null;
    customerName?: string | null;
    customerContactId?: string | null;
    items: Array<{ productId: string; quantity: number; unitPrice: number }>;
    currency?: string | undefined;
    soldAt?: string | undefined;
    routeId?: string | null;
    externalSourceId?: string | null;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "invoice:confirm",
      now
    );
    if (input.externalSourceId) {
      const existing = [...this.sales.values()].find(
        (item) =>
          item.businessId === input.businessId && item.externalSourceId === input.externalSourceId
      );
      if (existing !== undefined) return existing;
    }
    const customer =
      input.customerId == null
        ? null
        : this.deps.requireCustomer(input.businessId, input.customerId);
    const contact =
      input.customerContactId == null
        ? null
        : this.requireContact(input.businessId, input.customerContactId);
    if (input.routeId) this.requireRoute(input.businessId, input.routeId);
    const draft = this.deps.createInvoice({
      sessionId: input.sessionId,
      businessId: input.businessId,
      invoice: {
        customerId: customer?.id ?? null,
        customerName: customer?.name ?? input.customerName ?? contact?.displayName ?? null,
        taxRate: 0,
        items: input.items
      },
      now
    });
    const invoice = this.deps.confirmInvoice({
      sessionId: input.sessionId,
      businessId: input.businessId,
      invoiceId: draft.id,
      now
    }).invoice;
    const sale: SaleRecordSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      invoiceId: invoice.id,
      customerId: customer?.id ?? null,
      customerNameSnapshot: customer?.name ?? invoice.customerName,
      customerContactId: contact?.id ?? null,
      contactNameSnapshot: contact?.displayName ?? null,
      items: invoice.items.map((item) => ({ ...item })),
      total: invoice.total,
      currency: normalizeCurrency(input.currency),
      soldAt: normalizeTimestamp(input.soldAt, now),
      routeId: input.routeId ?? null,
      recordedBy: actor.user.id,
      externalSourceId: input.externalSourceId?.trim() || null,
      createdAt: now.toISOString()
    };
    this.sales.set(sale.id, sale);
    this.deps.recordAuditEvent({
      type: "SALE_RECORDED",
      aggregateType: "sale",
      aggregateId: sale.id,
      actorId: actor.user.id,
      occurredAt: now.toISOString(),
      payload: {
        businessId: input.businessId,
        invoiceId: invoice.id,
        customerId: sale.customerId,
        currency: sale.currency,
        total: sale.total
      }
    });
    return sale;
  }

  listSalesHistory(input: {
    sessionId: string | null;
    businessId: string;
    customerId?: string | undefined;
    customerContactId?: string | undefined;
    now?: Date;
  }) {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "invoice:read",
      input.now
    );
    return [...this.sales.values()]
      .filter(
        (record) =>
          record.businessId === input.businessId &&
          (!input.customerId || record.customerId === input.customerId) &&
          (!input.customerContactId || record.customerContactId === input.customerContactId)
      )
      .sort((a, b) => b.soldAt.localeCompare(a.soldAt));
  }

  createRoute(input: {
    sessionId: string | null;
    businessId: string;
    origin: LocationInput;
    destination: LocationInput;
    stops?: Array<
      LocationInput & {
        contactId?: string | null;
        arrivalAt?: string | null;
        departureAt?: string | null;
        deliveredAt?: string | null;
      }
    >;
    status?: DeliveryRouteStatus | undefined;
    provider?: string | undefined;
    externalRouteId?: string | null;
    distanceMeters?: number | null | undefined;
    durationSeconds?: number | null | undefined;
    geometry?: string | null;
    externalSourceId?: string | null;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "logistics:write",
      now
    );
    if (input.externalSourceId) {
      const existing = [...this.routes.values()].find(
        (item) =>
          item.businessId === input.businessId && item.externalSourceId === input.externalSourceId
      );
      if (existing !== undefined) return this.routeView(existing);
    }
    const origin = this.createLocation(input.businessId, input.origin, now);
    const destination = this.createLocation(input.businessId, input.destination, now);
    const routeId = randomUUID();
    const stopInputs = [input.origin, ...(input.stops ?? []), input.destination];
    const locationIds = [
      origin.id,
      ...(input.stops ?? []).map((stop) => this.createLocation(input.businessId, stop, now).id),
      destination.id
    ];
    const stops = stopInputs.map((stop, sequence): DeliveryRouteStopSummary => {
      if (stop.contactId) this.requireContact(input.businessId, stop.contactId);
      return {
        id: randomUUID(),
        routeId,
        sequence,
        locationId: locationIds[sequence] as string,
        contactId: stop.contactId ?? null,
        arrivalAt: stop.arrivalAt ?? null,
        departureAt: stop.departureAt ?? null,
        deliveredAt: stop.deliveredAt ?? null
      };
    });
    const route: DeliveryRouteSummary = {
      id: routeId,
      businessId: input.businessId,
      originLocationId: origin.id,
      destinationLocationId: destination.id,
      status: input.status ?? "PLANNED",
      provider: input.provider?.trim() || "manual",
      externalRouteId: input.externalRouteId ?? null,
      distanceMeters: validOptionalNonNegative(input.distanceMeters, "distanceMeters"),
      durationSeconds: validOptionalNonNegative(input.durationSeconds, "durationSeconds"),
      geometry: input.geometry ?? null,
      externalSourceId: input.externalSourceId?.trim() || null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      stops: []
    };
    this.routes.set(route.id, route);
    for (const stop of stops) this.routeStops.set(stop.id, stop);
    this.deps.recordAuditEvent({
      type: "ROUTE_CREATED",
      aggregateType: "route",
      aggregateId: route.id,
      actorId: actor.user.id,
      occurredAt: now.toISOString(),
      payload: { businessId: input.businessId, provider: route.provider, stopCount: stops.length }
    });
    return this.routeView(route);
  }

  updateRoute(input: {
    sessionId: string | null;
    businessId: string;
    routeId: string;
    status: DeliveryRouteStatus;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "logistics:write",
      now
    );
    const route = this.requireRoute(input.businessId, input.routeId);
    const updated = { ...route, status: input.status, updatedAt: now.toISOString() };
    this.routes.set(updated.id, updated);
    this.deps.recordAuditEvent({
      type: "ROUTE_UPDATED",
      aggregateType: "route",
      aggregateId: route.id,
      actorId: actor.user.id,
      occurredAt: now.toISOString(),
      payload: { businessId: input.businessId, status: input.status }
    });
    return this.routeView(updated);
  }

  listRouteHistory(input: {
    sessionId: string | null;
    businessId: string;
    destinationLocationId?: string | undefined;
    now?: Date;
  }) {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "logistics:read",
      input.now
    );
    return [...this.routes.values()]
      .filter(
        (route) =>
          route.businessId === input.businessId &&
          (!input.destinationLocationId ||
            route.destinationLocationId === input.destinationLocationId)
      )
      .map((route) => this.routeView(route))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private createLocation(businessId: string, input: LocationInput, now: Date): LocationSummary {
    const label = input.label?.trim();
    if (!label) throw new Cp2Error(400, "location_label_required", "Location label is required.");
    const location: LocationSummary = {
      id: randomUUID(),
      businessId,
      label,
      address: input.address?.trim() || null,
      latitude: validCoordinate(input.latitude, -90, 90, "latitude"),
      longitude: validCoordinate(input.longitude, -180, 180, "longitude"),
      region: input.region?.trim() || null,
      country: input.country?.trim() || null,
      providerPlaceId: input.providerPlaceId?.trim() || null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.locations.set(location.id, location);
    return location;
  }

  private routeView(route: DeliveryRouteSummary): DeliveryRouteSummary {
    return {
      ...route,
      stops: [...this.routeStops.values()]
        .filter((stop) => stop.routeId === route.id)
        .sort((a, b) => a.sequence - b.sequence)
    };
  }
  private requireContact(businessId: string, id: string) {
    const value = this.contacts.get(id);
    if (!value || value.businessId !== businessId)
      throw new Cp2Error(404, "contact_not_found", "Contact was not found.");
    return value;
  }
  private requireRoute(businessId: string, id: string) {
    const value = this.routes.get(id);
    if (!value || value.businessId !== businessId)
      throw new Cp2Error(404, "route_not_found", "Route was not found.");
    return value;
  }
  private requireLocation(businessId: string, id: string) {
    const value = this.locations.get(id);
    if (!value || value.businessId !== businessId)
      throw new Cp2Error(404, "location_not_found", "Location was not found.");
    return value;
  }
  private currentPriceRecord(businessId: string, productId: string) {
    return (
      [...this.purchasePrices.values()]
        .filter(
          (record) =>
            record.businessId === businessId &&
            record.productId === productId &&
            record.effectiveTo === null
        )
        .sort(
          (a, b) =>
            b.effectiveFrom.localeCompare(a.effectiveFrom) || b.createdAt.localeCompare(a.createdAt)
        )[0] ?? null
    );
  }
  private findDuplicateContact(businessId: string, contact: ReturnType<typeof normalizeContact>) {
    return (
      [...this.contacts.values()].find(
        (candidate) =>
          candidate.businessId === businessId &&
          ((contact.sourceExternalId !== null &&
            candidate.source === contact.source &&
            candidate.sourceExternalId === contact.sourceExternalId) ||
            (contact.normalizedPhone !== null &&
              candidate.normalizedPhone === contact.normalizedPhone) ||
            (contact.normalizedEmail !== null &&
              candidate.normalizedEmail === contact.normalizedEmail))
      ) ?? null
    );
  }
}

interface LocationInput {
  label?: string | undefined;
  address?: string | null | undefined;
  latitude?: number | null | undefined;
  longitude?: number | null | undefined;
  region?: string | null | undefined;
  country?: string | null | undefined;
  providerPlaceId?: string | null | undefined;
  contactId?: string | null | undefined;
  arrivalAt?: string | null | undefined;
  departureAt?: string | null | undefined;
  deliveredAt?: string | null | undefined;
}

function normalizeContact(
  raw: {
    displayName: string;
    givenName?: string | null;
    familyName?: string | null;
    phones?: string[];
    emails?: string[];
    externalIdentities?: Array<{ provider: string; externalId: string }>;
    source?: ContactSource | undefined;
    sourceExternalId?: string | null;
    avatarRef?: string | null;
  },
  fallbackSource: ContactSource
) {
  const displayName = raw.displayName?.trim();
  if (!displayName || displayName.length > 160)
    throw new Cp2Error(
      400,
      "contact_name_invalid",
      "Contact display name is required and must be 160 characters or fewer."
    );
  const phones = [
    ...new Set((raw.phones ?? []).map((value) => value.trim()).filter(Boolean))
  ].slice(0, 10);
  const emails = [
    ...new Set((raw.emails ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))
  ].slice(0, 10);
  if (emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)))
    throw new Cp2Error(400, "contact_email_invalid", "Contact email is invalid.");
  const phone = phones[0];
  const parsedPhone = phone ? normalizeInternationalPhoneInput(phone) : null;
  const normalizedPhone =
    parsedPhone?.valid === true ? parsedPhone.e164 : phone?.replace(/[^0-9+]/gu, "") || null;
  const source = raw.source ?? fallbackSource;
  if (!["PHONEBOOK", "EMAIL", "SOCIAL", "MANUAL", "GROGONI_ACCOUNT"].includes(source))
    throw new Cp2Error(400, "contact_source_invalid", "Contact source is not supported.");
  return {
    displayName,
    givenName: raw.givenName?.trim() || null,
    familyName: raw.familyName?.trim() || null,
    phones,
    emails,
    externalIdentities: (raw.externalIdentities ?? [])
      .map((identity) => ({
        provider: identity.provider.trim(),
        externalId: identity.externalId.trim()
      }))
      .filter((identity) => identity.provider && identity.externalId)
      .slice(0, 20),
    source,
    sourceExternalId: raw.sourceExternalId?.trim() || null,
    avatarRef: raw.avatarRef?.trim() || null,
    normalizedPhone,
    normalizedEmail: emails[0] ?? null
  };
}

function normalizeTimestamp(value: string | undefined, fallback: Date): string {
  if (!value) return fallback.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new Cp2Error(400, "timestamp_invalid", "Timestamp must be a valid ISO date.");
  return parsed.toISOString();
}
function normalizeCurrency(value?: string) {
  const currency = value?.trim().toUpperCase() || "KES";
  if (!/^[A-Z]{3}$/u.test(currency))
    throw new Cp2Error(400, "currency_invalid", "Currency must be a three-letter ISO code.");
  return currency;
}
function validOptionalNonNegative(value: number | null | undefined, name: string) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0)
    throw new Cp2Error(400, `${name}_invalid`, `${name} must be non-negative.`);
  return value;
}
function validCoordinate(value: number | null | undefined, min: number, max: number, name: string) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Cp2Error(400, `${name}_invalid`, `${name} is invalid.`);
  return value;
}
