import { compareCommerceIdentity, readCommerceIdentity } from "./identity.js";
import { readCommerceWebsite } from "./website.js";
import { createHash, randomUUID } from "node:crypto";
import {
  commerceSourceTypes,
  type UnifiedCommerceRecord,
  type CommerceSource,
  type CommerceOffer,
  type PublishedCommerceOffer,
  type CommerceFeedProduct,
  type CommerceSourceCandidate,
  type CommerceOfferOrderSnapshot,
  type ProductSummary
} from "@grogoni/shared-types";
import type { BusinessPermission } from "@grogoni/business-core";
import { Cp2Error } from "../../cp2-error.js";

export interface CommerceSourceRequest {
  sessionId: string | null;
  businessId: string;
  now?: Date;
}
interface Deps {
  authorize: (input: CommerceSourceRequest, permission: BusinessPermission) => string;
  products?: (businessId: string) => ProductSummary[];
  createProduct?: (
    input: CommerceSourceRequest,
    product: { name: string; unit: string; quantity: number; sellingPrice: null }
  ) => ProductSummary;
  websiteReader?: (url: string) => Promise<string>;
  product: (businessId: string, productId: string) => ProductSummary;
  businessName: (businessId: string) => string | null;
  audit: (actorId: string, record: UnifiedCommerceRecord, operation: string) => void;
}
const fail = (message: string): never => {
  throw new Cp2Error(400, "commerce_input_invalid", message);
};
function text(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    return fail(`${name} is required (maximum ${max} characters).`);
  return value.trim();
}
export class CommerceSourcesDomain {
  readonly records = new Map<string, UnifiedCommerceRecord>();
  constructor(private readonly deps: Deps) {}
  recordReceipt(input: {
    businessId: string;
    receiptId: string;
    actorId: string;
    bindings: { receiptLineItemId: string; productId: string }[];
    now: Date;
  }) {
    const at = input.now.toISOString();
    const source: CommerceSource = {
      id: randomUUID(),
      businessId: input.businessId,
      createdAt: at,
      updatedAt: at,
      kind: "source",
      type: "PURCHASE_RECEIPT",
      reference: input.receiptId,
      label: "Confirmed purchase receipt",
      status: "connected",
      authority: "owner_maintained",
      syncPolicy: "manual",
      lastSuccessfulRefresh: at,
      error: null
    };
    // Called inside the existing confirmation rollback boundary, after the delivery binding exists.
    // It does not create inventory, resolve phone identities or publish anything.
    this.records.set(source.id, source);
    for (const binding of input.bindings) {
      const record: UnifiedCommerceRecord = {
        id: randomUUID(),
        businessId: input.businessId,
        createdAt: at,
        updatedAt: at,
        kind: "binding",
        sourceId: source.id,
        productId: binding.productId,
        externalProductId: binding.receiptLineItemId,
        confirmedBy: input.actorId
      };
      this.records.set(record.id, record);
    }
    this.deps.audit(input.actorId, source, "receipt.bound");
  }
  list(input: CommerceSourceRequest) {
    this.deps.authorize(input, "product:read");
    return structuredClone(
      [...this.records.values()].filter(
        (r) =>
          r.businessId === input.businessId ||
          (r.kind === "relationship" && r.targetBusinessId === input.businessId) ||
          (r.kind === "representation" && r.principalBusinessId === input.businessId)
      )
    );
  }
  private owned(input: CommerceSourceRequest, id: string) {
    const record = this.records.get(id);
    if (!record || record.businessId !== input.businessId)
      throw new Cp2Error(404, "commerce_record_not_found", "Commerce record not found.");
    return record;
  }
  private connectedSource(input: CommerceSourceRequest, id: string): CommerceSource {
    const record = this.owned(input, id);
    if (record.kind !== "source" || record.status !== "connected")
      return fail("Select a connected source.");
    return record;
  }
  publicOffer(id: string, now: Date, visited = new Set<string>()): CommerceOffer | null {
    if (visited.has(id) || visited.size >= 20) return null;
    visited.add(id);
    const r = this.records.get(id);
    if (
      !r ||
      r.kind !== "offer" ||
      r.status !== "published" ||
      Date.parse(r.validUntil) <= now.getTime() ||
      !this.deps.businessName(r.businessId)
    )
      return null;
    if (r.sourceId) {
      const source = this.records.get(r.sourceId);
      if (
        !source ||
        source.kind !== "source" ||
        source.businessId !== r.businessId ||
        source.status !== "connected"
      )
        return null;
      if (["WEBSITE", "ERP"].includes(source.type) && !source.authorization) return null;
    }
    if (r.sourceId) {
      const source = this.records.get(r.sourceId);
      if (source?.kind === "source" && source.representationId) {
        const grant = this.records.get(source.representationId);
        if (!grant || grant.kind !== "representation" || grant.status !== "authorized") return null;
      }
    }
    if (r.upstreamOfferId) {
      const upstream = this.publicOffer(r.upstreamOfferId, now, visited);
      if (!upstream?.allowResell) return null;
    }
    try {
      // A reseller retains the upstream product identity; stock is never copied.
      const owner = this.productOwner(r);
      this.deps.product(owner, r.productId);
    } catch {
      return null;
    }
    return r;
  }
  productOwner(offer: CommerceOffer): string {
    let current = offer;
    const seen = new Set<string>();
    while (current.upstreamOfferId) {
      if (seen.has(current.id) || seen.size >= 20) return fail("Offer source cycle.");
      seen.add(current.id);
      const parent = this.records.get(current.upstreamOfferId);
      if (!parent || parent.kind !== "offer") return fail("Upstream offer missing.");
      current = parent;
    }
    return current.businessId;
  }
  search(input: {
    query?: string;
    minPrice?: number;
    maxPrice?: number;
    now?: Date;
  }): PublishedCommerceOffer[] {
    const now = input.now ?? new Date();
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 120);
    return [...this.records.values()]
      .flatMap((r) => {
        if (r.kind !== "offer" || !this.publicOffer(r.id, now)) return [];
        const product = this.deps.product(this.productOwner(r), r.productId);
        const seller = this.deps.businessName(r.businessId)!;
        if (
          query &&
          ![product.name, ...(product.aliases ?? []), seller].some((v) =>
            v.toLowerCase().includes(query)
          )
        )
          return [];
        if (
          (input.minPrice !== undefined && r.price < input.minPrice) ||
          (input.maxPrice !== undefined && r.price > input.maxPrice)
        )
          return [];
        // Deliberate allowlist: no buying prices, private source locators, contact data or quantities.
        return [
          {
            id: r.id,
            businessId: r.businessId,
            seller,
            productId: r.productId,
            name: product.name,
            unit: product.unit,
            aliases: product.aliases ?? [],
            price: r.price,
            currency: r.currency,
            availability: r.availability,
            priceUpdatedAt: r.priceUpdatedAt,
            validUntil: r.validUntil,
            upstreamOfferId: r.upstreamOfferId,
            fulfillment: r.fulfillment
          }
        ];
      })
      .slice(0, 100);
  }
  match(input: CommerceSourceRequest, identityValue: unknown) {
    this.deps.authorize(input, "product:read");
    const identity = readCommerceIdentity(identityValue);
    const bindings = [...this.records.values()].filter(
      (r) => r.kind === "binding" && r.businessId === input.businessId
    );
    return (this.deps.products?.(input.businessId) ?? []).flatMap((product) => {
      const evidence = bindings
        .filter((r) => r.kind === "binding" && r.productId === product.id)
        .map((r) =>
          r.kind === "binding" ? compareCommerceIdentity(identity, r.identity ?? {}) : null
        )
        .filter(Boolean);
      const lexical =
        typeof (identityValue as Record<string, unknown>)?.name === "string" &&
        [product.name, ...(product.aliases ?? [])].some(
          (name) =>
            name.toLowerCase() ===
            String((identityValue as Record<string, unknown>).name)
              .trim()
              .toLowerCase()
        );
      return evidence.some((e) => e?.match || e?.conflicts.length) || lexical
        ? [
            {
              productId: product.id,
              name: product.name,
              unit: product.unit,
              evidence,
              reviewRequired: true
            }
          ]
        : [];
    });
  }
  snapshotOffer(id: string, now: Date): CommerceOfferOrderSnapshot {
    const offer = this.publicOffer(id, now);
    if (!offer)
      throw new Cp2Error(
        409,
        "commerce_offer_unavailable",
        "The offer expired, was withdrawn or its source is disconnected."
      );
    const chain: CommerceOfferOrderSnapshot["chain"] = [];
    let current = offer;
    for (;;) {
      const source = current.sourceId ? this.records.get(current.sourceId) : null;
      chain.push({
        offerId: current.id,
        businessId: current.businessId,
        sourceId: current.sourceId,
        representationId: source?.kind === "source" ? (source.representationId ?? null) : null
      });
      if (!current.upstreamOfferId) break;
      current = this.records.get(current.upstreamOfferId) as CommerceOffer;
    }
    return {
      offerId: offer.id,
      sellerBusinessId: offer.businessId,
      productBusinessId: this.productOwner(offer),
      productId: offer.productId,
      sourceId: offer.sourceId,
      price: offer.price,
      currency: offer.currency,
      priceUpdatedAt: offer.priceUpdatedAt,
      validUntil: offer.validUntil,
      availability: offer.availability,
      fulfillment: offer.fulfillment,
      chain
    };
  }
  stageFeed(input: CommerceSourceRequest, sourceId: string, raw: unknown) {
    const actor = this.deps.authorize(input, "import:write");
    const source = this.connectedSource(input, sourceId);
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { products?: unknown }).products))
      return fail("Use a products array in the structured feed.");
    const products = (raw as { products: unknown[] }).products;
    if (products.length > 1000) return fail("Refresh at most 1000 products at a time.");
    const at = (input.now ?? new Date()).toISOString();
    const seen = new Set<string>();
    // Validate the complete feed before creating any candidates.
    const parsed = products.map((value) => {
      if (!value || typeof value !== "object") return fail("Invalid product row.");
      const r = value as Record<string, unknown>;
      const externalId = text(r.externalId, "External identity", 160);
      if (seen.has(externalId)) return fail("Feed external identities must be unique.");
      seen.add(externalId);
      const price = r.price === undefined ? null : r.price;
      if (
        price !== null &&
        (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 1e12)
      )
        return fail("Invalid feed price.");
      const currency = text(r.currency, "Currency", 3).toUpperCase();
      const validUntil = text(r.validUntil, "Price expiry");
      if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(Date.parse(validUntil)))
        return fail("Invalid currency or expiry.");
      if (
        r.availability !== undefined &&
        !["unknown", "available", "unavailable"].includes(String(r.availability))
      )
        return fail("Invalid availability.");
      const product: CommerceFeedProduct = {
        externalId,
        name: text(r.name, "Name", 160),
        unit: text(r.unit, "Unit", 80),
        price: price as number | null,
        currency,
        validUntil,
        identity: readCommerceIdentity(r.identity),
        availability: (r.availability as CommerceFeedProduct["availability"]) ?? "unknown"
      };
      if (r.evidence) product.evidence = text(r.evidence, "Availability evidence", 1000);
      if (product.availability !== "unknown" && !product.evidence)
        return fail("Availability claims need source evidence.");
      if (r.productUrl) {
        const url = new URL(text(r.productUrl, "Product URL", 2048));
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          (["WEBSITE", "ERP"].includes(source.type) &&
            url.origin !== new URL(source.reference).origin)
        )
          return fail("Product URL must be on the authorized HTTPS source.");
        product.productUrl = url.href;
      }
      return product;
    });
    const staged = parsed.map((product) => {
      const fingerprint = createHash("sha256").update(JSON.stringify(product)).digest("hex");
      const previous = [...this.records.values()].find(
        (r) =>
          r.kind === "candidate" &&
          r.sourceId === source.id &&
          r.externalProductId === product.externalId &&
          r.fingerprint === fingerprint
      );
      if (previous) return previous as CommerceSourceCandidate;
      const binding = [...this.records.values()].find(
        (r) =>
          r.kind === "binding" &&
          r.sourceId === source.id &&
          r.externalProductId === product.externalId
      );
      const candidate: CommerceSourceCandidate = {
        id: randomUUID(),
        businessId: input.businessId,
        kind: "candidate",
        createdAt: at,
        updatedAt: at,
        sourceId,
        externalProductId: product.externalId,
        fingerprint,
        product,
        status: "review",
        conflict: binding ? "Source data changed. Review before applying." : null,
        confirmedProductId: null,
        offerId: null
      };
      this.records.set(candidate.id, candidate);
      return candidate;
    });
    const updated: CommerceSource = {
      ...source,
      lastSuccessfulRefresh: at,
      error: null,
      refreshAttemptAt: at,
      updatedAt: at
    };
    this.records.set(source.id, updated);
    this.deps.audit(actor, updated, "source.refreshed");
    return structuredClone(staged);
  }
  async website(input: CommerceSourceRequest, sourceId: string, action: "verify" | "refresh") {
    const actor = this.deps.authorize(input, "business:write");
    const source = this.connectedSource(input, sourceId);
    if (!["WEBSITE", "ERP"].includes(source.type)) return fail("Select a website or API source.");
    const now = input.now ?? new Date();
    if (source.refreshAttemptAt && now.getTime() - Date.parse(source.refreshAttemptAt) < 15000)
      throw new Cp2Error(429, "commerce_refresh_rate_limit", "Wait before retrying this source.");
    const token = randomUUID();
    const pending = {
      ...source,
      refreshAttemptAt: now.toISOString(),
      updatedAt: now.toISOString(),
      refreshToken: token
    };
    this.records.set(source.id, pending);
    try {
      const reader = this.deps.websiteReader ?? readCommerceWebsite;
      const url = new URL(source.reference);
      if (action === "refresh" && source.authorization?.origin !== url.origin)
        return fail("Verify source ownership first.");
      const content = await reader(
        action === "verify" ? `${url.origin}/.well-known/grogoni-commerce.txt` : source.reference
      );
      if (this.records.get(source.id) !== pending)
        throw new Cp2Error(409, "commerce_source_changed", "Source changed during refresh. Retry.");
      if (action === "verify") {
        if (!source.challenge || content.trim() !== source.challenge)
          return fail("The ownership challenge does not match.");
        const updated: CommerceSource = {
          ...pending,
          updatedAt: now.toISOString(),
          authorization: {
            method: "website_challenge",
            origin: url.origin,
            verifiedAt: now.toISOString()
          },
          error: null,
          syncPolicy: "on_demand"
        };
        this.records.set(source.id, updated);
        this.deps.audit(actor, updated, "source.verified");
        return structuredClone(updated);
      }
      return this.stageFeed(input, source.id, JSON.parse(content));
    } catch (error) {
      if (this.records.get(source.id) === pending)
        this.records.set(source.id, {
          ...pending,
          updatedAt: now.toISOString(),
          error: "Refresh failed. Review source authorization, response and connection, then retry."
        });
      throw error;
    }
  }
  execute(
    input: CommerceSourceRequest,
    operation: string,
    values: Record<string, unknown>
  ): UnifiedCommerceRecord {
    const actor = this.deps.authorize(input, "product:write");
    const now = input.now ?? new Date();
    const at = now.toISOString();
    const base = { id: randomUUID(), businessId: input.businessId, createdAt: at, updatedAt: at };
    let record: UnifiedCommerceRecord;
    switch (operation) {
      case "source.connect": {
        const type = text(values.type, "Source type");
        if (!(commerceSourceTypes as readonly string[]).includes(type))
          return fail("Unknown source type.");
        const reference = text(values.reference, "Source reference", 2048);
        if (type === "WEBSITE" || type === "ERP") {
          let url: URL;
          try {
            url = new URL(reference);
          } catch {
            return fail("Use an HTTPS source URL.");
          }
          if (url.protocol !== "https:" || url.username || url.password)
            return fail("Use an HTTPS source URL without credentials.");
        }
        const existing = [...this.records.values()].find(
          (r) =>
            r.kind === "source" &&
            r.businessId === input.businessId &&
            r.type === type &&
            r.reference === reference &&
            r.status === "connected"
        );
        if (existing) return structuredClone(existing);
        record = {
          ...base,
          kind: "source",
          type: type as CommerceSource["type"],
          reference,
          label: text(values.label, "Source label", 160),
          status: "connected",
          authority: type === "SALES_AGENT" ? "agent_maintained" : "owner_maintained",
          ...(type === "WEBSITE" || type === "ERP"
            ? { challenge: `grogoni-commerce-${randomUUID()}` }
            : {}),
          syncPolicy: "manual",
          lastSuccessfulRefresh: null,
          error: null
        };
        break;
      }
      case "source.disconnect": {
        const source = this.owned(input, text(values.id, "Source ID"));
        if (source.kind !== "source") return fail("Select a source.");
        record = { ...source, updatedAt: at, status: "disconnected" };
        break;
      }
      case "product.bind": {
        const source = this.connectedSource(input, text(values.sourceId, "Source ID"));
        const product = this.deps.product(input.businessId, text(values.productId, "Product ID"));
        const externalProductId = text(values.externalProductId, "External product reference");
        if (values.confirmed !== true) return fail("Confirm this product identity explicitly.");
        const existing = [...this.records.values()].find(
          (r) =>
            r.kind === "binding" &&
            r.businessId === input.businessId &&
            r.sourceId === source.id &&
            r.externalProductId === externalProductId
        );
        if (existing) {
          if (existing.kind === "binding" && existing.productId !== product.id)
            throw new Cp2Error(
              409,
              "commerce_binding_conflict",
              "This source identity is already bound to a different product. Review the conflict."
            );
          return structuredClone(existing);
        }
        record = {
          ...base,
          kind: "binding",
          sourceId: source.id,
          productId: product.id,
          externalProductId,
          confirmedBy: actor,
          identity: readCommerceIdentity(values.identity)
        };
        break;
      }
      case "relationship.request": {
        const targetBusinessId = text(values.targetBusinessId, "Target business");
        if (targetBusinessId === input.businessId || !this.deps.businessName(targetBusinessId))
          return fail("Select a participating business.");
        const existing = [...this.records.values()].find(
          (r) =>
            r.kind === "relationship" &&
            r.businessId === input.businessId &&
            r.targetBusinessId === targetBusinessId &&
            ["requested", "accepted"].includes(r.status)
        );
        if (existing) return structuredClone(existing);
        record = {
          ...base,
          kind: "relationship",
          targetBusinessId,
          status: "requested",
          respondedBy: null
        };
        break;
      }
      case "relationship.respond": {
        const r = this.records.get(text(values.id, "Relationship ID"));
        if (!r || r.kind !== "relationship" || r.targetBusinessId !== input.businessId)
          throw new Cp2Error(404, "commerce_record_not_found", "Relationship not found.");
        if (values.accept !== true && values.accept !== false)
          return fail("Accept or reject explicitly.");
        if (r.status !== "requested")
          throw new Cp2Error(
            409,
            "relationship_already_resolved",
            "This request has already been resolved."
          );
        record = {
          ...r,
          status: values.accept ? "accepted" : "rejected",
          respondedBy: actor,
          updatedAt: at
        };
        break;
      }
      case "relationship.revoke": {
        const r = this.records.get(text(values.id, "Relationship ID"));
        if (
          !r ||
          r.kind !== "relationship" ||
          (r.targetBusinessId !== input.businessId && r.businessId !== input.businessId)
        )
          throw new Cp2Error(404, "commerce_record_not_found", "Relationship not found.");
        record = { ...r, status: "revoked", respondedBy: actor, updatedAt: at };
        break;
      }
      case "receipt.connect": {
        const source = this.connectedSource(input, text(values.sourceId, "Receipt source"));
        const grant = this.records.get(text(values.representationId, "Verified representation"));
        if (
          source.type !== "PURCHASE_RECEIPT" ||
          values.confirmed !== true ||
          grant?.kind !== "representation" ||
          grant.status !== "authorized"
        )
          return fail("Review the receipt identity and choose an authorized sales agent.");
        const relationship: UnifiedCommerceRecord = this.execute(input, "relationship.request", {
          targetBusinessId: grant.businessId
        });
        record = { ...source, distributionRelationshipId: relationship.id, updatedAt: at };
        break;
      }
      case "representation.request": {
        this.deps.authorize(input, "business:write");
        const principalBusinessId = text(values.principalBusinessId, "Wholesaler business");
        if (
          principalBusinessId === input.businessId ||
          !this.deps.businessName(principalBusinessId)
        )
          return fail("Select the wholesaler's participating business.");
        const existing = [...this.records.values()].find(
          (r) =>
            r.kind === "representation" &&
            r.businessId === input.businessId &&
            r.principalBusinessId === principalBusinessId &&
            ["requested", "authorized"].includes(r.status)
        );
        if (existing) return structuredClone(existing);
        record = {
          ...base,
          kind: "representation",
          principalBusinessId,
          status: "requested",
          territory:
            typeof values.territory === "string" ? text(values.territory, "Territory", 160) : null,
          decidedBy: null
        };
        break;
      }
      case "representation.decide": {
        this.deps.authorize(input, "business:write");
        const r = this.records.get(text(values.id, "Representation ID"));
        if (!r || r.kind !== "representation" || r.principalBusinessId !== input.businessId)
          throw new Cp2Error(404, "commerce_record_not_found", "Representation not found.");
        if (
          !["authorized", "rejected", "revoked"].includes(String(values.status)) ||
          values.confirmed !== true
        )
          return fail("Confirm authorization, rejection or revocation explicitly.");
        record = {
          ...r,
          status: values.status as "authorized" | "rejected" | "revoked",
          decidedBy: actor,
          updatedAt: at
        };
        break;
      }
      case "source.representation": {
        const source = this.connectedSource(input, text(values.id, "Source"));
        const grant = this.owned(input, text(values.representationId, "Representation"));
        if (grant.kind !== "representation" || grant.status !== "authorized")
          return fail("The wholesaler must authorize representation first.");
        record = { ...source, representationId: grant.id, updatedAt: at };
        break;
      }
      case "candidate.reject": {
        const candidate = this.owned(input, text(values.id, "Candidate"));
        if (candidate.kind !== "candidate") return fail("Select a product candidate.");
        record = { ...candidate, status: "rejected", updatedAt: at };
        break;
      }
      case "candidate.confirm": {
        const candidate = this.owned(input, text(values.id, "Candidate"));
        if (candidate.kind !== "candidate" || values.confirmed !== true)
          return fail("Review and confirm this candidate.");
        if (candidate.status === "confirmed") return structuredClone(candidate);
        this.connectedSource(input, candidate.sourceId);
        const product = values.productId
          ? this.deps.product(input.businessId, text(values.productId, "Canonical product"))
          : this.deps.createProduct?.(input, {
              name: candidate.product.name,
              unit: candidate.product.unit,
              quantity: 0,
              sellingPrice: null
            });
        if (!product) return fail("Product creation is unavailable.");
        this.execute(input, "product.bind", {
          sourceId: candidate.sourceId,
          productId: product.id,
          externalProductId: candidate.externalProductId,
          identity: candidate.product.identity,
          confirmed: true
        });
        let offerId: string | null = null;
        if (candidate.product.price !== null) {
          const offer = this.execute(input, "offer.create", {
            productId: product.id,
            sourceId: candidate.sourceId,
            price: candidate.product.price,
            currency: candidate.product.currency,
            validUntil: candidate.product.validUntil
          }) as CommerceOffer;
          offerId = offer.id;
          this.records.set(offer.id, {
            ...offer,
            ...(candidate.product.productUrl ? { productUrl: candidate.product.productUrl } : {}),
            availability: candidate.product.availability ?? "unknown",
            availabilityEvidence: candidate.product.evidence ?? null,
            availabilityUpdatedAt: at
          });
        }
        record = {
          ...candidate,
          status: "confirmed",
          confirmedProductId: product.id,
          offerId,
          updatedAt: at
        };
        break;
      }
      case "offer.create": {
        let productId: string;
        let upstreamOfferId: string | null = null;
        let sourceId: string | null = null;
        if (values.upstreamOfferId) {
          const upstream = this.publicOffer(text(values.upstreamOfferId, "Upstream offer"), now);
          if (!upstream?.allowResell || upstream.businessId === input.businessId)
            return fail("Select a published offer with resale permission.");
          productId = upstream.productId;
          upstreamOfferId = upstream.id;
        } else {
          productId = this.deps.product(input.businessId, text(values.productId, "Product ID")).id;
          if (values.sourceId)
            sourceId = this.connectedSource(input, text(values.sourceId, "Source ID")).id;
        }
        const price = values.price;
        if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 1e12)
          return fail("Provide a valid selling price.");
        const currency = text(values.currency, "Currency", 3).toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) return fail("Use a three-letter currency code.");
        const validUntil = text(values.validUntil, "Price expiry");
        if (!Number.isFinite(Date.parse(validUntil)) || Date.parse(validUntil) <= now.getTime())
          return fail("Price expiry must be in the future.");
        record = {
          ...base,
          kind: "offer",
          productId,
          sourceId,
          upstreamOfferId,
          price,
          currency,
          validUntil: new Date(validUntil).toISOString(),
          priceUpdatedAt: at,
          status: "draft",
          availability: "unknown",
          availabilityEvidence: null,
          fulfillment: upstreamOfferId ? "upstream" : "seller",
          allowResell: false
        };
        break;
      }
      case "offer.update": {
        const r = this.owned(input, text(values.id, "Offer ID"));
        if (r.kind !== "offer") return fail("Select an offer.");
        const price = values.price;
        if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 1e12)
          return fail("Provide a valid selling price.");
        const expiry = text(values.validUntil, "Price expiry");
        if (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= now.getTime())
          return fail("Price expiry must be in the future.");
        record = {
          ...r,
          price,
          validUntil: new Date(expiry).toISOString(),
          priceUpdatedAt: at,
          updatedAt: at,
          status: "draft"
        };
        break;
      }
      case "offer.publish": {
        const r = this.owned(input, text(values.id, "Offer ID"));
        if (r.kind !== "offer" || values.confirmed !== true)
          return fail("Confirm publication explicitly.");
        if (Date.parse(r.validUntil) <= now.getTime())
          return fail("Refresh the expired price before publication.");
        if (values.allowResell !== undefined && typeof values.allowResell !== "boolean")
          return fail("Resale permission must be explicit.");
        record = {
          ...r,
          status: "published",
          allowResell: values.allowResell === true,
          updatedAt: at
        };
        // Check upstream/source before making the record publicly visible.
        this.records.set(record.id, record);
        if (!this.publicOffer(record.id, now)) {
          this.records.set(r.id, r);
          return fail("The upstream offer or source is no longer available.");
        }
        break;
      }
      case "offer.withdraw": {
        const r = this.owned(input, text(values.id, "Offer ID"));
        if (r.kind !== "offer") return fail("Select an offer.");
        record = { ...r, status: "withdrawn", updatedAt: at };
        break;
      }
      default:
        return fail("Unknown commerce operation.");
    }
    this.records.set(record.id, record);
    this.deps.audit(actor, record, operation);
    return structuredClone(record);
  }
}
