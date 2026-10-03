# Contact and commercial history

> Current values may change. Historical transactions do not.

Grogoni's contact and commercial-history capabilities extend the existing CP2 domain store, Fastify
API, runtime-tool registry, audit stream, and normalized PostgreSQL snapshot transaction. They do
not introduce another runtime or frontend-owned business logic.

## Existing architecture reused

- The network domain remains the owner of permissioned phone/social graph sync and provider
  adapters such as Google Contacts. Native address-book selection stays client initiated.
- Canonical business contacts are tenant-scoped projections for supplier/customer use. Imports
  deduplicate by provider source ID, normalized phone, or normalized email.
- Existing suppliers, products, customers, confirmed invoices, purchase receipts, inventory
  movements, logistics, authorization, audit events, chat runtime, and MCP runtime-turn gateway are
  reused.
- Confirmed invoices already snapshot customer names, product names, quantities, and selling
  prices and cannot be edited. `saleRecords` adds contact and route context to that immutable sale.
- Purchase receipts already snapshot supplier and sales-agent names. `purchaseRecords` adds
  canonical product/contact/location/route references for structured purchases.
- **Supplier sales agents are not a second store.** The supplier domain already owns a tested
  `SalesAgentSummary` CRUD and the OCR receipt-agent matching engine that depends on it
  (`services/api/src/cp2/domains/suppliers/store.ts`). `attachSupplierContact`/
  `detachSupplierContact`/`listSupplierContacts` delegate the `SALES_AGENT` role to that existing
  code instead of writing a second, disconnected "who is this supplier's agent" record - a sales
  agent attached through the new role-based API is the exact same sales agent the OCR receipt flow
  matches against. Every other role (`OWNER`, `DELIVERY_AGENT`, `DRIVER`, `ACCOUNT_MANAGER`,
  `OTHER`) is genuinely new and has its own store, since the supplier domain never modeled them.

## Relationships

```text
Contact -> Supplier/Customer -> Purchase/Sale -> Delivery route -> Location
Product -> current buying-price cache -> append-only purchase-price history
```

Supplier contacts have an explicit role (`OWNER`, `SALES_AGENT`, `DELIVERY_AGENT`, `DRIVER`,
`ACCOUNT_MANAGER`, or `OTHER`) and a validity window. Detaching or replacing an agent closes the
relationship; it does not delete it or reassign a historical purchase. For `SALES_AGENT`, "closes
the relationship" means calling the supplier domain's existing `deleteSalesAgent`; for every other
role it means setting `validTo` on the native `cp2_supplier_contact_relationships` row.

## Buying-price invariant

`product.buyingPrice` remains temporarily as a compatibility/read cache. A price change closes the
current effective history record, inserts a successor with `supersedesId`, then updates that cache
in the same store mutation. Historical reports only use `purchasePriceHistory`. Migration 078
backfills existing cached values with `source = LEGACY_BACKFILL`.

Purchases automatically append a price record with immutable product, supplier, and contact-name
snapshots. UI history is collapsed for presentation only; database rows stay individually
queryable.

## Routes and maps

Delivery routes and locations are provider-neutral. `provider = manual` requires no credential and
supports labels, addresses, regions, and coordinates. `GeoProvider` defines optional geocoding,
reverse-geocoding, normalization, and route-calculation adapters; core records never require
Google Maps.

## API and tools

Business-scoped HTTP contracts cover contacts import/search/linking, supplier contact roles,
purchase recording and price history, completed sales history, and delivery-route history. The
same operations are registered in the existing runtime tool registry (`contacts.search`,
`supplier.contact.attach`, `purchase.record`, `purchase.price.change`, `purchase.history`,
`sale.record`, `sales.history`, `route.record`, and `route.history`) and therefore flow through the
existing chat/MCP runtime confirmation and authorization pipeline.

External imports accept stable `externalSourceId` values so harmless purchase, sale, and route
retries return the original record. Audit metadata deliberately contains IDs and commercial
totals, not phone numbers, emails, provider tokens, or raw address books.
