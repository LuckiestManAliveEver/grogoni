import { describe, expect, it } from "vitest";
import type {
  CommerceSource,
  CommerceSourceCandidate,
  ProductSummary
} from "@grogoni/shared-types";
import { CommerceSourcesDomain } from "../services/api/src/cp2/domains/commerce-sources/store";
import { compareCommerceIdentity } from "../services/api/src/cp2/domains/commerce-sources/identity";
import { isPublicCommerceAddress } from "../services/api/src/cp2/domains/commerce-sources/website";
const now = new Date("2026-10-26T10:00:00Z");
const actor = { businessId: "seller", sessionId: "seller", now };
function fixture(reader: (url: string) => Promise<string>) {
  const domain = new CommerceSourcesDomain({
    authorize: (input) => {
      if (input.sessionId !== input.businessId) throw new Error("denied");
      return input.businessId;
    },
    product: () =>
      ({ id: "rice", businessId: "seller", name: "Rice", unit: "bag" }) as ProductSummary,
    businessName: () => "Seller",
    audit: () => undefined,
    websiteReader: reader
  });
  const source = domain.execute(actor, "source.connect", {
    type: "WEBSITE",
    reference: "https://shop.example/feed.json",
    label: "My website"
  }) as CommerceSource;
  return { domain, source };
}
describe("authorized commerce sources", () => {
  it("requires an exact website challenge, stages idempotent review candidates and never publishes or receives stock during refresh", async () => {
    let challenge = "";
    const product = {
      externalId: "rice-10",
      name: "Rice 10kg",
      unit: "bag",
      price: 180,
      currency: "KES",
      validUntil: "2026-11-01T10:00:00Z",
      availability: "unknown"
    };
    const { domain, source } = fixture(async (url) =>
      url.endsWith("grogoni-commerce.txt") ? challenge : JSON.stringify({ products: [product] })
    );
    await expect(domain.website(actor, source.id, "refresh")).rejects.toThrow(
      "Verify source ownership"
    );
    challenge = source.challenge!;
    await domain.website({ ...actor, now: new Date(+now + 16000) }, source.id, "verify");
    const rows = (await domain.website(
      { ...actor, now: new Date(+now + 32000) },
      source.id,
      "refresh"
    )) as CommerceSourceCandidate[];
    const again = (await domain.website(
      { ...actor, now: new Date(+now + 48000) },
      source.id,
      "refresh"
    )) as CommerceSourceCandidate[];
    expect(rows[0]?.id).toBe(again[0]?.id);
    expect(rows[0]?.status).toBe("review");
    expect(domain.search({ now })).toEqual([]);
    expect([...domain.records.values()].some((r) => r.kind === "binding")).toBe(false);
  });
  it("does not reconnect a source when an in-flight verification completes after disconnection", async () => {
    let finish!: (value: string) => void;
    const { domain, source } = fixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = domain.website(actor, source.id, "verify");
    domain.execute(actor, "source.disconnect", { id: source.id });
    finish(source.challenge!);
    await expect(pending).rejects.toThrow("Source changed");
    expect((domain.records.get(source.id) as CommerceSource).status).toBe("disconnected");
  });
  it("rejects unauthorized callers, duplicate source identities and unsupported availability claims without partial writes", () => {
    const { domain, source } = fixture(async () => "");
    expect(() =>
      domain.stageFeed({ ...actor, sessionId: "intruder" }, source.id, { products: [] })
    ).toThrow("denied");
    const product = {
      externalId: "rice",
      name: "Rice",
      unit: "bag",
      price: 180,
      currency: "KES",
      validUntil: "2026-11-01"
    };
    expect(() => domain.stageFeed(actor, source.id, { products: [product, product] })).toThrow(
      "unique"
    );
    expect(() =>
      domain.stageFeed(actor, source.id, { products: [{ ...product, availability: "available" }] })
    ).toThrow("evidence");
    expect(domain.records.size).toBe(1);
  });
  it("requires packaging and variant review and does not treat SKU values in different namespaces as identity", () => {
    expect(
      compareCommerceIdentity({ sku: "R1", skuNamespace: "A" }, { sku: "R1", skuNamespace: "B" })
        .match
    ).toBe(false);
    expect(
      compareCommerceIdentity(
        { barcode: "123", packaging: "10kg" },
        { barcode: "123", packaging: "5kg" }
      )
    ).toMatchObject({ match: false, conflicts: ["packaging"], reviewRequired: true });
    expect(
      compareCommerceIdentity({ barcode: "123", unit: "bag" }, { barcode: "123", unit: "bag" })
        .match
    ).toBe(true);
  });
  it("rejects private, reserved, loopback and IPv6 targets before any source HTTP request", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::ffff:127.0.0.1"
    ])
      expect(isPublicCommerceAddress(address)).toBe(false);
    expect(isPublicCommerceAddress("1.1.1.1")).toBe(true);
  });
});
