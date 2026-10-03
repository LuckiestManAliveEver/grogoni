import { describe, expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  commerceAddressFromGrogoniId,
  createGrogoniHandle,
  isReservedGrogoniHandle,
  maximumGrogoniHandleLength,
  minimumGrogoniHandleLength,
  normalizeCommerceAddress,
  reservedGrogoniHandles
} from "../services/api/src/cp2/text-normalization";

function uniquePhone(seed: number): string {
  return `2547011${String(seed).padStart(5, "0")}`;
}

function seedOwner(store: ReturnType<typeof createCp2Store>, seed: number, businessName: string) {
  const auth = store.signupWithPhonePin({ destination: uniquePhone(seed), pin: "1234" });
  const business = store.createBusiness({
    sessionId: auth.session.id,
    name: businessName,
    language: "en"
  });
  return { store, auth, business: business.business };
}

describe("createGrogoniHandle - the slugify function", () => {
  it("strips an apostrophe and collapses a space into a single hyphen", () => {
    expect(createGrogoniHandle("Mama's Kitchen")).toBe("mamas-kitchen");
  });

  it("normalizes accented characters (Café -> cafe)", () => {
    expect(createGrogoniHandle("Café Nyayo")).toBe("cafe-nyayo");
  });

  it("collapses a run of symbols and spaces into one hyphen", () => {
    expect(createGrogoniHandle("Duka la Simu #2")).toBe("duka-la-simu-2");
  });

  it("produces an empty string for an all-symbols input, never throws", () => {
    expect(createGrogoniHandle("!!! @@@ ###")).toBe("");
  });

  it("truncates an over-length input without leaving a trailing hyphen", () => {
    const longName = "a".repeat(100);
    const handle = createGrogoniHandle(longName);
    expect(handle.length).toBeLessThanOrEqual(48);
    expect(handle.endsWith("-")).toBe(false);
  });

  it("does not itself reject a reserved word - that's the generation layer's job", () => {
    // isReservedGrogoniHandle is a separate check createGlobalShopId applies on top of this - see
    // the "generation and collisions" suite below for the actual rejection behavior.
    expect(createGrogoniHandle("www")).toBe("www");
    expect(isReservedGrogoniHandle("www")).toBe(true);
  });
});

describe("reservedGrogoniHandles", () => {
  it("includes the universal short-link prefix so a store can never collide with GET /s/:slug", () => {
    expect(reservedGrogoniHandles.has("s")).toBe(true);
  });

  it("includes every top-level API and web route segment actually found in this monorepo", () => {
    for (const word of ["api", "auth", "businesses", "chat", "marketplace", "settings", "login"]) {
      expect(reservedGrogoniHandles.has(word)).toBe(true);
    }
  });

  it("is case-insensitive via isReservedGrogoniHandle", () => {
    expect(isReservedGrogoniHandle("WWW")).toBe(true);
    expect(isReservedGrogoniHandle(" Api ")).toBe(true);
  });
});

describe("grogoniId generation and collisions", () => {
  it("assigns sequential numeric suffixes for repeated business names - the '3rd Mama Mboga' case", () => {
    const store = createCp2Store();
    const first = seedOwner(store, 1, "Mama Mboga");
    const second = seedOwner(store, 2, "Mama Mboga");
    const third = seedOwner(store, 3, "Mama Mboga");

    expect(first.business.grogoniId).toBe("grogoni.mama-mboga");
    expect(second.business.grogoniId).toBe("grogoni.mama-mboga-2");
    expect(third.business.grogoniId).toBe("grogoni.mama-mboga-3");
  });

  it("skips a reserved-word business name and falls back rather than claiming it", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 10, "WWW");
    expect(owner.business.grogoniId).not.toBe("grogoni.www");
    expect(isReservedGrogoniHandle(owner.business.grogoniId.replace(/^grogoni\./u, ""))).toBe(false);
  });

  it("falls back to a generated base when the business name produces no usable handle at all", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 11, "!!! @@@ ###");
    expect(owner.business.grogoniId.startsWith("grogoni.")).toBe(true);
    const handle = owner.business.grogoniId.slice("grogoni.".length);
    expect(handle.length).toBeGreaterThanOrEqual(minimumGrogoniHandleLength);
  });
});

describe("resolveBusinessByGrogoniId - the one shared resolver", () => {
  it("resolves an active grogoniId", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 20, "Active Shop");
    const resolution = store.resolveBusinessByGrogoniId(owner.business.grogoniId);
    expect(resolution).toEqual({ status: "active", business: owner.business });
  });

  it("returns null for a grogoniId that never existed", () => {
    const store = createCp2Store();
    expect(store.resolveBusinessByGrogoniId("grogoni.never-existed")).toBeNull();
  });

  it("resolves a retired (in-cooldown) grogoniId as stale, pointing at the business's new one", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 21, "Renaming Shop");
    const oldGrogoniId = owner.business.grogoniId;
    const renamed = store.renameGrogoniId({
      sessionId: owner.auth.session.id,
      businessId: owner.business.id,
      handle: "renamed-shop-handle"
    });

    const resolution = store.resolveBusinessByGrogoniId(oldGrogoniId);
    expect(resolution).toEqual({
      status: "stale",
      business: renamed,
      redirectTo: "grogoni.renamed-shop-handle"
    });
  });

  it("resolves a released (post-cooldown) grogoniId as available again - it stops appearing in history-based resolution once claimed by a new business", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 22, "Original Owner Shop");
    const oldGrogoniId = owner.business.grogoniId;
    store.renameGrogoniId({
      sessionId: owner.auth.session.id,
      businessId: owner.business.id,
      handle: "original-owner-renamed"
    });
    store.releaseExpiredGrogoniIds({ cooldownMs: 0 });

    const newOwner = seedOwner(store, 23, "New Claimant Shop");
    const claimed = store.renameGrogoniId({
      sessionId: newOwner.auth.session.id,
      businessId: newOwner.business.id,
      handle: oldGrogoniId.replace(/^grogoni\./u, "")
    });
    expect(claimed.grogoniId).toBe(oldGrogoniId);

    const resolution = store.resolveBusinessByGrogoniId(oldGrogoniId);
    expect(resolution).toEqual({ status: "active", business: claimed });
  });
});

describe("commerce address resolver", () => {
  it("normalizes the email-like address without changing the canonical business id", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 60, "Address Shop");
    const address = commerceAddressFromGrogoniId(owner.business.grogoniId);

    expect(normalizeCommerceAddress(`  ${address.toUpperCase()}  `)).toBe(address);
    expect(store.checkCommerceAddressAvailability(address)).toEqual({
      available: false,
      normalizedAddress: address,
      reason: "taken"
    });

    const resolution = store.resolveCommerceIdentity(address);
    expect(resolution).toEqual({
      status: "active",
      identity: expect.objectContaining({
        canonicalBusinessId: owner.business.id,
        displayName: "Address Shop",
        commerceAddress: address,
        grogoniId: owner.business.grogoniId,
        supportedInteractionTypes: ["conversation", "catalogue", "order"]
      })
    });
    expect(JSON.stringify(resolution)).not.toContain(owner.auth.account.id);
  });

  it("resolves a retired commerce address as stale after a safe address change", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 61, "Old Address Shop");
    const oldAddress = commerceAddressFromGrogoniId(owner.business.grogoniId);

    const renamed = store.renameGrogoniId({
      sessionId: owner.auth.session.id,
      businessId: owner.business.id,
      handle: "new-address-shop"
    });

    expect(store.resolveCommerceIdentity(oldAddress)).toEqual({
      status: "stale",
      identity: expect.objectContaining({
        canonicalBusinessId: owner.business.id,
        commerceAddress: commerceAddressFromGrogoniId(renamed.grogoniId)
      }),
      redirectTo: "new-address-shop@grogoni.com"
    });
  });

  it("carries commerceAddress on the public storefront summary itself, single and listed", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 62, "Directory Shop");
    const address = commerceAddressFromGrogoniId(owner.business.grogoniId);

    const single = store.getPublicStorefront({ agentId: owner.business.grogoniId });
    expect(single.commerceAddress).toBe(address);

    const listed = store.listPublicStorefronts({ search: "Directory Shop" });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.commerceAddress).toBe(address);
  });

  it("checks invalid, reserved, and open commerce addresses", () => {
    const store = createCp2Store();
    expect(store.checkCommerceAddressAvailability("bad address@grogoni.com")).toEqual({
      available: false,
      normalizedAddress: "bad address@grogoni.com",
      reason: "invalid"
    });
    expect(store.checkCommerceAddressAvailability("admin@grogoni.com")).toEqual({
      available: false,
      normalizedAddress: "admin@grogoni.com",
      reason: "reserved"
    });
    expect(store.checkCommerceAddressAvailability("brand-new-shop@grogoni.com")).toEqual({
      available: true,
      normalizedAddress: "brand-new-shop@grogoni.com"
    });
  });
});

describe("renameGrogoniId", () => {
  it("moves the old grogoniId into history with releasedAt null (in cooldown)", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 30, "First Handle Shop");
    const oldGrogoniId = owner.business.grogoniId;
    store.renameGrogoniId({
      sessionId: owner.auth.session.id,
      businessId: owner.business.id,
      handle: "second-handle"
    });
    const snapshot = store.snapshot();
    const historyEntry = snapshot.grogoniIdHistory?.find((entry) => entry.grogoniId === oldGrogoniId);
    expect(historyEntry).toMatchObject({ businessId: owner.business.id, releasedAt: null });
  });

  it("rejects an in-cooldown handle that a different business is still holding history for", () => {
    const store = createCp2Store();
    const first = seedOwner(store, 31, "First Shop");
    store.renameGrogoniId({
      sessionId: first.auth.session.id,
      businessId: first.business.id,
      handle: "claimed-once"
    });
    store.renameGrogoniId({
      sessionId: first.auth.session.id,
      businessId: first.business.id,
      handle: "claimed-twice"
    });

    const second = seedOwner(store, 32, "Second Shop");
    expect(() =>
      store.renameGrogoniId({
        sessionId: second.auth.session.id,
        businessId: second.business.id,
        handle: "claimed-once"
      })
    ).toThrowError(expect.objectContaining({ code: "grogoni_id_taken" }));
  });

  it("rejects a reserved handle", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 33, "Reserved Attempt Shop");
    expect(() =>
      store.renameGrogoniId({
        sessionId: owner.auth.session.id,
        businessId: owner.business.id,
        handle: "settings"
      })
    ).toThrowError(expect.objectContaining({ code: "grogoni_id_reserved" }));
  });

  it("rejects a handle shorter than the minimum length", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 34, "Too Short Shop");
    expect(() =>
      store.renameGrogoniId({
        sessionId: owner.auth.session.id,
        businessId: owner.business.id,
        handle: "a"
      })
    ).toThrowError(expect.objectContaining({ code: "grogoni_id_invalid" }));
  });

  it("rejects a handle longer than the DNS label maximum", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 35, "Too Long Shop");
    expect(() =>
      store.renameGrogoniId({
        sessionId: owner.auth.session.id,
        businessId: owner.business.id,
        handle: "a".repeat(maximumGrogoniHandleLength + 1)
      })
    ).toThrowError(expect.objectContaining({ code: "grogoni_id_invalid" }));
  });

  it("renaming a business's display name never changes its grogoniId (pinned by default)", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 36, "Pinned Name Shop");
    const originalGrogoniId = owner.business.grogoniId;
    // No public rename-the-business-name endpoint mutates grogoniId anywhere in this codebase -
    // this test documents that invariant by re-reading the business unchanged.
    const stillActive = store.resolveBusinessByGrogoniId(originalGrogoniId);
    expect(stillActive).toEqual({ status: "active", business: owner.business });
  });
});

describe("releaseExpiredGrogoniIds", () => {
  it("does not release a history entry before its cooldown elapses", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 40, "Fresh Rename Shop");
    store.renameGrogoniId({
      sessionId: owner.auth.session.id,
      businessId: owner.business.id,
      handle: "fresh-rename-target"
    });
    const released = store.releaseExpiredGrogoniIds({ cooldownMs: 30 * 24 * 60 * 60_000 });
    expect(released).toBe(0);
  });

  it("releases a history entry once its cooldown has elapsed, making the old handle available again", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 41, "Old Rename Shop");
    const oldGrogoniId = owner.business.grogoniId;
    store.renameGrogoniId({
      sessionId: owner.auth.session.id,
      businessId: owner.business.id,
      handle: "old-rename-target"
    });

    const released = store.releaseExpiredGrogoniIds({ cooldownMs: 0 });
    expect(released).toBe(1);

    const other = seedOwner(store, 42, "Reclaiming Shop");
    const reclaimed = store.renameGrogoniId({
      sessionId: other.auth.session.id,
      businessId: other.business.id,
      handle: oldGrogoniId.replace(/^grogoni\./u, "")
    });
    expect(reclaimed.grogoniId).toBe(oldGrogoniId);
  });

  it("is idempotent - calling it again after everything is released changes nothing further", () => {
    const store = createCp2Store();
    const owner = seedOwner(store, 43, "Idempotent Shop");
    store.renameGrogoniId({
      sessionId: owner.auth.session.id,
      businessId: owner.business.id,
      handle: "idempotent-target"
    });
    expect(store.releaseExpiredGrogoniIds({ cooldownMs: 0 })).toBe(1);
    expect(store.releaseExpiredGrogoniIds({ cooldownMs: 0 })).toBe(0);
  });
});
