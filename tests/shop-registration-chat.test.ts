// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  continueShopRegistration,
  isShopRegistrationRequest,
  readPendingShopRegistration,
  savePendingShopRegistration,
  startShopRegistration
} from "../apps/web/src/shop-registration-chat";
import { routeGuestMessage } from "../apps/web/src/marketplace-search-reply";

describe("marketplace agent shop registration", () => {
  it.each([
    "I want to open a shop",
    "open a shop",
    "register my store",
    "Please set up a new business",
    "I want to sell on Grogoni",
    "nataka kufungua duka",
    "nataka kuuza"
  ])("recognizes %s", (message) => expect(isShopRegistrationRequest(message)).toBe(true));

  it.each([
    "where is the nearest shop",
    "sugar",
    "what is the selling price of rice",
    "shop near me",
    "I want to start a business selling sugar, where do I buy sugar",
    "where can I open a store account",
    "make business cards near me",
    "open the store page",
    "open Kamau store",
    "how do I register a business in Kenya",
    "who can make a shop sign for me",
    "create a new business plan",
    "start a small business loan",
    "remind me to open my shop at 8am"
  ])("leaves %s to the marketplace", (message) =>
    expect(isShopRegistrationRequest(message)).toBe(false)
  );

  it("needs an explicit yes after the name and phone", () => {
    const name = continueShopRegistration(startShopRegistration().next, "Mama Mboga", null);
    expect(name).toMatchObject({ kind: "ask", next: { step: "phone", name: "Mama Mboga" } });
    if (name.kind !== "ask") throw new Error("expected a question");
    const phone = continueShopRegistration(name.next, "0712345678", null);
    expect(phone).toMatchObject({ kind: "ask", next: { step: "confirm" } });
    if (phone.kind !== "ask") throw new Error("expected a question");
    expect(continueShopRegistration(phone.next, "yes", null)).toEqual({
      kind: "register",
      name: "Mama Mboga",
      phoneNumber: "0712345678"
    });
  });

  it("creates nothing unless the confirmation is a yes", () => {
    const confirm = { step: "confirm", name: "Mama Mboga", phoneNumber: null } as const;
    for (const reply of ["where can I buy sugar", "sugar", "confirm checkout", "maybe"])
      expect(continueShopRegistration(confirm, reply, null).kind).toBe("cancelled");
  });

  it("does not take a question or another command as the shop's name", () => {
    for (const reply of [
      "where can I buy sugar",
      "why do you need that?",
      "confirm checkout",
      "please remind me",
      "x"
    ])
      expect(continueShopRegistration({ step: "name" }, reply, "+254712345678")).toMatchObject({
        kind: "ask",
        next: { step: "name" }
      });
  });

  it("accepts a real name that starts like a question", () => {
    expect(continueShopRegistration({ step: "name" }, "Can Do Hardware", null)).toMatchObject({
      kind: "ask",
      next: { step: "phone", name: "Can Do Hardware" }
    });
  });

  it("skips the phone question when one is saved, and still confirms", () => {
    expect(continueShopRegistration({ step: "name" }, "Mama Mboga", "+254712345678")).toMatchObject(
      {
        kind: "ask",
        next: { step: "confirm", name: "Mama Mboga", phoneNumber: null }
      }
    );
  });

  it("stops on cancel", () => {
    expect(continueShopRegistration({ step: "name" }, "cancel", null).kind).toBe("cancelled");
    expect(continueShopRegistration({ step: "phone", name: "Mama" }, "acha", null).kind).toBe(
      "cancelled"
    );
  });

  it("survives a reload through session storage", () => {
    const pending = { accountId: "a", threadId: "t", step: { step: "name" } } as const;
    savePendingShopRegistration(pending);
    expect(readPendingShopRegistration()).toEqual(pending);
    savePendingShopRegistration(null);
    expect(readPendingShopRegistration()).toBeNull();
  });

  it("drops a stored flow that is malformed or stale", () => {
    sessionStorage.setItem(
      "grogoni.shop-registration.v1",
      JSON.stringify({ accountId: "a", threadId: null, step: { step: "name" }, savedAt: 1 })
    );
    expect(readPendingShopRegistration()).toBeNull();
    sessionStorage.setItem("grogoni.shop-registration.v1", '{"accountId":"a","savedAt":1}');
    expect(readPendingShopRegistration()).toBeNull();
    sessionStorage.setItem("grogoni.shop-registration.v1", "not json");
    expect(readPendingShopRegistration()).toBeNull();
    sessionStorage.clear();
  });

  it("keeps working in memory when storage throws", () => {
    const pending = { accountId: "a", threadId: "t", step: { step: "name" } } as const;
    const failing = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    savePendingShopRegistration(pending);
    failing.mockRestore();
    expect(readPendingShopRegistration()).toEqual(pending);
    savePendingShopRegistration(null);
  });

  it("marks the guest route so the agent can start it", () => {
    expect(routeGuestMessage("I want to sell on Grogoni")).toMatchObject({ selling: true });
  });
});
