/**
 * Tenth slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns `products`, `productMedia`,
 * `productFieldSchemas`, `customers`, `invoices`, `payments`, `inventoryMovements`,
 * `publicOrders`, `publicCustomerCareRequests`, and the derived `nextInvoiceNumberByBusiness`
 * counter (never a `Cp2Snapshot` field, rebuilt from `invoices` on restore, same pattern as
 * `logisticsByInvoice` in the logistics domain). `publicStorefrontMessages` also lives here for
 * generic-sweep symmetry, but is dead weight - confirmed by exhaustive grep to have zero
 * business-logic reads or writes anywhere in the codebase; the real "public storefront message"
 * feature routes actually call is implemented entirely inside `MessagingDomain` as a computed view
 * over `conversationMessages`, under the same TypeScript type name by coincidence.
 * `scripts/purge-all-users.sql` independently labels the Postgres table "Legacy public message
 * records", confirming this was already known-stale before this extraction, not a fresh find.
 *
 * Named `sales` (directory `domains/sales/`) rather than `commerce` deliberately - `domains/commerce/`
 * already exists and owns the storefront/social-commerce surface (product capture jobs, status
 * broadcasts, buy orders, unified checkouts). This domain is the deeper transactional core those
 * features are built on top of: product catalog, customer records, invoicing, payments, and
 * inventory.
 *
 * This is the most heavily cross-coupled slice yet - three already-extracted domains hold raw,
 * sometimes-mutable references into these Maps, not read-only callbacks:
 * - `CommerceDomain` reads/writes `products`/`productMedia` directly (capture-job photo pipeline)
 *   and writes `invoices` directly (`createUnifiedCheckout`), in addition to the pre-existing
 *   `requireProduct`/`createProduct`/`updateProduct`/`buildStoredInvoice`/`nextInvoiceNumber`/
 *   `listPublicStorefronts` callbacks.
 * - `MessagingDomain` reads and writes `customers` directly (phone/email inbound-message matching),
 *   in addition to the pre-existing `requireCustomer`/`createGuestCustomer`/`requireInvoice`
 *   callbacks.
 * - `AgentRuntimeDomain` reads `products`/`customers`/`invoices` (read-only), in addition to the
 *   pre-existing `createProduct`/`deleteProduct`/`createCustomer`/`confirmProductImport`/
 *   `confirmSupplierImport` callbacks.
 * - `LogisticsDomain` calls the `requireInvoice` callback (pre-existing, unchanged in shape).
 * All four repoint at this domain's Map getters/public accessors with zero code change on their
 * own side, the same "kept working with zero code changes" trick used when `NetworkDomain` and
 * `AgentRuntimeDomain` were extracted - except here three of the four raw Map refs must stay
 * mutable, not read-only, since `CommerceDomain`/`MessagingDomain` write through them.
 *
 * Fifteen otherwise-private methods became deliberately public accessors here, mirroring every
 * prior domain's `getOrCreate*`/`*ForBusiness` pattern - most of them (`productsForBusiness`,
 * `customersForBusiness`, `invoicesForBusiness`, `paymentsForBusiness`,
 * `inventoryMovementsForBusiness`, `buildInvoicePaymentSummaries`, `buildInvoicePaymentSummary`,
 * `buildCustomerDebtSummaries`, `publicProductImage`) are called by the cross-cutting
 * readiness/report builders (`buildRuntimeContext`, `buildComplianceReport`,
 * `buildBetaReadinessReport`, `buildLaunchReadinessReport`, `buildBusinessReport`,
 * `buildBusinessKnowledge`, `buildOfflineCacheSnapshot`, `buildShopDeletionPreview`,
 * `publicStorefrontForBusiness`, `createDataExport`) that stayed on `Cp2Store` - same precedent
 * row 1 (Compliance) set: these builders reach into nearly every domain to compute readiness
 * gates, and moving them would just relocate the ambient coupling instead of removing it. The
 * other five (`requireProduct`, `requireCustomer`, `requireInvoice`, `createGuestCustomer`,
 * `buildStoredInvoice`, `nextInvoiceNumber`) are called from the constructor-injected deps of
 * `CommerceDomain`/`MessagingDomain`/`LogisticsDomain` listed above.
 *
 * **Two known pre-existing gaps, preserved as-is, not silently fixed:** `deleteShopOwnedData`
 * never sweeps `productMedia` (every other businessId-scoped Map in this cluster gets an explicit
 * loop there; `productMedia` does not, even though `product.primaryMediaId` references are
 * deleted along with `products` - a shop deletion leaves orphaned `productMedia` rows until the
 * next full account purge). And `nextInvoiceNumberByBusiness` is never cleared by
 * `deleteScopedMapRecords`/`deleteShopOwnedData`/`rebuildDerivedIndexesAfterAccountPurge` - low
 * severity since business IDs are UUIDs never reused, so this can never cause a duplicate invoice
 * number, but asymmetric with how `logisticsByInvoice`/`contactHashIdByValue`/
 * `notificationByRuleKey` are all explicitly rebuilt after purge. Both flagged here rather than
 * fixed as an incidental side effect of moving code.
 */
import type {
  ProductFieldDefinition,
  ProductFieldInputType,
  ProductMediaSummary
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { normalizeRequiredBoundedText } from "../../text-normalization.js";

export interface ProductMediaRecord extends ProductMediaSummary {
  contentBase64: string;
}

export function defaultProductFieldDefinitions(): ProductFieldDefinition[] {
  return [
    { id: "name", label: "Name", inputType: "text", required: true },
    { id: "sku", label: "SKU", inputType: "text", required: true },
    { id: "unit", label: "Unit", inputType: "select", required: true },
    { id: "quantity", label: "Quantity", inputType: "number", required: true },
    { id: "selling-price", label: "Selling Price", inputType: "number", required: true }
  ];
}

export function normalizeProductFieldDefinitions(
  fields: ProductFieldDefinition[]
): ProductFieldDefinition[] {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 50) {
    throw new Cp2Error(
      400,
      "product_fields_invalid",
      "A product field schema needs between 1 and 50 fields."
    );
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  const supportedTypes = new Set<ProductFieldInputType>([
    "text",
    "number",
    "select",
    "textarea",
    "yes_no"
  ]);

  return fields.map((field, index) => {
    const id = normalizeRequiredBoundedText(field.id, `field ${index + 1} id`, 80);
    const label = normalizeRequiredBoundedText(field.label, `field ${index + 1} label`, 80);
    const normalizedLabel = label.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/iu.test(id)) {
      throw new Cp2Error(
        400,
        "product_field_id_invalid",
        "Product field IDs may use letters, numbers, hyphens, and underscores."
      );
    }
    if (ids.has(id) || labels.has(normalizedLabel)) {
      throw new Cp2Error(
        400,
        "product_field_duplicate",
        "Product field IDs and labels must be unique."
      );
    }
    if (!supportedTypes.has(field.inputType)) {
      throw new Cp2Error(400, "product_field_type_invalid", "Product field type is not supported.");
    }
    ids.add(id);
    labels.add(normalizedLabel);
    return {
      id,
      label,
      inputType: field.inputType,
      required: field.required === true
    };
  });
}
