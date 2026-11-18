# System shop: Jane's Shop

Jane's Shop is the marketplace's built-in demo shop. It is pinned to the top of the marketplace,
carries every product in the bundled marketplace catalogue (`kenyan-commerce-v1`, 713 products),
lets any shop copy that catalogue, and is run end to end by the **Grogoni Marketplace Agent**
with no human owner or staff.

| What                                              | Where                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Deterministic IDs, plan, demo prices, policies    | `catalogue.ts`                                                                                            |
| Provisioning, order completion, restocking, caps  | `store.ts` (`SystemShopDomain`)                                                                           |
| The agent's profile and business policy           | `agent-profile.ts`                                                                                        |
| Deployment switch and log line                    | `provisioning.ts`                                                                                         |
| Edge provisioning, plan rows for the assistant    | `services/api/src/edge-domain-routes.ts` (`ensureSystemShop`, `systemShopPlanRecordsFor`)                 |
| Production shop list (pinning)                    | `supabase/functions/api/public-routes.ts`                                                                 |
| Gate tests                                        | `tests/system-shop.test.ts`, `tests/system-shop-web.test.tsx`, `tests/system-shop-edge-assistant.test.ts` |
| PostgreSQL lanes                                  | `tests/system-shop-postgres.test.ts`, `tests/system-shop-edge-postgres.test.ts`                           |
| Paid eval (customer replies, Luna via OpenRouter) | `pnpm eval:system-shop`                                                                                   |

The PostgreSQL lanes need `CP2_POSTGRES_TEST_DATABASE_URL`. Run them one file at a time
(`node scripts/run-postgres-tests.mjs`), because they share one database.

## Identity

| Record           | Value                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Business         | `systemShopEntityId("business")`, name `Jane's Shop`, Grogoni ID `grogoni.janes-shop` (`janes-shop@grogoni.com`) |
| Operator account | `marketplace-agent@system.grogoni.invalid`, status `suspended`                                                   |
| Operator user    | `Grogoni Marketplace Agent`, owner membership of the shop                                                        |

Every ID is a version-5-shaped UUID from SHA-256 of a fixed namespace, so every runtime and every
concurrent first provisioning produces identical rows. The handle `janes-shop` is reserved. A
merchant who names their own shop "Jane's Shop" gets `grogoni.janes-shop-2`, which is not
pinned and carries no demo label.

Nobody can sign in as the operator. The address uses the RFC 2606 `.invalid` domain, which cannot
receive OTP or recovery mail. Every sign-in path refuses a `suspended` account
(`requireAccountAuthenticationAllowed`; on Edge, the `status = 'active'` checks). The only owner
is the operator, so no human can change the shop's presence, catalogue or agent.

## What the Marketplace Agent does

Its operational work is deterministic code, not model output:

- **Orders.** A marketplace checkout (`CommerceDomain.createUnifiedCheckout`, which is also the
  path for the `commerce.checkout` capability, MCP checkout and the buyer assistant) or a
  storefront visitor's order (`createPublicOrder`) is confirmed in the same request. The invoice
  is confirmed as the operator, stock goes down, and the order becomes `completed`. The buyer's
  checkout response already shows `completed`. If confirmation fails, the order becomes
  `rejected` with an audit event, so no order waits on a human who does not exist. If the
  invoice did confirm and only a later hook threw, the sale stands and the order completes.
- **Restocking.** After a sale, any planned product at or below 10 units is restocked to 100 with
  a `manual_adjustment` movement attributed to the operator.
- **Customer chat.** Visitors chat through the normal storefront agent reply path, which gets no
  tools. The profile tells the agent it runs the shop, that prices are demo prices, and that no
  money changes hands. This is the one model-driven part, and `pnpm eval:system-shop` measures it.

The shop's business policy is fully open: no owner approvals, no restricted actions, and every
skill enabled with confirmation `none`. Platform-level safety still applies, because it is not
business policy:

- customer audiences get no tools;
- non-members cannot run the shop's owner agent (tested);
- tools that always require confirmation still require it.

## Prices and copying

The source workbook has no retail prices, so Jane's Shop sells at **demo prices**. They are in KES,
in 5-shilling steps, picked by hash within a per-department band (`systemShopDemoPriceKes`).
Demo prices never leave the shop:

- The shared-catalogue view of Jane's Shop shows no prices.
- Copying from Jane's Shop goes through the seed import path. Copies have no price and zero stock.
  They are linked to the marketplace catalogue, so copying again (or importing the starter
  dataset) reuses them instead of duplicating.
- The web panel's **Copy whole catalogue** button sends batches of 50, the server's per-request
  limit. A failed batch can be retried safely.

## The plan invariant

`systemShopProductPlan()` derives every product's ID, name, SKU and demo price from the bundled
seed catalogue. For everything a storefront shows, the plan is exact:

- No human can edit the shop.
- Each provisioning brings every planned product's name, demo price and dataset version back in
  line with the current plan, and restocks any planned product at or below 10. That can happen
  after an older plan's isolate ran during a rollout, or when the seed drops a product and later
  re-adds it. Products the seed dropped go to zero stock and are never restocked.
- Every planned product is always in stock: a sale that leaves it at or below 10 restocks it in
  the same transaction, so it never drops below 11 between orders.

This is what lets scoped Edge requests show the shop without loading it.

## Provisioning

`Cp2Store.provisionSystemShop()` is idempotent. It creates whatever is missing (operator, shop,
presence, agent profile, catalogue products) and applies the plan sync above.

It runs explicitly, never inside `hydrateSnapshot`, because an Edge request hydrates a **scoped**
snapshot and cannot tell "absent" from "not loaded".

**Node** (`services/api/src/index.ts`) runs it once at boot, against the full snapshot.

**Edge** runs it through `ensureSystemShop()` on the domain runtime, at most once per isolate:

- **Readiness check.** One indexed, read-only query checks for:
  - the owner membership;
  - an online, shareable presence;
  - the agent profile;
  - every product at the current dataset version.
- **Provisioning.** Only when something is missing does a dedicated worker transaction
  (`POST /internal/system-shop/provision`, never reachable as a route) load the shop by itself
  and provision it.
  - It holds the shop's tenant advisory lock. The lock is keyed by a literal ID, so it is taken
    even before the row exists. Concurrent isolates therefore serialize, and the second sees the
    first's rows (`tests/system-shop-edge-postgres.test.ts`).
  - It also loads every shop and rename cooldown that holds `grogoni.janes-shop`, so it never
    takes an ID someone else holds.
- **Failures.** A failed attempt backs off exponentially, from 30 s up to 15 min. The work runs
  under `waitUntil`, so it survives the response.
- **Who triggers it.**
  - The shop list triggers it in the background on a cold isolate and never waits on domain
    startup. Once the shop exists, the SQL list shows it anyway.
  - Shared-catalogue routes wait for it for at most 1.5 s.
  - Buyer routes (`/buy/search`, `/buy/assistant`) only run the read-only check (rechecked at
    most once a minute until it passes), so a buyer request never writes on the shop's behalf.
- **Result.** Once an isolate has seen a complete shop, each request's store gets
  `systemShopProvisioned: true`.

Buyer search, the shop list and shared-catalogue pages never load Jane's Shop's rows, so they
neither take her tenant lock nor hydrate her order history. `tests/system-shop-postgres.test.ts`
asserts this for `/buy/search` and `/public/storefronts`. A buyer-assistant turn with a Jane's
Shop draft pending does load her, without a lock, like any shop in a pending checkout. That load
is bounded by the retention below.

| Surface                                    | How it reaches Jane's Shop                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Shop list `GET /public/storefronts` (Edge) | Raw SQL, `order by (id = Jane) desc`, adds `pinned` / `operatedBy`                                                           |
| Shop list (Node)                           | `Cp2Store.listPublicStorefronts`, pinned sort                                                                                |
| Buyer search                               | Plan storefront (`systemShopPlanStorefront`); the search scope excludes Jane's rows                                          |
| Buyer assistant (Edge)                     | Plan rows at the guaranteed minimum stock (11) for quoting, stripped before saving; confirming the order loads the real shop |
| Shared catalogues                          | Seed plan; listing and copying need no shop rows, and return 404 until the shop is provisioned                               |
| Checkout, storefront chat and orders       | By agent ID / Grogoni ID, like any shop                                                                                      |

If another shop already holds `grogoni.janes-shop`, provisioning writes nothing, returns
`{ status: "blocked" }` and logs `system_shop.provision_blocked`. If installing the agent profile
fails, the shop opens on the default profile, the failure is logged as
`system_shop.agent_profile_failed`, and the readiness check makes the next isolate retry. An
Edge failure is logged as `system_shop.provision_failed`.

Set `GROGONI_SYSTEM_SHOP=off` to disable provisioning for a deployment. The shop's records are not
removed.

## Traces

- Audit events:
  - `system_shop.provisioned` / `system_shop.updated`: products created and synced, and the
    dataset version;
  - `system_shop.order_completed`: restocked product IDs;
  - `system_shop.order_rejected`: reason code.
- Each runtime logs one JSON line, `event: "system_shop.provision"`, when provisioning changes
  anything.

## Limits

- **Order caps.** These bound how fast the shop's history can grow, whoever is ordering. A
  storefront visitor ID is chosen by the client, so only the shop-wide cap actually bounds growth.
  - Per buyer account and per storefront visitor: 20 demo orders per rolling 24 hours.
  - Whole shop: 300 demo orders per rolling 24 hours, from everyone.
  - At most 10 lines per order.
  - A checkout over a cap reports a per-item failure. A storefront order over a cap gets
    `429 order_limit_reached`.
- **Retention.** Settled demo orders older than 25 hours are deleted, together with their
  invoices, items, stock movements and offline-journal entries. Shop audit events older than the
  same window are pruned as well. Only the latest offline change per
  product is kept, since the shop has no devices. Deletion goes through the ordinary persistence
  diff (`tests/system-shop-postgres.test.ts` checks the database rows).
  - It runs after each of the shop's orders and in provisioning, up to 1,000 records of each kind
    per pass. A `system_shop.history_pruned` audit event records each pass.
  - Retention is processed in batches on activity, so an existing backlog can take multiple passes
    to clear. Buyers' own checkout records keep the final order status; visitor identities and
    sessions are retained separately.
  - If the shop takes no order for 25 hours, invoice numbering starts again at `INV-00001`. The
    old rows are gone, so numbers never collide.
- **Shop-wide cap.** Anyone who fills the shop-wide cap closes demo ordering for the rest of that
  24-hour window. That is the trade-off for bounding growth.
- **Assistant quotes.** On Edge, the buyer assistant quotes from the plan at the guaranteed stock of
  11 units. Asking it for more than 11 of one product is refused, even though the real shop
  usually holds up to 100. The storefront and direct checkout use real stock.
- **Edge MCP checkout.** On Edge, MCP checkout loads only shops named at the top level of the
  request, as it does for every shop.
