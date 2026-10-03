import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Marketplace mode, the buy-intent card (MarketplaceModeCard, labeled "Buy" in the UI), and guest
 * browsing all live in one window now: the standard ChatSurface shell. Guests used to be diverted
 * to a separate, stripped-down GuestMarketplaceChat screen the moment they had no session - that
 * duplicated the search UX and dropped storefront browsing, cart, and quick prompts. ChatSurface
 * keeps account-only affordances behind progressive authentication while allowing the composer to
 * bootstrap a temporary device session. Removing the diversion gives guests the full buy-intent
 * experience inside the same shell everyone else uses.
 */
describe("buy intent, marketplace, and guest browsing share one window", () => {
  const application = readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8");
  const chatSurface = readFileSync("apps/web/src/ChatSurface.tsx", "utf8");
  const chatComposer = readFileSync("apps/web/src/ChatComposer.tsx", "utf8");
  const marketplaceModeCard = readFileSync("apps/web/src/MarketplaceModeCard.tsx", "utf8");
  const statusResultCard = readFileSync("apps/web/src/StatusResultCard.tsx", "utf8");

  it("no longer diverts guest browsing to a separate screen", () => {
    expect(application).not.toContain("GuestMarketplaceChat");
    expect(application).not.toContain("isGuestBrowsing");
    expect(() => readFileSync("apps/web/src/GuestMarketplaceChat.tsx", "utf8")).toThrow();
  });

  it("keeps the auth-screen gate limited to bootstrap, sign-in, and account restoration", () => {
    const isAuthScreenLine = application.slice(
      application.indexOf("const isAuthScreen ="),
      application.indexOf(";", application.indexOf("const isAuthScreen ="))
    );
    expect(isAuthScreenLine).toContain("authBootstrapPending");
    expect(isAuthScreenLine).toContain("shouldShowAuth");
    expect(isAuthScreenLine).toContain("isAccountRestorationOpen");
    expect(isAuthScreenLine).not.toContain("isGuestBrowsing");
  });

  it("renders the buy-intent card (MarketplaceModeCard) inside the same ChatSurface every visitor gets", () => {
    expect(chatSurface).toContain("<MarketplaceModeCard");
    expect(chatSurface).toContain("onSignUp={onSignUp}");
  });

  it("threads sign-up through the buy-intent card into every guest result, not just a banner", () => {
    expect(marketplaceModeCard).toContain("onSignUp: () => void");
    expect(marketplaceModeCard).toContain("onSignUp={onSignUp}");
    const guestNoteBlock = marketplaceModeCard.slice(
      marketplaceModeCard.indexOf('<div className="guest-browsing-note">'),
      marketplaceModeCard.indexOf(
        "</div>",
        marketplaceModeCard.indexOf('<div className="guest-browsing-note">')
      )
    );
    expect(guestNoteBlock).toContain("onClick={onSignUp}");
    expect(statusResultCard).toContain("props.onSignUp !== undefined");
    expect(statusResultCard).toContain("onClick={props.onSignUp}");
  });

  it("keeps the shared composer available for progressive guest entry", () => {
    expect(chatComposer).not.toContain("composer-card-lock");
    expect(chatComposer).not.toContain(
      "Sign in to send and receive end-to-end encrypted messages."
    );
    expect(chatComposer).not.toContain("Sign in to message");
  });

  it("does not put an account-choice wall in the shared welcome message", () => {
    expect(chatSurface).not.toContain("welcome-auth-actions");
    expect(chatSurface).not.toContain("Browse as guest");
  });
});
