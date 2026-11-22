/**
 * System shop domain: provisions Jane's Shop and runs it as the Grogoni Marketplace Agent with no
 * human in the loop.
 *
 * The agent's operational work is deterministic code, not model output: accepting and completing
 * an order, confirming its invoice and restocking are same-input-same-output decisions, so they
 * run here synchronously in the request that created the order. Customer conversation (the only
 * judgment-heavy part) stays with the shop's existing storefront agent reply path.
 *
 * Every write goes through the same trusted entry points the rest of the API uses
 * (`SalesDomain.confirmInvoiceForTrustedActor`, `restockProductForTrustedActor`, ...), attributed
 * to the operator's real user row so inventory movements satisfy `inventory_movements.actor_id`.
 */
import type {
  AccountSummary,
  BusinessSummary,
  BuyOrderSummary,
  MembershipSummary,
  ProductSummary,
  PublicOrderSummary,
  ShopPresenceSummary,
  UserSummary
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { seedCatalogue } from "../catalogue-sharing/seed-catalogue.js";
import {
  isSystemShopBusinessId,
  systemShop,
  systemShopPlannedProductFields,
  systemShopProductPlan,
  systemShopStockPolicy
} from "./catalogue.js";

export interface SystemShopDomainDeps {
  businesses: Map<string, BusinessSummary>;
  products: Map<string, ProductSummary>;
  productsForBusiness: (businessId: string) => ProductSummary[];
  /** True when any shop other than the system shop already holds this Grogoni ID. */
  grogoniIdTakenByAnotherShop: (grogoniId: string) => boolean;
  installOperator: (input: {
    account: AccountSummary;
    user: UserSummary;
    membership: MembershipSummary;
  }) => void;
  storedShopPresence: (businessId: string) => ShopPresenceSummary | undefined;
  setShopPresence: (presence: ShopPresenceSummary) => void;
  hasAgentProfile: (businessId: string) => boolean;
  installAgentProfile: (input: { businessId: string; actorId: string; now: Date }) => void;
  confirmInvoice: (input: {
    businessId: string;
    invoiceId: string;
    actorId: string;
    now: Date;
  }) => void;
  invoiceStatus: (invoiceId: string) => string | undefined;
  /** Recent system-shop orders by one buyer, one visitor, or (neither given) everyone. */
  countRecentOrders: (input: {
    buyerAccountId?: string;
    visitorId?: string;
    since: Date;
  }) => number;
  restockProduct: (input: {
    businessId: string;
    productId: string;
    quantity: number;
    actorId: string;
    reason: string;
    now: Date;
  }) => void;
  setBuyOrder: (order: BuyOrderSummary) => void;
  /**
   * Deletes the system shop's completed demo history older than `before`: invoices, buy and
   * storefront orders, stock movements, and offline journal entries for them. Returns how many
   * records went.
   */
  pruneHistory: (input: { before: Date; limit: number }) => number;
  setPublicOrderStatus: (input: {
    orderId: string;
    status: PublicOrderSummary["status"];
    now: Date;
  }) => PublicOrderSummary;
  recordAuditEvent: (input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
}

export type SystemShopProvisionReport =
  | {
      status: "provisioned" | "updated" | "unchanged";
      businessId: string;
      grogoniId: string;
      productsCreated: number;
      productCount: number;
    }
  | { status: "blocked"; reason: "grogoni_id_taken"; grogoniId: string };

export type SystemShopOrderOutcome =
  | { orderId: string; status: "completed"; restockedProductIds: string[] }
  | { orderId: string; status: "rejected"; reason: string };

export class SystemShopDomain {
  constructor(private readonly deps: SystemShopDomainDeps) {}

  /**
   * Idempotent. Creates the operator, the shop, its presence, its agent profile and any catalogue
   * product it does not have yet. Synchronizes planned names and demo prices, and replenishes
   * stock at or below the restock threshold; ordinary repeat runs preserve other stock levels.
   */
  provision(now: Date = new Date()): SystemShopProvisionReport {
    const exists = this.deps.businesses.has(systemShop.businessId);
    if (!exists && this.deps.grogoniIdTakenByAnotherShop(systemShop.grogoniId)) {
      console.error(
        JSON.stringify({
          event: "system_shop.provision_blocked",
          reason: "grogoni_id_taken",
          grogoniId: systemShop.grogoniId
        })
      );
      return { status: "blocked", reason: "grogoni_id_taken", grogoniId: systemShop.grogoniId };
    }
    const at = now.toISOString();
    let changed = false;
    if (!exists) {
      this.deps.installOperator({
        account: {
          id: systemShop.accountId,
          primaryAuthChannel: "email",
          primaryAuthDestination: systemShop.operatorDestination,
          identityLevel: "device",
          status: "suspended",
          deletedAt: null
        },
        user: {
          id: systemShop.userId,
          accountId: systemShop.accountId,
          displayName: systemShop.operatorDisplayName,
          language: systemShop.language,
          contactDiscoveryEnabled: false
        },
        membership: {
          id: systemShop.membershipId,
          businessId: systemShop.businessId,
          userId: systemShop.userId,
          role: "owner"
        }
      });
      this.deps.businesses.set(systemShop.businessId, {
        id: systemShop.businessId,
        name: systemShop.name,
        language: systemShop.language,
        grogoniId: systemShop.grogoniId
      });
      changed = true;
    }

    const presence = this.deps.storedShopPresence(systemShop.businessId);
    if (
      presence?.status !== "online" ||
      presence.catalogueShareable !== true ||
      presence.category !== systemShop.directoryCategory
    ) {
      this.deps.setShopPresence({
        ...presence,
        businessId: systemShop.businessId,
        status: "online",
        catalogueShareable: true,
        category: systemShop.directoryCategory,
        updatedBy: systemShop.userId,
        updatedAt: at
      });
      changed = true;
    }

    if (!this.deps.hasAgentProfile(systemShop.businessId)) {
      try {
        this.deps.installAgentProfile({
          businessId: systemShop.businessId,
          actorId: systemShop.userId,
          now
        });
        changed = true;
      } catch (error) {
        // The shop still opens on the default agent profile; the next provisioning retries.
        console.error(
          JSON.stringify({
            event: "system_shop.agent_profile_failed",
            code: error instanceof Cp2Error ? error.code : "unknown",
            message: error instanceof Error ? error.message : String(error)
          })
        );
      }
    }

    // Jane's catalogue is the plan: no human can edit it, so provisioning keeps every planned
    // product's name, demo price and dataset version equal to the current seed plan (the plan
    // storefront that scoped Edge stores show depends on it), and takes products the seed dropped
    // off sale. Stock is never touched for planned products.
    const plan = systemShopProductPlan();
    const plannedIds = new Set(plan.map((planned) => planned.id));
    let productsCreated = 0;
    let productsSynced = 0;
    for (const planned of plan) {
      const fields = systemShopPlannedProductFields(planned);
      const existing = this.deps.products.get(planned.id);
      if (existing === undefined) {
        this.deps.products.set(planned.id, {
          id: planned.id,
          businessId: systemShop.businessId,
          ...fields,
          aliases: [],
          primaryMediaId: null,
          quantity: systemShopStockPolicy.targetQuantity,
          buyingPrice: null,
          unitWeightGrams: null,
          fieldValues: {},
          createdAt: at,
          updatedAt: at
        });
        productsCreated += 1;
        continue;
      }
      if (
        existing.name !== fields.name ||
        existing.sku !== fields.sku ||
        existing.unit !== fields.unit ||
        existing.sellingPrice !== fields.sellingPrice ||
        existing.catalogueSource?.datasetVersion !== fields.catalogueSource.datasetVersion ||
        existing.catalogueSource?.sourceProductId !== fields.catalogueSource.sourceProductId
      ) {
        this.deps.products.set(planned.id, { ...existing, ...fields, updatedAt: at });
        this.deps.recordAuditEvent({
          type: "system_shop.product_synced",
          aggregateType: "product",
          aggregateId: planned.id,
          actorId: systemShop.userId,
          occurredAt: at,
          payload: {
            businessId: systemShop.businessId,
            previousPrice: existing.sellingPrice,
            sellingPrice: fields.sellingPrice
          }
        });
        productsSynced += 1;
      }
    }
    // A planned product can only reach zero through a sync (an older plan's isolate during a
    // rollout, or a seed that dropped and re-added it); a sale always restocks. Restock any
    // planned product at or below the threshold so "always in stock" holds again.
    const restocked = this.restock(
      [...plannedIds].filter((id) => {
        const product = this.deps.products.get(id);
        return product !== undefined && product.quantity <= systemShopStockPolicy.restockThreshold;
      }),
      now
    );
    productsSynced += restocked.length;
    for (const product of this.deps.productsForBusiness(systemShop.businessId)) {
      if (plannedIds.has(product.id) || product.quantity === 0) continue;
      // Through the stock entry point, so the movement history stays a complete chain.
      this.deps.restockProduct({
        businessId: systemShop.businessId,
        productId: product.id,
        quantity: 0,
        actorId: systemShop.userId,
        reason: "Removed from the marketplace catalogue",
        now
      });
      productsSynced += 1;
    }
    changed ||= productsCreated > 0 || productsSynced > 0;

    if (exists) this.pruneHistory(now);
    const productCount = this.deps.productsForBusiness(systemShop.businessId).length;
    const status = !exists ? "provisioned" : changed ? "updated" : "unchanged";
    if (changed) {
      this.deps.recordAuditEvent({
        type: `system_shop.${status}`,
        aggregateType: "business",
        aggregateId: systemShop.businessId,
        actorId: systemShop.userId,
        occurredAt: at,
        payload: {
          grogoniId: systemShop.grogoniId,
          datasetId: seedCatalogue.id,
          datasetVersion: seedCatalogue.version,
          productsCreated,
          productsSynced,
          productCount
        }
      });
    }
    return {
      status,
      businessId: systemShop.businessId,
      grogoniId: systemShop.grogoniId,
      productsCreated,
      productCount
    };
  }

  /**
   * Why a new order for the system shop must be refused, or null. Only the daily per-buyer cap
   * (systemShopStockPolicy.dailyOrdersPerBuyer); ordinary shops are never refused here.
   */
  orderRefusal(input: {
    businessId: string;
    buyerAccountId?: string;
    visitorId?: string;
    /** Distinct order lines requested from the system shop. */
    lines: number;
    now: Date;
  }): string | null {
    if (!isSystemShopBusinessId(input.businessId)) return null;
    if (input.lines > systemShopStockPolicy.maximumOrderLines)
      return `Jane's Shop takes up to ${systemShopStockPolicy.maximumOrderLines} products per demo order.`;
    const since = new Date(input.now.getTime() - 24 * 60 * 60 * 1000);
    const count = this.deps.countRecentOrders({
      ...(input.buyerAccountId === undefined ? {} : { buyerAccountId: input.buyerAccountId }),
      ...(input.visitorId === undefined ? {} : { visitorId: input.visitorId }),
      since
    });
    if (count >= systemShopStockPolicy.dailyOrdersPerBuyer)
      return `Jane's Shop takes up to ${systemShopStockPolicy.dailyOrdersPerBuyer} demo orders per buyer each day. Try again tomorrow.`;
    if (this.deps.countRecentOrders({ since }) >= systemShopStockPolicy.dailyOrdersShopWide)
      return "Jane's Shop has taken all its demo orders for today. Try again tomorrow.";
    return null;
  }

  /** Accepts, fulfils and completes every newly requested marketplace order for the system shop. */
  completeBuyOrders(orders: BuyOrderSummary[], now: Date): SystemShopOrderOutcome[] {
    const outcomes = orders
      .filter((order) => isSystemShopBusinessId(order.businessId) && order.status === "requested")
      .map((order) => {
        const outcome = this.fulfil(order.id, order.businessId, order.invoiceId, order.items, now);
        this.deps.setBuyOrder({
          ...order,
          status: outcome.status,
          updatedAt: now.toISOString()
        });
        return outcome;
      });
    if (outcomes.length > 0) this.pruneHistory(now);
    return outcomes;
  }

  /** The same for an order a storefront visitor placed in Jane's Shop's public chat. */
  completePublicOrder(order: PublicOrderSummary, now: Date): SystemShopOrderOutcome | null {
    if (!isSystemShopBusinessId(order.businessId) || order.status !== "requested") return null;
    const outcome = this.fulfil(order.id, order.businessId, order.invoiceId, order.items, now);
    this.deps.setPublicOrderStatus({ orderId: order.id, status: outcome.status, now });
    this.pruneHistory(now);
    return outcome;
  }

  /**
   * Retention for the demo shop's order history (systemShopStockPolicy.historyRetentionMs). Runs
   * where the shop is fully loaded: after each of its orders, and in provisioning.
   */
  pruneHistory(now: Date): number {
    const pruned = this.deps.pruneHistory({
      before: new Date(now.getTime() - systemShopStockPolicy.historyRetentionMs),
      limit: systemShopStockPolicy.historyPruneBatch
    });
    if (pruned > 0)
      this.deps.recordAuditEvent({
        type: "system_shop.history_pruned",
        aggregateType: "business",
        aggregateId: systemShop.businessId,
        actorId: systemShop.userId,
        occurredAt: now.toISOString(),
        payload: { records: pruned }
      });
    return pruned;
  }

  private fulfil(
    orderId: string,
    businessId: string,
    invoiceId: string,
    items: Array<{ productId: string }>,
    now: Date
  ): SystemShopOrderOutcome {
    const at = now.toISOString();
    try {
      this.deps.confirmInvoice({ businessId, invoiceId, actorId: systemShop.userId, now });
    } catch (error) {
      // confirmInvoice commits the sale (invoice confirmed, stock decremented) before its
      // event/notification hooks run. If one of those threw, the sale stands: complete the order
      // so it never says "rejected" for goods that were sold.
      if (this.deps.invoiceStatus(invoiceId) === "confirmed") {
        console.error(
          JSON.stringify({
            event: "system_shop.post_confirmation_hook_failed",
            orderId,
            message: error instanceof Error ? error.message : String(error)
          })
        );
        return this.completed(orderId, businessId, invoiceId, items, now);
      }
      // Checkout validated stock in this same request, so this is a lost race or a corrupt
      // record. Reject visibly instead of leaving the buyer waiting on an order nobody will see.
      const reason = error instanceof Cp2Error ? error.code : "invoice_confirmation_failed";
      this.deps.recordAuditEvent({
        type: "system_shop.order_rejected",
        aggregateType: "order",
        aggregateId: orderId,
        actorId: systemShop.userId,
        occurredAt: at,
        payload: { businessId, invoiceId, reason }
      });
      return { orderId, status: "rejected", reason };
    }
    return this.completed(orderId, businessId, invoiceId, items, now);
  }

  private completed(
    orderId: string,
    businessId: string,
    invoiceId: string,
    items: Array<{ productId: string }>,
    now: Date
  ): SystemShopOrderOutcome {
    const at = now.toISOString();
    const restockedProductIds = this.restock(
      [...new Set(items.map((item) => item.productId))],
      now
    );
    this.deps.recordAuditEvent({
      type: "system_shop.order_completed",
      aggregateType: "order",
      aggregateId: orderId,
      actorId: systemShop.userId,
      occurredAt: at,
      payload: { businessId, invoiceId, itemCount: items.length, restockedProductIds }
    });
    return { orderId, status: "completed", restockedProductIds };
  }

  private restock(productIds: string[], now: Date): string[] {
    const restocked: string[] = [];
    for (const productId of productIds) {
      const product = this.deps.products.get(productId);
      if (product === undefined || !isSystemShopBusinessId(product.businessId)) continue;
      if (product.quantity > systemShopStockPolicy.restockThreshold) continue;
      // A product the seed dropped stays off sale.
      if (!systemShopProductPlan().some((planned) => planned.id === productId)) continue;
      this.deps.restockProduct({
        businessId: product.businessId,
        productId,
        quantity: systemShopStockPolicy.targetQuantity,
        actorId: systemShop.userId,
        reason: "Marketplace Agent automatic restock",
        now
      });
      restocked.push(productId);
    }
    return restocked;
  }
}
