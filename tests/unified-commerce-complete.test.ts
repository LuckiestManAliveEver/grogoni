import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { createPostgresCp2Store } from "../services/api/src/cp2/postgres-store";
import type {
  CommerceOffer,
  CommerceRepresentation,
  CommerceSource,
  CommerceSourceCandidate,
  InvoiceSummary,
  UnifiedCheckoutSummary
} from "@grogoni/shared-types";

for (const postgres of [false, true])
  describe(`commerce participation journey (${postgres ? "PostgreSQL" : "memory"})`, () => {
    it.skipIf(postgres && !process.env.CP2_POSTGRES_TEST_DATABASE_URL)(
      "imports an agent sheet, verifies representation, connects retailers and fulfills a source-linked order once",
      async () => {
        const persistent = postgres
          ? await createPostgresCp2Store({
              databaseUrl: process.env.CP2_POSTGRES_TEST_DATABASE_URL!
            })
          : null;
        const store = persistent ?? createCp2Store();
        const app = buildApi({ cp2: { store } });
        try {
          const wholesaler = await owner("Wholesaler"),
            agent = await owner("Agent"),
            retailer = await owner("Retailer"),
            customer = await owner("Customer");
          const grant = await op<CommerceRepresentation>(agent, "representation.request", {
            principalBusinessId: wholesaler.id,
            territory: "Nairobi"
          });
          await op(wholesaler, "representation.decide", {
            id: grant.id,
            status: "authorized",
            confirmed: true
          });
          const forged = await app.inject({
            method: "POST",
            url: `/businesses/${agent.id}/commerce-sources/operations`,
            headers: { cookie: agent.cookie },
            payload: {
              operation: "representation.decide",
              values: { id: grant.id, status: "authorized", confirmed: true }
            }
          });
          expect(forged.statusCode).toBe(404);
          const source = await op<CommerceSource>(agent, "source.connect", {
            type: "SALES_AGENT",
            label: "Approved wholesale sheet",
            reference: `sheet:${randomUUID()}`
          });
          await op(agent, "source.representation", { id: source.id, representationId: grant.id });
          const feed = {
            products: [
              {
                externalId: "RICE-10",
                name: "Rice 10kg",
                unit: "bag",
                identity: { barcode: "1234567890000", packaging: "10kg", unit: "bag" },
                price: 180,
                currency: "KES",
                validUntil: "2099-01-01T00:00:00Z",
                availability: "unknown"
              }
            ]
          };
          const candidates = await op<CommerceSourceCandidate[]>(agent, "source.import", {
            sourceId: source.id,
            feed
          });
          const again = await op<CommerceSourceCandidate[]>(agent, "source.import", {
            sourceId: source.id,
            feed
          });
          expect(again[0]?.id).toBe(candidates[0]?.id);
          const confirmed = await op<CommerceSourceCandidate>(agent, "candidate.confirm", {
            id: candidates[0]!.id,
            confirmed: true
          });
          expect(
            (
              await op<CommerceSourceCandidate>(agent, "candidate.confirm", {
                id: confirmed.id,
                confirmed: true
              })
            ).confirmedProductId
          ).toBe(confirmed.confirmedProductId);
          expect(
            store.snapshot().products.find((p) => p.id === confirmed.confirmedProductId)?.quantity
          ).toBe(0);
          await op(agent, "offer.publish", {
            id: confirmed.offerId,
            confirmed: true,
            allowResell: true
          });
          const connection = await op<{ id: string }>(agent, "relationship.request", {
            targetBusinessId: retailer.id
          });
          await op(retailer, "relationship.respond", { id: connection.id, accept: true });
          const resale = await op<CommerceOffer>(retailer, "offer.create", {
            upstreamOfferId: confirmed.offerId,
            price: 220,
            currency: "KES",
            validUntil: "2099-01-01T00:00:00Z"
          });
          await op(retailer, "offer.publish", { id: resale.id, confirmed: true });
          const item = {
            sourceKind: "offer",
            sourceId: resale.id,
            sourceLabel: "Retailer",
            title: "Rice 10kg",
            quantity: 2,
            productId: confirmed.confirmedProductId,
            agentId: null,
            statusBroadcastId: null,
            productCaptureItemId: null
          };
          const checkout = await call<UnifiedCheckoutSummary>(
            "POST",
            "/buy/checkout",
            { items: [item] },
            customer.cookie,
            { "idempotency-key": "commerce-complete-order" }
          );
          expect(checkout.failures).toEqual([]);
          expect(checkout.handoffs).toHaveLength(1);
          const handoffOrderId = checkout.handoffs[0]?.orderId;
          const orders = store.snapshot().buyOrders ?? [];
          const order = orders.find((entry) => entry.id === handoffOrderId);
          expect(order).toBeDefined();
          if (!order) throw new Error("expected checkout handoff order");
          expect(order.items[0]?.offerSnapshot?.chain).toHaveLength(2);
          expect(order.items[0]?.offerSnapshot?.price).toBe(220);
          const invoice = store.snapshot().invoices.find((i) => i.id === order.invoiceId);
          expect(invoice).toBeDefined();
          if (!invoice) throw new Error("expected order invoice");
          const premature = await raw(
            "POST",
            `/businesses/${retailer.id}/invoices/${invoice.id}/confirm`,
            {},
            retailer.cookie
          );
          expect(premature.statusCode).toBe(409);
          const noStock = await rawOp(agent, "fulfillment.confirm", {
            invoiceId: invoice.id,
            confirmed: true
          });
          expect(noStock.statusCode).toBe(409);
          await call(
            "POST",
            `/businesses/${agent.id}/products/${confirmed.confirmedProductId}/stock-adjustments`,
            { quantityAfter: 10, reason: "Physical receipt confirmed" },
            agent.cookie
          );
          await op(agent, "fulfillment.confirm", { invoiceId: invoice.id, confirmed: true });
          await op(agent, "fulfillment.confirm", { invoiceId: invoice.id, confirmed: true });
          expect(
            store.snapshot().products.find((p) => p.id === confirmed.confirmedProductId)?.quantity
          ).toBe(8);
          await call(
            "POST",
            `/businesses/${retailer.id}/invoices/${invoice.id}/confirm`,
            {},
            retailer.cookie
          );
          expect(store.snapshot().products.filter((p) => p.businessId === retailer.id)).toEqual([]);
          expect(
            store.snapshot().products.find((p) => p.id === confirmed.confirmedProductId)?.quantity
          ).toBe(8);
          const changed = { products: [{ ...feed.products[0]!, price: 190 }] };
          const conflict = await op<CommerceSourceCandidate[]>(agent, "source.import", {
            sourceId: source.id,
            feed: changed
          });
          expect(conflict[0]?.conflict).not.toBeNull();
          await op(agent, "candidate.confirm", {
            id: conflict[0]!.id,
            confirmed: true,
            productId: confirmed.confirmedProductId
          });
          expect(store.snapshot().invoices.find((i) => i.id === invoice.id)?.total).toBe(440);
          expect(
            store.snapshot().buyOrders?.find((o) => o.id === order.id)?.items[0]?.offerSnapshot
              ?.price
          ).toBe(220);
          await op(wholesaler, "representation.decide", {
            id: grant.id,
            status: "revoked",
            confirmed: true
          });
          expect(
            store.searchPublishedOffers({ query: "rice" }).some((o) => o.id === resale.id)
          ).toBe(false);
          if (persistent) {
            await persistent.flush();
            const reload = await createPostgresCp2Store({
              databaseUrl: process.env.CP2_POSTGRES_TEST_DATABASE_URL!
            });
            try {
              const restored = reload
                .snapshot()
                .invoices.find((i) => i.id === invoice.id) as InvoiceSummary;
              expect(restored.offerFulfillment?.[0]?.snapshot.price).toBe(220);
              expect(restored.offerFulfillment?.[0]?.fulfilledAt).not.toBeNull();
              expect(
                reload.snapshot().products.find((p) => p.id === confirmed.confirmedProductId)
                  ?.quantity
              ).toBe(8);
              expect(reload.snapshot().unifiedCommerceRecords?.some((r) => r.id === grant.id)).toBe(
                true
              );
            } finally {
              await reload.close();
            }
          }
        } finally {
          await app.close();
          if (persistent) await persistent.close();
        }
        async function owner(name: string) {
          const contact = `2547${randomInt(10000000, 99999999)}`;
          const signup = await raw("POST", "/auth/pin/signup", {
            method: "phone",
            contact,
            pin: "1234"
          });
          expect(signup.statusCode, signup.body).toBe(200);
          const header = signup.headers["set-cookie"]!;
          const cookie = (Array.isArray(header) ? header[0]! : header).split(";")[0]!;
          const business = await call<{ business: { id: string } }>(
            "POST",
            "/businesses",
            { name, language: "en" },
            cookie
          );
          return { id: business.business.id, cookie };
        }
        function raw(
          method: "GET" | "POST",
          url: string,
          payload?: object,
          cookie?: string,
          headers?: Record<string, string>
        ) {
          return app.inject({
            method,
            url,
            ...(payload ? { payload } : {}),
            headers: { ...(cookie ? { cookie } : {}), ...headers }
          });
        }
        async function call<T = unknown>(
          method: "GET" | "POST",
          url: string,
          payload?: object,
          cookie?: string,
          headers?: Record<string, string>
        ): Promise<T> {
          const response = await raw(method, url, payload, cookie, headers);
          expect(response.statusCode, response.body).toBeLessThan(300);
          return response.json<T>();
        }
        function rawOp(actor: { id: string; cookie: string }, operation: string, values: object) {
          return raw(
            "POST",
            `/businesses/${actor.id}/commerce-sources/operations`,
            { operation, values },
            actor.cookie
          );
        }
        async function op<T = unknown>(
          actor: { id: string; cookie: string },
          operation: string,
          values: object
        ): Promise<T> {
          const response = await rawOp(actor, operation, values);
          expect(response.statusCode, response.body).toBe(200);
          return response.json<T>();
        }
      },
      60000
    );
  });
