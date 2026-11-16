# Global starter catalogue access

The existing catalogue tools now expose the Kenyan Commerce Seed Catalog (713 products) alongside shops that opted into catalogue sharing. The global source does not belong to an account and does not require a seeded shop or database migration.

## Agent flow

1. Call `catalogue.marketplace.search` with `{"search":"kenyan"}` (or a product name).
2. Use the returned source identifier `dataset:kenyan-commerce-v1` with `catalogue.marketplace.products`. Optional `search` filters product name/category/department; `offset` and `limit` page results. Agent reads default to 50 items, with a maximum of 100 per call.
3. Present real selections and obtain the owner's existing import confirmation.
4. Call `catalogue.marketplace.import` with that source identifier and 1–50 product IDs returned by the product tool.

The source identifier uses the existing `sourceBusinessId` argument for compatibility. It is a dataset identifier, not a real shop ID. The browse UI labels this source as a starter dataset.

Imported products start with zero stock, unknown buying and selling prices, and generic `unit` units. The owner must review the sellable unit, enter actual stock, and set current prices. Historical workbook costs are deliberately not treated as store prices.

Each product stores `catalogueSource` with dataset ID, dataset version, and source product ID. Repeating an import into the same store reuses that product without overwriting merchant edits, stock, or prices, including after snapshot restoration. The import audit event records the source workbook checksum and source-to-created-product mapping. All requested IDs and drafts are checked before writes; existing store permissions and agent confirmation policy still apply.

## HTTP access

Existing authenticated routes serve the same source:

- `GET /businesses/:businessId/catalogue-marketplace/shops?search=kenyan`
- `GET /businesses/:businessId/catalogue-marketplace/shops/dataset%3Akenyan-commerce-v1/products?search=tea&offset=0&limit=50`
- `POST /businesses/:businessId/catalogue-marketplace/shops/dataset%3Akenyan-commerce-v1/duplicate` with `{"productIds":["<returned-product-id>"]}`

## Packaging and validation

`data/kenyan-commerce/v1/catalog.json` remains the authoritative release. Run `node scripts/build-seed-catalogue.mjs` after an intentional dataset update. It generates a compact server-only JSON projection, statically bundled for Supabase Edge and copied with the Node build. Both builds check that this projection is current. Do not mutate v1 in response to individual shop activity; use the dataset's existing reviewed-release policy.

Checks: canonical release integrity; global discovery/search/paging; authenticated HTTP import; cross-tenant rejection; batch validation before writes; provenance persistence; retry protection without overwriting merchant edits; and the full agent search → read → confirmation → import flow. Existing shared-shop and browse UI tests remain covered.

These changes are local source changes until the API and frontend builds are deployed. No production database content is changed by this implementation.

Validation result: 17 catalogue/API/agent/UI tests passed. API and frontend type checks, targeted ESLint, Node build, Supabase Edge build, module-boundary checks, relative ESM import checks, and generated-dataset integrity checks passed. Both server build artifacts contain all 713 products.
