import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const useAuthState = readFileSync("apps/web/src/hooks/useAuthState.ts", "utf8");
const useNavigationState = readFileSync("apps/web/src/hooks/useNavigationState.ts", "utf8");
const grogoniApplication = readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8");
const chatSurface = readFileSync("apps/web/src/ChatSurface.tsx", "utf8");
const appShell = readFileSync("apps/web/src/app-shell.ts", "utf8");
const normalizedChatSurface = chatSurface.replace(/\s+/gu, " ");

describe("Grogoni Home: zero-form entry (docs/authentication/progressive-identity.md)", () => {
  it("gives a genuinely fresh visitor a device account instead of a login wall", () => {
    expect(useAuthState).toContain(
      "async function continueToGrogoni(): Promise<SessionResponse | null>"
    );
    expect(useAuthState).toContain('apiFetch<SessionResponse>("/auth/continue"');
    expect(useAuthState).toContain("idempotencyKey");
  });

  it("auto-continues every non-deliberate cold boot, new visitor or returning one, instead of a login wall", () => {
    expect(useAuthState).toMatch(
      /const isDeliberateAuthFlow =\s*initialAuthenticationTarget !== null \|\| accountDeletionIntent \|\| accountRestorationIntent;/u
    );
    expect(useAuthState).toContain("if (!isDeliberateAuthFlow) {");
    expect(useAuthState).not.toContain("initialOwnerAuth === null &&");
  });

  it("invites a recognized returning device to log back in without blocking the chat shell", () => {
    expect(useAuthState).toContain("if (initialOwnerAuth !== null) {");
    expect(useAuthState).toContain("Welcome back. Log in to restore access to");
  });

  it("keeps the idempotency attempt key short-lived and bearer-only, per the documented contract", () => {
    expect(useAuthState).toContain("deviceContinueAttemptStorageKey");
    expect(useAuthState).toContain("deviceContinueAttemptTtlMs = 10 * 60 * 1000");
  });

  it("also attempts the zero-form entry when /auth/bootstrap fails for a non-authentication reason", () => {
    // Previously only the isDefinitiveAuthenticationError branch ever called continueToGrogoni - a
    // network hiccup, a cold-start timeout, or a 5xx on the very first /auth/bootstrap request
    // (not a definitive "you're not logged in") fell straight through to a fallback that forced
    // the signup screen open for a fresh visitor, contradicting "all users start from the chat
    // shell". The zero-form attempt and its isDeliberateAuthFlow gate must now sit outside (after)
    // the isDefiniteAuthError branch, so it runs for both kinds of failure.
    const reauthenticationGate = useAuthState.indexOf("if (isDeliberateAuthFlow) {");
    const deliberateFlowDeclaration = useAuthState.indexOf("const isDeliberateAuthFlow =");
    const continueAttempt = useAuthState.indexOf("if (!isDeliberateAuthFlow) {");
    expect(reauthenticationGate).toBeGreaterThan(0);
    expect(deliberateFlowDeclaration).toBeGreaterThan(0);
    expect(continueAttempt).toBeGreaterThan(0);
    expect(deliberateFlowDeclaration).toBeLessThan(reauthenticationGate);
    expect(continueAttempt).toBeLessThan(reauthenticationGate);
  });

  it("never opens the signup/login screen for a non-deliberate cold boot, even a definitive auth failure", () => {
    // requireReauthentication (which opens the signup/login screen) must only ever be reachable
    // from performSessionRefresh's catch block through the isDeliberateAuthFlow gate - a definitive
    // 401 alone, on its own, must never route there for a visitor who never asked for that screen.
    expect(useAuthState).not.toContain("if (isDefiniteAuthError || isDeliberateAuthFlow)");
    const gate = useAuthState.indexOf("if (isDeliberateAuthFlow) {");
    const guardedSlice = useAuthState.slice(gate, gate + 200);
    expect(gate).toBeGreaterThan(0);
    expect(guardedSlice).toContain("requireReauthentication(");
    // Only one non-negated occurrence of the gate exists - the continueToGrogoni attempt above it
    // checks `!isDeliberateAuthFlow` instead.
    expect(useAuthState.indexOf("if (isDeliberateAuthFlow) {", gate + 1)).toBe(-1);
  });

  it("never forces the signup screen open as a fallback for a non-deliberate, non-authentication bootstrap failure", () => {
    expect(useAuthState).not.toContain(
      'setAuthenticationView(initialAuthenticationTarget ?? "signup")'
    );
    const fallbackTail = useAuthState.slice(
      useAuthState.indexOf("if (cached !== null) setSession(cached)")
    );
    expect(fallbackTail).not.toContain("setIsAuthOpen(true)");
  });

  it("gives a guest a real device account too, so messaging never hits a sign-in wall", () => {
    // browseAsGuest previously only skipped the signup form and left session null - "guest" was a
    // second-class, pre-progressive-identity state where sending a message (session === null in
    // ChatComposer/ChatSurface/sendChatDraftOnRuntime) still forced a "sign in to message" wall.
    // continueToGrogoni is the same zero-form entry every other cold boot already gets automatically;
    // browseAsGuest now triggers it explicitly, since a deliberate /signup visit skips the
    // automatic attempt.
    expect(useNavigationState).toContain(
      "getContinueToGrogoni: () => () => Promise<SessionResponse | null>"
    );
    expect(useNavigationState).toContain("void deps.getContinueToGrogoni()();");
    expect(useNavigationState).not.toContain("Sign in only when you want to message");
    expect(grogoniApplication).toContain("getContinueToGrogoni: () => continueToGrogoni,");
  });
});

describe("Grogoni Home: recognized returning device pill", () => {
  it("derives the pill from identityLevel, not just from having a session", () => {
    expect(grogoniApplication).toContain(
      'session?.account.identityLevel === "device" && initialOwnerAuth !== null'
    );
    expect(grogoniApplication).toContain("This device — continue to ${initialBusiness.name}?");
    expect(grogoniApplication).toContain('"This device — log in to pick up where you left off?"');
    expect(grogoniApplication).toContain("recognizedDeviceLabel={recognizedDeviceLabel}");
  });

  it("only shows on an untouched marketplace thread and taps straight into login", () => {
    expect(normalizedChatSurface).toContain(
      'mode === "marketplace" && activeModuleView === null && recognizedDeviceLabel !== null && visibleMessages.filter((message) => message.id !== "welcome").length === 0'
    );
    expect(chatSurface).toContain(
      '<button className="recognized-device-pill" type="button" onClick={onLogIn}>'
    );
  });

  it("actually opens the login form on tap, instead of a no-op behind a stale session===null gate", () => {
    // A device-only session is real and non-null, so the pre-device-account shouldShowAuth gate
    // (session === null) silently swallowed onLogIn's isAuthOpen=true - the phone/PIN form never
    // rendered. It must also fire for a session whose identityLevel is still "device".
    expect(grogoniApplication).toMatch(
      /const shouldShowAuth =\s*!authBootstrapPending &&\s*isAuthOpen &&\s*\(session === null \|\| session\.account\.identityLevel === "device"\);/u
    );
  });
});

describe("Grogoni Home: merchant entry point", () => {
  it("routes an already-authenticated customer straight into business setup, not a redundant login screen", () => {
    expect(grogoniApplication).toContain(
      'data-testid={business === null ? "shop-entry-button" : "agent-profile-link"}'
    );
    expect(normalizedChatSurface.length).toBeGreaterThan(0); // sanity: file loaded
    expect(grogoniApplication).toMatch(
      /if \(business === null\) \{\s*switchMode\("seller"\);\s*\} else \{\s*setAgentProfileInitialSection\(null\);\s*openAgentProfile\(\);\s*\}/u
    );
  });

  it("removes the customer-facing Buy/Sell toggle, keeping selling behind the shop icon and the menu", () => {
    // spec: the target UI has no Buy/Sell toggle for customers - selling lives behind the shop
    // icon -> merchant login -> workspace path only. A returning merchant who has already
    // navigated away from seller mode (e.g. into Buy) needs a different way back in now that the
    // header's old "Sell" pill is gone, since the shop icon itself still only starts *new* shop
    // setup for a business-less visitor rather than re-entering an existing one; "Go to my shop"
    // in the hamburger menu is that path.
    expect(grogoniApplication).not.toContain('data-testid="sell-button"');
    expect(grogoniApplication).not.toContain('className="commerce-mode-toggle"');
    expect(grogoniApplication).toContain("commerce-mode-toggle");
    expect(grogoniApplication).toContain("onGoToShop={() => {");
    const menuDrawer = readFileSync("apps/web/src/MenuDrawer.tsx", "utf8");
    expect(menuDrawer).toContain("onGoToShop");
    expect(menuDrawer).toContain("Go to my shop");
  });

  it("scopes the Messages pill and header sign-up/log-in to seller mode, out of the customer home", () => {
    // The Buy/Sell toggle removal above only dropped the "Sell" pill; "Messages" and the header
    // sign-up/log-in buttons stayed unconditionally rendered, which is the exact legacy "Messages
    // button + Sign up/Log in in the top nav" pattern the unified-chat spec forbids on the
    // customer home. They now render only while mode is "seller" (the merchant's own header,
    // reachable solely via the shop icon or menu) - Message history moved into the hamburger menu,
    // and the in-chat welcome message is the customer home's one sign-up/log-in entry point.
    //
    // The remaining "marketplace-button" is not that toggle: it never renders a "Sell" pill, it
    // relabels itself "Browse" (never "Buy") for a customer, and for a customer it only opens/closes
    // the storefront-browsing/cart panel in place - it never switches mode. It stays reachable on
    // the customer home because the panel it opens (cart, checkout, storefronts) has no other entry
    // point yet.
    const shellModeBarStart = grogoniApplication.indexOf(
      'aria-label={mode === "seller" ? "Commerce mode and messages" : "Shell actions"}'
    );
    expect(shellModeBarStart).toBeGreaterThan(-1);
    const shellModeBar = grogoniApplication.slice(
      shellModeBarStart,
      grogoniApplication.indexOf("</nav>", shellModeBarStart)
    );

    const buyIndex = shellModeBar.indexOf('data-testid="marketplace-button"');
    expect(buyIndex).toBeGreaterThan(-1);
    expect(shellModeBar).toContain('mode === "seller" ? "Buy" : "Browse"');

    const sellerGateStart = shellModeBar.indexOf('mode === "seller" ? (', buyIndex);
    expect(sellerGateStart).toBeGreaterThan(buyIndex);
    const sellerGateEnd = shellModeBar.indexOf(") : null}", sellerGateStart);
    expect(sellerGateEnd).toBeGreaterThan(sellerGateStart);

    const messagesIndex = shellModeBar.indexOf('data-testid="messages-button"');
    expect(messagesIndex).toBeGreaterThan(sellerGateStart);
    expect(messagesIndex).toBeLessThan(sellerGateEnd);

    const authGateStart = shellModeBar.indexOf('mode === "seller" && session === null ? (');
    expect(authGateStart).toBeGreaterThan(sellerGateEnd);
    const authGateEnd = shellModeBar.indexOf(") : null}", authGateStart);
    const signupIndex = shellModeBar.indexOf('data-testid="header-signup-button"');
    const loginIndex = shellModeBar.indexOf('data-testid="header-login-button"');
    expect(signupIndex).toBeGreaterThan(authGateStart);
    expect(signupIndex).toBeLessThan(authGateEnd);
    expect(loginIndex).toBeGreaterThan(signupIndex);
    expect(loginIndex).toBeLessThan(authGateEnd);
  });
});

describe("Grogoni Home: hamburger menu drawer", () => {
  it("opens the menu drawer instead of toggling the message inbox directly", () => {
    expect(grogoniApplication).toContain('aria-label="Open menu"');
    expect(grogoniApplication).toContain("aria-expanded={isMenuDrawerOpen}");
    expect(grogoniApplication).toContain("onClick={() => setIsMenuDrawerOpen(true)}");
  });

  it("renders MenuDrawer wired to message history and the three settings destinations", () => {
    expect(grogoniApplication).toContain('import { MenuDrawer } from "./MenuDrawer";');
    expect(grogoniApplication).toContain("<MenuDrawer");
    expect(grogoniApplication).toContain("hasBusiness={business !== null}");
    expect(grogoniApplication).toContain('setAgentProfileInitialSection("business");');
    expect(grogoniApplication).toContain('setAgentProfileInitialSection("agent");');
    expect(grogoniApplication).toContain('setAgentProfileInitialSection("security");');
  });

  it("threads the requested settings section into AgentProfileSurface, which opens and scrolls to it", () => {
    const agentProfileSurface = readFileSync("apps/web/src/AgentProfileSurface.tsx", "utf8");
    expect(grogoniApplication).toContain("initialOpenSection={agentProfileInitialSection}");
    expect(agentProfileSurface).toContain(
      'initialOpenSection?: "business" | "agent" | "security" | null;'
    );
    expect(agentProfileSurface).toContain("target.open = true;");
    expect(agentProfileSurface).toContain('target.scrollIntoView({ behavior: "smooth"');
  });

  it("resets the requested section on every other path into agent settings, so a stale menu pick can't stick", () => {
    expect(grogoniApplication).toMatch(
      /if \(!setupComplete\) return;\s*setAgentProfileInitialSection\(null\);\s*openAgentProfile\(\);/u
    );
    expect(grogoniApplication).toMatch(
      /onReview=\{\(\) => \{\s*setAgentProfileInitialSection\(null\);\s*openAgentProfile\(\);\s*\}\}/u
    );
  });

  it("falls back to a single 'set up your shop' item for a customer with no business yet", () => {
    const menuDrawer = readFileSync("apps/web/src/MenuDrawer.tsx", "utf8");
    expect(menuDrawer).toContain("Set up your shop");
    expect(menuDrawer).toContain("hasBusiness ? (");
  });
});

describe("Grogoni Home: suggested requests and capability trace", () => {
  it("shows persistent suggestion chips on an empty marketplace thread", () => {
    expect(chatSurface).toContain("home-suggestion-chips");
    expect(chatSurface).toContain(
      'const homeSuggestionPrompts = ["Find me 50kg maize nearby", "Track my delivery", "Talk to a shop"];'
    );
  });

  it("names the real capability behind a generated card instead of fabricating one", () => {
    expect(chatSurface).toContain("function capabilityTraceLabel(");
    expect(chatSurface).toContain('"product-management": "product.update"');
  });

  it("welcomes with the Grogoni Home framing instead of gating on sign-up", () => {
    expect(appShell).toContain("What do you need?");
  });

  it("keeps first-load auth out of the customer chat body and composer", () => {
    const chatComposer = readFileSync("apps/web/src/ChatComposer.tsx", "utf8");
    expect(chatSurface).not.toContain("welcome-auth-actions");
    expect(chatComposer).not.toContain("composer-card-lock");
    expect(chatComposer).not.toContain("Sign in to message");
  });

  it("never tells the customer welcome message to tap a removed Sell button", () => {
    // app-shell.ts's welcome copy predates the Buy/Sell toggle removal (see "Grogoni Home: merchant
    // entry point" above) and still said "Tap Sell" - dangling copy pointing at UI that no longer
    // exists now that selling only starts from the header's shop icon.
    expect(appShell).not.toContain("Tap Sell");
    expect(appShell).toContain("Tap the shop icon");
  });
});

describe("Grogoni Home: shop presence stays out of the customer conversation", () => {
  it("only renders the seller's own shop-status dots in seller mode with a business, never on the customer/guest home", () => {
    // ShopPresenceButtons ("Online"/"Private"/"Offline" across devices) is a seller control for
    // the merchant's own shop status - it previously rendered next to the agent's name on every
    // agent message unconditionally, including the customer/marketplace welcome message a
    // business-less guest sees first, and even inside another shop's conversation for a visitor
    // who happens to run their own business. Gated so it only ever appears in the seller's own
    // workspace chat.
    expect(chatSurface).toContain('mode === "seller" && hasBusiness ? (');
    const gateIndex = chatSurface.indexOf('mode === "seller" && hasBusiness ? (');
    const presenceIndex = chatSurface.indexOf("<ShopPresenceButtons", gateIndex);
    expect(presenceIndex).toBeGreaterThan(gateIndex);
    expect(presenceIndex).toBeLessThan(gateIndex + 120);
  });
});
