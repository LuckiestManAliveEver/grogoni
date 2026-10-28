import { describe, expect, it } from "vitest";
import type { CommerceOffer, CommerceSource, ProductSummary } from "@grogoni/shared-types";
import { CommerceSourcesDomain } from "../services/api/src/cp2/domains/commerce-sources/store";
function fixture() {
  const product = {
    id: "rice",
    businessId: "seller",
    name: "Rice",
    unit: "bag",
    aliases: ["mchele"]
  } as ProductSummary;
  let deleted = false;
  const audits: string[] = [];
  const domain = new CommerceSourcesDomain({
    authorize: (input) => {
      if (input.sessionId !== input.businessId) throw new Error("denied");
      return input.sessionId;
    },
    product: (businessId, id) => {
      if (deleted || businessId !== "seller" || id !== "rice") throw new Error("not found");
      return product;
    },
    businessName: (id) => (["seller", "reseller"].includes(id) ? id : null),
    audit: (_actor, _record, operation) => {
      audits.push(operation);
    }
  });
  const now = new Date("2026-10-25T10:00:00Z");
  const owner = { sessionId: "seller", businessId: "seller", now };
  const reseller = { sessionId: "reseller", businessId: "reseller", now };
  const values = {
    productId: "rice",
    price: 180,
    currency: "KES",
    validUntil: "2026-10-26T10:00:00Z"
  };
  return {
    domain,
    owner,
    reseller,
    values,
    audits,
    deleteProduct: () => {
      deleted = true;
    }
  };
}
describe("source commerce policy", () => {
  it("hides expired offers, retains transactions' source metadata, and matches aliases without inference", () => {
    const { domain, owner, values } = fixture();
    const offer = domain.execute(owner, "offer.create", values) as CommerceOffer;
    domain.execute(owner, "offer.publish", { id: offer.id, confirmed: true });
    expect(domain.search({ query: "mchele", now: owner.now })).toHaveLength(1);
    expect(domain.search({ now: new Date(values.validUntil) })).toEqual([]);
    expect(domain.records.has(offer.id)).toBe(true);
  });
  it("withdraws descendants when resale consent is revoked and preserves independent prices", () => {
    const { domain, owner, reseller, values } = fixture();
    const upstream = domain.execute(owner, "offer.create", values) as CommerceOffer;
    domain.execute(owner, "offer.publish", { id: upstream.id, confirmed: true, allowResell: true });
    const linked = domain.execute(reseller, "offer.create", {
      ...values,
      price: 220,
      upstreamOfferId: upstream.id
    }) as CommerceOffer;
    domain.execute(reseller, "offer.publish", { id: linked.id, confirmed: true });
    expect(domain.search({ now: owner.now })).toHaveLength(2);
    domain.execute(owner, "offer.publish", {
      id: upstream.id,
      confirmed: true,
      allowResell: false
    });
    expect(domain.search({ now: owner.now })).toHaveLength(1);
    expect((domain.records.get(linked.id) as CommerceOffer).price).toBe(220);
  });
  it("rejects invalid price, forged tenant references, missing consent and publication from disconnected sources", () => {
    const { domain, owner, values, audits } = fixture();
    for (const price of [NaN, Infinity, -1, "180"])
      expect(() => domain.execute(owner, "offer.create", { ...values, price })).toThrow();
    expect(() => domain.execute({ ...owner, sessionId: "intruder" }, "source.connect", {})).toThrow(
      "denied"
    );
    const source = domain.execute(owner, "source.connect", {
      type: "DOCUMENT_IMPORT",
      label: "Sheet",
      reference: "private-price-sheet"
    }) as CommerceSource;
    const offer = domain.execute(owner, "offer.create", {
      ...values,
      sourceId: source.id
    }) as CommerceOffer;
    expect(() => domain.execute(owner, "offer.publish", { id: offer.id })).toThrow();
    domain.execute(owner, "source.disconnect", { id: source.id });
    expect(() =>
      domain.execute(owner, "offer.publish", { id: offer.id, confirmed: true })
    ).toThrow();
    expect((domain.records.get(offer.id) as CommerceOffer).status).toBe("draft");
    expect(audits).not.toContain("offer.publish");
  });
  it("hides deleted products and requires source review without mutating product records", () => {
    const { domain, owner, values, deleteProduct } = fixture();
    const offer = domain.execute(owner, "offer.create", values) as CommerceOffer;
    domain.execute(owner, "offer.publish", { id: offer.id, confirmed: true });
    deleteProduct();
    expect(domain.search({ now: owner.now })).toEqual([]);
  });
});
