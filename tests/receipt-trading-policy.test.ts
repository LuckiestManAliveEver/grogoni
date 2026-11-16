import { describe, expect, it } from "vitest";
import type { ReceiptTradingGrant, ProjectionEffect } from "@grogoni/shared-types";
import { createCp2Store } from "../services/api/src/cp2/store";
import { evaluateTradingGrant } from "../services/api/src/cp2/domains/receipt-commerce/trading-policy";

function fixture() {
  const store = createCp2Store();
  const owner = store.signupWithPhonePin({ destination: "+254712346795", pin: "3927" });
  const partner = store.signupWithPhonePin({ destination: "+254712346796", pin: "3927" });
  const business = store.createBusiness({
    sessionId: owner.session.id,
    name: "Policy shop",
    language: "en"
  }).business;
  const supplierBusiness = store.createBusiness({
    sessionId: partner.session.id,
    name: "Policy supplier",
    language: "en"
  }).business;
  const input = { sessionId: owner.session.id, businessId: business.id };
  const supplier = store.createSupplier({ ...input, supplier: { name: "Supplier" } });
  const values = {
    partnerBusinessId: supplierBusiness.id,
    partnerRole: "supplier",
    localPartnerId: supplier.id,
    allowedKinds: ["goods_sale"],
    currency: "KES",
    maxTransactionMinor: 100000,
    permissions: {
      postInventory: true,
      recordBalance: true,
      recordPayment: false,
      attributeSales: false
    },
    agentDelegation: { enabled: true, maxTransactionMinor: 50000 },
    expiresAt: "2030-01-01T00:00:00.000Z",
    confirmed: true
  };
  return { store, input, values, owner, partner, supplierBusiness };
}
function grantFixture() {
  const f = fixture();
  const grant = f.store.executeSourceCommerce(
    f.input,
    "trading_grant.create",
    f.values
  ) as ReceiptTradingGrant;
  const evaluate = (overrides: Partial<Parameters<typeof evaluateTradingGrant>[0]> = {}) =>
    evaluateTradingGrant({
      grant,
      businessId: grant.businessId,
      partnerBusinessId: grant.partnerBusinessId,
      kind: "goods_sale",
      amountMinor: 10000,
      currency: "KES",
      effects: ["purchase_record", "stock_in", "payable"],
      now: new Date("2026-11-16T12:00:00Z"),
      ...overrides
    });
  return { ...f, grant, evaluate };
}
describe("owner-issued receipt trading permissions", () => {
  it("preserves explicit account/partner links and ignores forged issuer metadata", () => {
    const { store, input, values, owner } = fixture();
    const grant = store.executeSourceCommerce(input, "trading_grant.create", {
      ...values,
      createdBy: "forged",
      businessId: "other"
    }) as ReceiptTradingGrant;
    expect(grant.createdBy).toBe(owner.user.id);
    expect(grant.businessId).toBe(input.businessId);
    const restored = createCp2Store();
    restored.hydrateSnapshot(store.snapshot());
    expect(restored.listCommerceSources(input)).toContainEqual(grant);
    expect(() => restored.executeSourceCommerce(input, "trading_grant.create", values)).toThrow(
      /Revoke/
    );
    const revoked = restored.executeSourceCommerce(input, "trading_grant.revoke", {
      id: grant.id
    }) as ReceiptTradingGrant;
    expect(revoked.revokedBy).toBe(owner.user.id);
    expect(revoked.status).toBe("revoked");
  });
  it("denies foreign sessions, foreign local records and unconfirmed standing authority", () => {
    const { store, input, values, partner } = fixture();
    expect(() =>
      store.executeSourceCommerce(
        { ...input, sessionId: partner.session.id },
        "trading_grant.create",
        values
      )
    ).toThrow();
    expect(() =>
      store.executeSourceCommerce(input, "trading_grant.create", {
        ...values,
        localPartnerId: "not-owned"
      })
    ).toThrow();
    expect(() =>
      store.executeSourceCommerce(input, "trading_grant.create", { ...values, confirmed: false })
    ).toThrow(/explicitly/);
    expect(store.listCommerceSources(input).filter((r) => r.kind === "trading_grant")).toEqual([]);
  });
  it("requires concrete booleans and a bounded delegation ceiling", () => {
    const { store, input, values } = fixture();
    expect(() =>
      store.executeSourceCommerce(input, "trading_grant.create", {
        ...values,
        permissions: { postInventory: "true" }
      })
    ).toThrow(/booleans/);
    expect(() =>
      store.executeSourceCommerce(input, "trading_grant.create", {
        ...values,
        agentDelegation: { enabled: true, maxTransactionMinor: 200000 }
      })
    ).toThrow(/ceiling/);
  });
  it("rechecks scope, category, value, currency, expiry and revocation on every attempt", () => {
    const { grant, evaluate } = grantFixture();
    expect(evaluate().authorized).toBe(true);
    expect(evaluate({ partnerBusinessId: "other" }).reason).toBe("no_grant");
    expect(evaluate({ kind: "refund" }).reason).toBe("kind_not_allowed");
    expect(evaluate({ amountMinor: 100001 }).reason).toBe("amount_over_limit");
    expect(evaluate({ currency: "USD" }).reason).toBe("currency_mismatch");
    expect(evaluate({ now: new Date(grant.expiresAt!) }).reason).toBe("grant_expired");
    expect(
      evaluate({ grant: { ...grant, status: "revoked", revokedAt: new Date().toISOString() } })
        .reason
    ).toBe("grant_revoked");
    expect(evaluate({ grant: { ...grant, maxTransactionMinor: null } }).authorized).toBe(false);
  });
  it("does not elevate an agent above its separate delegated ceiling", () => {
    const { evaluate } = grantFixture();
    expect(evaluate({ amountMinor: 75000 }).authorized).toBe(true);
    expect(evaluate({ amountMinor: 75000, agent: true }).authorized).toBe(false);
    expect(evaluate({ amountMinor: 50000, agent: true }).authorized).toBe(true);
  });
  it.each(["payment_record", "sales_attribution", "commission_eligibility"] as ProjectionEffect[])(
    "does not infer %s permission",
    (effect) => {
      const { evaluate } = grantFixture();
      expect(evaluate({ effects: [effect] })).toMatchObject({
        authorized: false,
        permittedEffects: []
      });
    }
  );
  it("requires current authorized salesperson representation, independently of a grant", () => {
    const { grant, evaluate } = grantFixture();
    const salesGrant = { ...grant, partnerRole: "salesperson" as const, representationId: "rep" };
    expect(evaluate({ grant: salesGrant }).reason).toBe("representation_not_authorized");
    const representation = {
      id: "rep",
      kind: "representation" as const,
      businessId: grant.partnerBusinessId,
      principalBusinessId: grant.businessId,
      status: "authorized" as const,
      territory: "Nairobi",
      decidedBy: "principal",
      createdAt: "2026-11-16",
      updatedAt: "2026-11-16"
    };
    expect(evaluate({ grant: salesGrant, representation }).authorized).toBe(true);
    expect(
      evaluate({ grant: salesGrant, representation: { ...representation, status: "revoked" } })
        .authorized
    ).toBe(false);
  });
});

it("does not let a manager issue standing account authority", () => {
  const { store, input, values, partner } = fixture();
  const snapshot = store.snapshot();
  snapshot.memberships.push({
    ...snapshot.memberships[0]!,
    id: "manager-for-policy-test",
    businessId: input.businessId,
    userId: partner.user.id,
    role: "manager"
  });
  store.hydrateSnapshot(snapshot);
  expect(() =>
    store.executeSourceCommerce(
      { ...input, sessionId: partner.session.id },
      "trading_grant.create",
      values
    )
  ).toThrow(/Only the account owner/);
});

it("rejects impossible or ambiguous expiry dates and invalid retry clocks", () => {
  const { store, input, values } = fixture();
  expect(() =>
    store.executeSourceCommerce(input, "trading_grant.create", {
      ...values,
      expiresAt: "2029-02-31T00:00:00Z"
    })
  ).toThrow(/expiry/);
  expect(() =>
    store.executeSourceCommerce(input, "trading_grant.create", {
      ...values,
      expiresAt: "01/02/2030"
    })
  ).toThrow(/expiry/);
  const { evaluate } = grantFixture();
  expect(evaluate({ now: new Date(NaN) }).authorized).toBe(false);
});
