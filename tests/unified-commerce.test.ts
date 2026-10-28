import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store, readSessionCookie } from "../services/api/src/cp2/store";
import type {
  CommerceOffer,
  CommerceSource,
  DistributionRelationship,
  ProductSummary
} from "@grogoni/shared-types";

describe("unified source-linked commerce", () => {
  it("enforces publication, resale permission, independent prices, source conflicts and disconnection without stock changes", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    try {
      const seller = await owner("254722111001", "Wholesaler");
      const reseller = await owner("254722111002", "Retailer");
      const product = await request<ProductSummary>(
        "POST",
        `/businesses/${seller.businessId}/products`,
        {
          name: "Rice 10kg",
          sku: "RICE10",
          unit: "bag",
          quantity: 20,
          buyingPrice: 100,
          sellingPrice: 180
        },
        seller.cookie
      );
      const source = await op<CommerceSource>(seller, "source.connect", {
        type: "SALES_AGENT",
        reference: "price-sheet-2026-10",
        label: "Agent maintained sheet"
      });
      expect(source.authority).toBe("agent_maintained");
      expect(
        await op(seller, "source.connect", {
          type: "SALES_AGENT",
          reference: source.reference,
          label: source.label
        })
      ).toEqual(source);
      const values = {
        productId: product.id,
        sourceId: source.id,
        price: 180,
        currency: "KES",
        validUntil: "2099-01-01T00:00:00Z"
      };
      const offer = await op<CommerceOffer>(seller, "offer.create", values);
      expect(await search()).toEqual([]);
      await rawOp(seller, "offer.publish", { id: offer.id }, 400);
      await rawOp(reseller, "offer.publish", { id: offer.id, confirmed: true }, 404);
      await op(seller, "offer.publish", { id: offer.id, confirmed: true });
      await rawOp(
        reseller,
        "offer.create",
        { upstreamOfferId: offer.id, price: 220, currency: "KES", validUntil: values.validUntil },
        400
      );
      await op(seller, "offer.publish", { id: offer.id, confirmed: true, allowResell: true });
      const resale = await op<CommerceOffer>(reseller, "offer.create", {
        upstreamOfferId: offer.id,
        price: 220,
        currency: "KES",
        validUntil: values.validUntil
      });
      await op(reseller, "offer.publish", { id: resale.id, confirmed: true });
      expect((await search()).map((o: CommerceOffer) => o.price)).toEqual([180, 220]);
      expect(JSON.stringify(await search())).not.toContain("buyingPrice");
      expect(JSON.stringify(await search())).not.toContain(source.reference);
      expect(
        await request<ProductSummary[]>(
          "GET",
          `/businesses/${reseller.businessId}/products`,
          undefined,
          reseller.cookie
        )
      ).toEqual([]);
      expect(
        (
          await request<ProductSummary[]>(
            "GET",
            `/businesses/${seller.businessId}/products`,
            undefined,
            seller.cookie
          )
        )[0]?.quantity
      ).toBe(20);
      await op(seller, "product.bind", {
        sourceId: source.id,
        productId: product.id,
        externalProductId: "namespace:RICE10",
        confirmed: true
      });
      await op(seller, "product.bind", {
        sourceId: source.id,
        productId: product.id,
        externalProductId: "namespace:RICE10",
        confirmed: true
      });
      const other = await request<ProductSummary>(
        "POST",
        `/businesses/${seller.businessId}/products`,
        { name: "Rice 5kg", unit: "bag", quantity: 0 },
        seller.cookie
      );
      await rawOp(
        seller,
        "product.bind",
        {
          sourceId: source.id,
          productId: other.id,
          externalProductId: "namespace:RICE10",
          confirmed: true
        },
        409
      );
      const snapshot = store.snapshot();
      store.hydrateSnapshot(snapshot);
      expect(await search()).toHaveLength(2);
      await op(seller, "offer.update", { id: offer.id, price: 190, validUntil: values.validUntil });
      await op(seller, "offer.publish", { id: offer.id, confirmed: true, allowResell: true });
      expect((await search()).map((o: CommerceOffer) => o.price)).toEqual([190, 220]);
      await op(seller, "source.disconnect", { id: source.id });
      expect(await search()).toEqual([]);
      expect(
        store.snapshot().unifiedCommerceRecords?.filter((r) => r.kind === "offer")
      ).toHaveLength(2);
      expect(
        store.snapshot().unifiedCommerceRecords?.filter((r) => r.kind === "binding")
      ).toHaveLength(1);
      const unauthorized = await app.inject({
        method: "GET",
        url: `/businesses/${seller.businessId}/commerce-sources`,
        headers: { cookie: reseller.cookie }
      });
      expect(unauthorized.statusCode).toBe(403);
      const rel = await op<DistributionRelationship>(seller, "relationship.request", {
        targetBusinessId: reseller.businessId
      });
      await rawOp(seller, "relationship.respond", { id: rel.id, accept: true }, 404);
      const accepted = await op<DistributionRelationship>(reseller, "relationship.respond", {
        id: rel.id,
        accept: true
      });
      expect(accepted.status).toBe("accepted");
      await rawOp(reseller, "relationship.respond", { id: rel.id, accept: true }, 409);
      expect(
        await request<unknown[]>(
          "GET",
          `/businesses/${reseller.businessId}/commerce-sources`,
          undefined,
          reseller.cookie
        )
      ).not.toContainEqual(source);
      await rawOp(
        seller,
        "source.connect",
        { type: "WEBSITE", reference: "http://localhost/private", label: "Bad website" },
        400
      );
      const web = await op<CommerceSource>(seller, "source.connect", {
        type: "WEBSITE",
        reference: "https://shop.example/catalogue",
        label: "Website"
      });
      expect(web.lastSuccessfulRefresh).toBeNull();
      const draft = await request<{
        id: string;
        rows: {
          mapped: {
            name: string;
            sellingPrice: number | null;
            buyingPrice: number | null;
            quantity: number;
          };
        }[];
      }>(
        "POST",
        `/businesses/${reseller.businessId}/commerce-sources/describe`,
        { description: "I sell maize flour, sugar, cooking oil, rice, and soap." },
        reseller.cookie
      );
      expect(draft.rows.map((r) => r.mapped.name)).toEqual([
        "maize flour",
        "sugar",
        "cooking oil",
        "rice",
        "soap"
      ]);
      for (const row of draft.rows) {
        expect(row.mapped.sellingPrice).toBeNull();
        expect(row.mapped.buyingPrice).toBeNull();
        expect(row.mapped.quantity).toBe(0);
      }
      expect(
        await request<ProductSummary[]>(
          "GET",
          `/businesses/${reseller.businessId}/products`,
          undefined,
          reseller.cookie
        )
      ).toEqual([]);
      await request(
        "POST",
        `/businesses/${reseller.businessId}/imports/${draft.id}/confirm-products`,
        {},
        reseller.cookie
      );
      expect(
        await request<ProductSummary[]>(
          "GET",
          `/businesses/${reseller.businessId}/products`,
          undefined,
          reseller.cookie
        )
      ).toHaveLength(5);
      const galleryInput = {
        sessionId: readSessionCookie(seller.cookie),
        businessId: seller.businessId,
        sourceFileName: "selected-photo.jpg",
        contentType: "image/jpeg" as const,
        extractedText: "Rice"
      };
      for (let i = 0; i < 120; i++) {
        const first = store.createProductCaptureJob({
          ...galleryInput,
          sourceChecksum: `photo-${i}`
        });
        const second = store.createProductCaptureJob({
          ...galleryInput,
          sourceChecksum: `photo-${i}`
        });
        expect(second.id).toBe(first.id);
        expect(first.status).not.toBe("PUBLISHED");
      }
      expect(store.snapshot().productCaptureJobs).toHaveLength(120);
      expect(store.listGalleryCaptures(galleryInput)).toHaveLength(100);
      const foreign = store.createProductCaptureJob({
        ...galleryInput,
        sessionId: readSessionCookie(reseller.cookie),
        businessId: reseller.businessId,
        sourceChecksum: "photo-0"
      });
      expect(foreign.businessId).toBe(reseller.businessId);
      expect(store.snapshot().productCaptureJobs).toHaveLength(121);
      expect(store.snapshot().products.find((p) => p.id === product.id)?.quantity).toBe(20);
    } finally {
      await app.close();
    }
    async function owner(phone: string, name: string) {
      const signup = await app.inject({
        method: "POST",
        url: "/auth/pin/signup",
        payload: { method: "phone", contact: phone, pin: "1234" }
      });
      expect(signup.statusCode).toBeLessThan(300);
      const header = signup.headers["set-cookie"];
      const cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
      const result = await request<{ business: { id: string } }>(
        "POST",
        "/businesses",
        { name, language: "en" },
        cookie
      );
      return { cookie, businessId: result.business.id };
    }
    async function request<T>(
      method: "POST" | "GET",
      url: string,
      payload?: object,
      cookie?: string
    ): Promise<T> {
      const response = await app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
        headers: cookie ? { cookie } : {}
      });
      expect(response.statusCode, response.body).toBeLessThan(300);
      return response.json<T>();
    }
    async function op<T = unknown>(
      actor: { cookie: string; businessId: string },
      operation: string,
      values: object
    ) {
      return request<T>(
        "POST",
        `/businesses/${actor.businessId}/commerce-sources/operations`,
        { operation, values },
        actor.cookie
      );
    }
    async function rawOp(
      actor: { cookie: string; businessId: string },
      operation: string,
      values: object,
      status: number
    ) {
      const r = await app.inject({
        method: "POST",
        url: `/businesses/${actor.businessId}/commerce-sources/operations`,
        payload: { operation, values },
        headers: { cookie: actor.cookie }
      });
      expect(r.statusCode, r.body).toBe(status);
    }
    async function search() {
      return request<CommerceOffer[]>("GET", "/public/commerce-offers?query=rice");
    }
  });
});
