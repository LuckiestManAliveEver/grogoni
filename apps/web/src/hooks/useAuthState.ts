import { isExplicitOfflineMode } from "../offline-runtime";
import { createSessionContextRetry } from "../session-context-retry";
import { useRef, useState } from "react";

import type {
  AccountShopSummary,
  AuthBootstrapResponse,
  AuthBootstrapState,
  GrogoniChatSurface,
  GrogoniSessionContext
} from "@grogoni/shared-types";

import type { AccountRestorationResult } from "../features/account-restoration/AccountRestorationPanel";
import type { ShellView, GrogoniMode } from "../app-shell";
import {
  clearCachedAuthSession,
  readCachedAuthSession,
  saveCachedAuthSession
} from "../auth-bootstrap";
import { getJson, patchJson, postJson } from "../api-helpers";
import { navigateToBrowserUrl, navigateToOwnerRoute } from "../browser-navigation";
import {
  getErrorMessage,
  logAuthenticationLifecycle,
  logClientEvent
} from "../chat-message-plumbing";
import { inferCountryCode } from "../country-dial-codes";
import {
  applySessionContextPatchWithConflictRetry,
  shellViewForSurface
} from "../cross-device-session-context";
import {
  commitDeviceRecoveryCredential,
  prepareDeviceRecoveryCredential,
  recoverDeviceAccount
} from "../device-recovery";
import { apiFetch, isDefinitiveAuthenticationError, isRetryableApiRequestError } from "../lib/api";
import {
  createDefaultAgent,
  readPendingOAuthLogin,
  readStoredBusiness
} from "../owner-app-bootstrap";
import { authenticationRoute, routes } from "../routes";
import { readDeepLinkedPlace, resolveRestoredPlace } from "../session-restore-place";
import {
  activeAgentStorageKey,
  activeBusinessStorageKey,
  activeModeStorageKey,
  deviceContinueAttemptStorageKey,
  guestBrowsingStorageKey,
  ownerAuthStorageKey,
  pendingOAuthStorageKey,
  setupDraftStorageKey,
  socialSignupProviders,
  type ActiveBusiness,
  type AgentSettings,
  type CountryDialCode,
  type NetworkGraphSummary,
  type OAuthProviderSummary,
  type OAuthProvidersResponse,
  type OAuthStartResponse,
  type OwnerAuthRecord,
  type PendingOAuthLogin,
  type RoleCheckResponse,
  type SessionResponse,
  type SocialSignupProvider
} from "../grogoni-application-shared";

interface UseAuthStateDeps {
  business: ActiveBusiness | null;
  setBusiness: (business: ActiveBusiness | null) => void;
  setSession: (
    session: SessionResponse | null | ((current: SessionResponse | null) => SessionResponse | null)
  ) => void;
  grogoniSessionContext: GrogoniSessionContext | null;
  setGrogoniSessionContext: (context: GrogoniSessionContext | null) => void;
  setAgentSettings: (agent: AgentSettings) => void;
  setMode: (mode: GrogoniMode) => void;
  setView: (view: ShellView) => void;
  setStatusMessage: (message: string) => void;
  setNetworkGraph: (graph: NetworkGraphSummary) => void;
  navigateToView: (
    nextView: ShellView,
    options?: { replace?: boolean; mode?: GrogoniMode }
  ) => void;
  loadMarketplaceIntroState: () => Promise<void>;
  validateStoredBusiness: () => Promise<void>;
  accountDeletionIntent: boolean;
  accountRestorationIntent: boolean;
  initialAuthenticationTarget: "signup" | "login" | null;
  initialCountryCode: CountryDialCode;
  initialOwnerAuth: OwnerAuthRecord | null;
  registerReset: (domainKey: string, fn: () => void) => void;
}

export function useAuthState(deps: UseAuthStateDeps) {
  const initialCachedSession = readCachedAuthSession();
  const [authBootstrapState, setAuthBootstrapState] = useState<AuthBootstrapState>(
    initialCachedSession === null ? "initializing" : "offline-authenticated"
  );
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderSummary[]>([]);
  const [oauthProvidersLoaded, setOauthProvidersLoaded] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(
    deps.accountDeletionIntent ||
      deps.accountRestorationIntent ||
      deps.initialAuthenticationTarget !== null
  );
  const [authenticationView, setAuthenticationView] = useState<"signup" | "login">(
    deps.initialAuthenticationTarget ?? (deps.initialOwnerAuth !== null ? "login" : "signup")
  );
  const [isAccountRestorationOpen, setIsAccountRestorationOpen] = useState(
    deps.accountRestorationIntent
  );
  const sessionRefreshInFlightRef = useRef<Promise<SessionResponse | null> | null>(null);
  // One per app instance: tracks whether this account's session context has applied yet.
  const sessionContextRetryRef = useRef(createSessionContextRetry());
  // The place the app was opened at (session-restore-place.ts), kept until a context applies.
  const deepLinkRef = useRef(readDeepLinkedPlace(window.location.pathname));

  const {
    business,
    setBusiness,
    setSession,
    grogoniSessionContext,
    setGrogoniSessionContext,
    setAgentSettings,
    setMode,
    setView,
    setStatusMessage,
    setNetworkGraph,
    navigateToView,
    loadMarketplaceIntroState,
    validateStoredBusiness,
    accountDeletionIntent,
    accountRestorationIntent,
    initialAuthenticationTarget,
    initialCountryCode,
    initialOwnerAuth
  } = deps;

  function forgetRememberedOwnerAuth() {
    localStorage.removeItem(ownerAuthStorageKey);
  }

  async function handleOAuthCallback(): Promise<boolean> {
    if (window.location.pathname !== routes.oauthCallback) {
      return false;
    }

    const parameters = new URLSearchParams(window.location.search);
    const code = parameters.get("code");
    const state = parameters.get("state");
    const pendingOAuth = readPendingOAuthLogin();

    if (code === null || state === null || pendingOAuth === null || state !== pendingOAuth.state) {
      setStatusMessage("Social sign-in could not be verified. Please try again.");
      sessionStorage.removeItem(pendingOAuthStorageKey);
      navigateToBrowserUrl(routes.marketplace, { replace: true });
      return true;
    }

    try {
      const response = await postJson<SessionResponse>("/auth/oauth/callback", {
        provider: pendingOAuth.provider,
        state,
        code,
        csrfToken: pendingOAuth.csrfToken
      });
      sessionStorage.removeItem(pendingOAuthStorageKey);
      navigateToBrowserUrl(routes.marketplace, { replace: true });
      await completeOAuthSession(response, pendingOAuth.provider, pendingOAuth.purpose);
    } catch (error) {
      sessionStorage.removeItem(pendingOAuthStorageKey);
      navigateToBrowserUrl(routes.marketplace, { replace: true });
      setStatusMessage(getErrorMessage(error));
    }

    return true;
  }

  async function loadOAuthProviders() {
    try {
      const response = await getJson<OAuthProvidersResponse>("/auth/oauth/providers");
      setOauthProviders(response.providers);
    } catch {
      setOauthProviders([]);
    } finally {
      setOauthProvidersLoaded(true);
    }
  }

  // A device-only session (progressive-identity.md) is not the identity a visitor on the login or
  // signup screen is asking for, so online it never dismisses that screen; only a real account
  // identity or the visitor (Cancel / Browse as guest) does. Without this, a device-session visitor
  // who tapped Log in, or deep-linked to /login, was bounced back to chat by the next bootstrap.
  // Of the session-acceptance paths, two still close it for a device session: offline restore
  // (login needs the network anyway) and device recovery under a deletion/restoration intent
  // (that panel needs it closed).
  function dismissesAuthScreen(response: SessionResponse): boolean {
    return response.account.identityLevel !== "device";
  }

  function acceptAuthenticatedSession(response: SessionResponse) {
    sessionStorage.removeItem(guestBrowsingStorageKey);
    logAuthenticationLifecycle("session_response_received", response);
    setSession(response);
    saveCachedAuthSession(response);
    logAuthenticationLifecycle("frontend_session_stored", response);
    setAuthBootstrapState("authenticated");
    if (dismissesAuthScreen(response)) setIsAuthOpen(false);
  }

  function completePhoneFirstAuthentication(response: SessionResponse) {
    acceptAuthenticatedSession(response);

    const nextOwnerAuth: OwnerAuthRecord = {
      contact: response.account.primaryAuthDestination,
      countryCode:
        response.account.primaryAuthChannel === "phone"
          ? (inferCountryCode(response.account.primaryAuthDestination) ?? initialCountryCode)
          : initialCountryCode
    };
    localStorage.setItem(ownerAuthStorageKey, JSON.stringify(nextOwnerAuth));
    setIsAuthOpen(false);
    logAuthenticationLifecycle("redirect_issued", response);
    navigateToView("chat", { replace: true, mode: "marketplace" });
    setStatusMessage("Authentication complete");
  }

  async function completeOAuthSession(
    response: SessionResponse,
    provider: SocialSignupProvider,
    purpose: "identity" | "contacts" = "identity"
  ) {
    const selectedProvider = socialSignupProviders.find((item) => item.id === provider);
    acceptAuthenticatedSession(response);
    let networkStatus = "";

    if (provider === "google" && purpose !== "contacts") {
      networkStatus =
        " Google identity linked; contacts remain private until you choose to import them.";
    } else {
      try {
        const graph = await postJson<NetworkGraphSummary>(
          `/network/providers/${encodeURIComponent(provider)}/sync`,
          {}
        );
        setNetworkGraph(graph);
        networkStatus = " Network source connected.";
      } catch (error) {
        networkStatus = ` Network sync needs attention: ${getErrorMessage(error)}`;
      }
    }

    if (business !== null) {
      const roleCheck = await postJson<RoleCheckResponse>("/roles/check", {
        businessId: business.id,
        role: "owner"
      });

      if (!roleCheck.allowed) {
        setStatusMessage("This social profile is not linked to this Grogoni shop yet");
        return;
      }

      const nextOwnerAuth: OwnerAuthRecord = {
        contact: `oauth:${provider}:${response.account.id}`,
        countryCode: initialCountryCode,
        provider
      };
      localStorage.setItem(ownerAuthStorageKey, JSON.stringify(nextOwnerAuth));
      navigateToView("chat", { replace: true });
      setStatusMessage(`${selectedProvider?.label ?? "Social"} login complete.${networkStatus}`);
      return;
    }

    const nextOwnerAuth: OwnerAuthRecord = {
      contact: `oauth:${provider}:${response.account.id}`,
      countryCode: initialCountryCode,
      provider
    };
    localStorage.setItem(ownerAuthStorageKey, JSON.stringify(nextOwnerAuth));
    localStorage.removeItem(setupDraftStorageKey);
    navigateToView("chat", { replace: true, mode: "marketplace" });
    setIsAuthOpen(false);
    setStatusMessage(
      `${selectedProvider?.label ?? "Social"} signup complete. Browse the marketplace or tap Sell to set up a business.${networkStatus}`
    );
  }

  function requireReauthentication(message = "Sign in to continue") {
    const storedBusiness = readStoredBusiness();
    const nextAuthenticationView =
      initialAuthenticationTarget ?? (initialOwnerAuth === null ? "signup" : "login");

    setSession(null);
    clearCachedAuthSession();
    setAuthBootstrapState("reauthentication-required");
    if (storedBusiness === null) setBusiness(null);
    if (!accountDeletionIntent && !accountRestorationIntent) {
      setIsAuthOpen(true);
      setAuthenticationView(nextAuthenticationView);
      window.history.replaceState(
        window.history.state,
        "",
        authenticationRoute(nextAuthenticationView)
      );
      setStatusMessage(message);
    }
  }

  function rejectDefinitiveAuthenticationFailure(error: unknown): boolean {
    if (!isDefinitiveAuthenticationError(error)) return false;
    requireReauthentication("Your session expired. Sign in to continue.");
    return true;
  }

  function ensureAuthenticatedSession(): Promise<SessionResponse | null> {
    if (sessionRefreshInFlightRef.current !== null) return sessionRefreshInFlightRef.current;

    const refresh = performSessionRefresh().finally(() => {
      sessionRefreshInFlightRef.current = null;
    });
    sessionRefreshInFlightRef.current = refresh;
    return refresh;
  }

  const deviceContinueAttemptTtlMs = 10 * 60 * 1000;

  // The one-tap "Continue to Grogoni" idempotency key (docs/authentication/progressive-identity.md):
  // a short-lived bearer retry capability, not an account ID or credential, kept only until the
  // attempt succeeds or this ten-minute window lapses so a relaunch mid-attempt resolves to the
  // same account instead of minting a second one.
  function readDeviceContinueAttemptKey(): string {
    try {
      const raw = localStorage.getItem(deviceContinueAttemptStorageKey);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as { key?: string; createdAt?: string };
        if (
          typeof parsed.key === "string" &&
          typeof parsed.createdAt === "string" &&
          Date.now() - new Date(parsed.createdAt).getTime() < deviceContinueAttemptTtlMs
        ) {
          return parsed.key;
        }
      }
    } catch {
      // Falls through to minting a fresh attempt key below.
    }
    const key =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `continue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(
      deviceContinueAttemptStorageKey,
      JSON.stringify({ key, createdAt: new Date().toISOString() })
    );
    return key;
  }

  /**
   * One-tap device-account entry: a fresh visitor gets a real, cookie-backed session with no
   * phone/email/PIN form, so browsing and chat work immediately. Identity is requested later,
   * progressively, only when an action actually needs it (order/pay/save) - see
   * docs/authentication/progressive-identity.md.
   *
   * For a genuinely fresh visitor (no session cookie at all) the server requires a real device
   * public key - services/api/src/cp2/domains/device-bootstrap/shared.ts's
   * normalizeDeviceRecoveryPublicKey throws 400 device_recovery_key_required on an empty body.
   * prepareDeviceRecoveryCredential/commitDeviceRecoveryCredential already existed for this but
   * had no caller (audit A01, docs/audits/grogoni-home-2026-09-17/audit.md): this was the missing
   * wiring, not a new capability.
   */
  async function continueToGrogoni(): Promise<SessionResponse | null> {
    const idempotencyKey = readDeviceContinueAttemptKey();
    try {
      const { publicKeyJwk } = await prepareDeviceRecoveryCredential();
      const response = await apiFetch<SessionResponse>("/auth/continue", {
        method: "POST",
        body: { devicePublicKeyJwk: publicKeyJwk },
        idempotencyKey
      });
      localStorage.removeItem(deviceContinueAttemptStorageKey);
      if (response.deviceRecoveryCredentialId !== undefined) {
        await commitDeviceRecoveryCredential(response.deviceRecoveryCredentialId);
      }
      logAuthenticationLifecycle("device_account_continued", response);
      acceptAuthenticatedSession(response);
      await loadMarketplaceIntroState();
      await validateStoredBusiness();
      return response;
    } catch (error) {
      if (!isRetryableApiRequestError(error)) {
        localStorage.removeItem(deviceContinueAttemptStorageKey);
      }
      return null;
    }
  }

  async function performSessionRefresh(): Promise<SessionResponse | null> {
    // "offline-authenticated" is an unverified local cache. Once online it must become pending
    // so no server-backed feature can race the canonical bootstrap request.
    setAuthBootstrapState("restoring-session");
    try {
      const nextSession = await apiFetch<AuthBootstrapResponse>("/auth/bootstrap");
      logAuthenticationLifecycle("authenticated_user_loaded", nextSession);
      setSession(nextSession);
      saveCachedAuthSession(nextSession);
      setAuthBootstrapState("authenticated");
      if (!accountDeletionIntent && !accountRestorationIntent && dismissesAuthScreen(nextSession)) {
        setIsAuthOpen(false);
        if (initialAuthenticationTarget !== null) {
          navigateToView("chat", { replace: true, mode: "marketplace" });
        }
      }
      setStatusMessage("Session active");
      await loadMarketplaceIntroState();
      await validateStoredBusiness();
      return nextSession;
    } catch (error) {
      const cached = readCachedAuthSession();
      const storedBusiness = readStoredBusiness();
      if (
        (!navigator.onLine || isExplicitOfflineMode()) &&
        cached !== null &&
        storedBusiness !== null
      ) {
        setSession(cached);
        setBusiness(storedBusiness);
        setAuthBootstrapState("offline-authenticated");
        setIsAuthOpen(false);
        setStatusMessage("Offline workspace restored. Choose Sync in Settings when you are ready.");
        return null;
      }

      const isDefiniteAuthError = isDefinitiveAuthenticationError(error);

      if (isDefiniteAuthError) {
        try {
          const recovered = await recoverDeviceAccount();
          if (recovered !== null) {
            logAuthenticationLifecycle("device_account_recovered", recovered);
            setSession(recovered);
            saveCachedAuthSession(recovered);
            setAuthBootstrapState("authenticated");
            // A deletion/restoration intent's panel renders only once the auth screen is closed.
            if (
              accountDeletionIntent ||
              accountRestorationIntent ||
              dismissesAuthScreen(recovered)
            ) {
              setIsAuthOpen(false);
            }
            setStatusMessage("Grogoni restored this device account.");
            await loadMarketplaceIntroState();
            await validateStoredBusiness();
            return recovered;
          }
        } catch (recoveryError) {
          if (isRetryableApiRequestError(recoveryError)) {
            setAuthBootstrapState("failed");
            setStatusMessage(
              "Grogoni could not restore this device. Check your connection and retry."
            );
            return null;
          }
        }
      }

      // Every non-deliberate cold boot - whether this is a genuinely fresh visitor, a returning
      // one whose session merely expired, or one whose very first /auth/bootstrap call hit a
      // transient network/server error (a cold start, a dropped connection, a 5xx) rather than a
      // definitive "you're not logged in" - gets Grogoni's documented zero-form entry
      // (docs/authentication/progressive-identity.md) instead of a login wall: browsing and chat
      // work immediately on a real, cookie-backed device account, and identity (phone/PIN) is only
      // requested later, when an action actually needs it. Only an explicit deep link to /login or
      // /signup, or an account-deletion/restoration intent, is a deliberate enough request to show
      // that screen instead of the chat shell.
      const isDeliberateAuthFlow =
        initialAuthenticationTarget !== null || accountDeletionIntent || accountRestorationIntent;

      if (!isDeliberateAuthFlow) {
        const continued = await continueToGrogoni();
        if (continued !== null) {
          if (initialOwnerAuth !== null) {
            setStatusMessage(
              storedBusiness !== null
                ? `Welcome back. Log in to restore access to ${storedBusiness.name}.`
                : "Welcome back. Log in to restore your account."
            );
          }
          return continued;
        }
      }

      // Only a deliberate deep link (/login, /signup, or an account-deletion/restoration intent)
      // ever opens the signup/login screen from cold boot now - not a definitive auth failure by
      // itself. A non-deliberate visitor whose session is genuinely invalid and whose zero-form
      // fallback also failed (rate-limited, /auth/continue itself erroring) still belongs in chat,
      // not on a screen they never asked for; they'll be asked to identify themselves later, only
      // when an action actually needs it, per docs/authentication/progressive-identity.md.
      if (isDeliberateAuthFlow) {
        requireReauthentication(
          initialAuthenticationTarget === "signup"
            ? "Create your Grogoni account."
            : "Sign in to continue"
        );
        return null;
      }

      // Not a deliberate auth flow, and even the zero-form fallback above couldn't reach the
      // server: stay on the chat shell (same sessionless state guest browsing already renders)
      // instead of forcing a signup wall nobody asked for.
      if (cached !== null) setSession(cached);
      if (storedBusiness !== null) setBusiness(storedBusiness);
      setAuthBootstrapState("failed");
      setStatusMessage("Grogoni could not restore this session. Check your connection and retry.");
      return null;
    }
  }

  async function refreshSession(): Promise<void> {
    await ensureAuthenticatedSession();
  }

  async function authenticateSocialProfile(
    provider: SocialSignupProvider,
    purpose: "identity" | "contacts" = "identity"
  ) {
    const selectedProvider = socialSignupProviders.find((item) => item.id === provider);
    const providerConfig = oauthProviders.find((item) => item.id === provider);

    if (!oauthProvidersLoaded) {
      setStatusMessage("Social sign-in is still loading. Try again in a moment.");
      return;
    }

    if (providerConfig?.implemented === false || providerConfig?.configured !== true) {
      setStatusMessage("This login provider is not configured yet.");
      return;
    }

    try {
      const response = await postJson<OAuthStartResponse>("/auth/oauth/start", {
        provider,
        purpose,
        redirectUri: `${window.location.origin}${routes.oauthCallback}`
      });
      const pendingOAuth: PendingOAuthLogin = {
        csrfToken: response.csrfToken,
        provider: response.provider,
        purpose,
        state: response.state
      };
      sessionStorage.setItem(pendingOAuthStorageKey, JSON.stringify(pendingOAuth));
      setStatusMessage(
        `Redirecting to ${selectedProvider?.label ?? "social"} to continue with your account.`
      );
      window.location.assign(response.authorizationUrl);
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
    }
  }

  function completeAccountRestoration(result: AccountRestorationResult) {
    const nextBusiness: ActiveBusiness = {
      ...result.business,
      role: result.membership.role
    };
    const nextAgent = createDefaultAgent(nextBusiness);
    setBusiness(nextBusiness);
    setAgentSettings(nextAgent);
    setIsAccountRestorationOpen(false);
    setMode("seller");
    setView("chat");
    localStorage.setItem(activeBusinessStorageKey, JSON.stringify(nextBusiness));
    localStorage.setItem(activeAgentStorageKey, JSON.stringify(nextAgent));
    navigateToOwnerRoute({ mode: "seller", view: "chat" }, { replace: true });
    setStatusMessage("Account restored. Shop access is active again.");
  }

  // Account-authoritative record of where the owner last worked. Device-only state such as model
  // downloads, E2EE private keys, and unsent drafts deliberately stays in browser storage.
  // setActiveConversationId is a call-time argument, not a hook-level dep: it's owned by the Chat
  // domain hook (Phase 16), and this function's only external call site is a still-inline OwnerApp
  // effect that can supply it directly - same pattern used for Sync (Phase 7), Invoices/Logistics
  // (Phase 9), and Runtime history/Network (Phase 16).
  function adoptShop(shop: GrogoniSessionContext["shops"][number]) {
    const nextBusiness: ActiveBusiness = { ...shop.business, role: shop.membership.role };
    const nextAgent = createDefaultAgent(nextBusiness);
    setBusiness(nextBusiness);
    setAgentSettings(nextAgent);
    localStorage.setItem(activeBusinessStorageKey, JSON.stringify(nextBusiness));
    localStorage.setItem(activeAgentStorageKey, JSON.stringify(nextAgent));
  }

  /**
   * Resolves true once the server's context was applied, false when it could not be loaded or a
   * newer load superseded it (shouldApply, from session-context-retry.ts) before it returned.
   *
   * "restore" (sign-in, joining a shop) also restores where the owner last worked: shop, mode,
   * view, conversation and route. On the app's first applied load, a URL that names a place
   * (/sell/shop, a conversation, a module) keeps that place instead and only the data is restored
   * (resolveRestoredPlace in session-restore-place.ts). "refresh" (a retry after a failed
   * restore) applies only the data: by then the user may have moved on from the device cache,
   * and moving them to the server's last place would yank them away. It keeps the current shop
   * when the account still belongs to it and otherwise forgets it, without picking another. A
   * device with no shop at all adopts the account's shop (no navigation), so an owner is never
   * treated as shopless.
   */
  async function loadGrogoniSessionContext(
    setActiveConversationId: (conversationId: string | null) => void,
    shouldApply: () => boolean = () => true,
    apply: "restore" | "refresh" = "restore"
  ): Promise<boolean> {
    try {
      const shopAtStart = readStoredBusiness()?.id ?? null;
      const context = await apiFetch<GrogoniSessionContext>("/v1/session/context");
      if (!shouldApply()) return false;
      const deepLink = deepLinkRef.current;
      deepLinkRef.current = null;
      if (apply === "refresh") {
        const currentShop = readStoredBusiness();
        // The user switched, created or restored a shop while this was in flight: the answer may
        // predate it (and would forget the new shop). Drop it; a later retry fetches fresh data.
        if ((currentShop?.id ?? null) !== shopAtStart) return false;
        setGrogoniSessionContext(context);
        const accountShop =
          context.shops.find((shop) => shop.business.id === context.activeShopId) ??
          context.shops[0];
        if (currentShop === null && accountShop !== undefined) {
          // The restore failed, so this device never learned the account has a shop. Adopt it
          // (data only, no navigation): otherwise Sell would offer an owner a second shop.
          adoptShop(accountShop);
        } else if (
          currentShop !== null &&
          !context.shops.some((shop) => shop.business.id === currentShop.id)
        ) {
          setBusiness(null);
          localStorage.removeItem(activeBusinessStorageKey);
        }
        return true;
      }
      setGrogoniSessionContext(context);
      const activeShop =
        context.shops.find((shop) => shop.business.id === context.activeShopId) ?? context.shops[0];
      const restoredMode =
        context.mode === "seller" && activeShop === undefined ? "marketplace" : context.mode;
      const place = resolveRestoredPlace({
        deepLink,
        currentPath: window.location.pathname,
        hasShop: activeShop !== undefined,
        last: {
          mode: restoredMode,
          view: shellViewForSurface(context.activeSurface, restoredMode),
          conversationId: context.conversationId
        }
      });

      if (activeShop !== undefined) {
        adoptShop(activeShop);
      } else {
        // The account belongs to no shop now (for example removed as staff, or left): forget the
        // shop this device last opened instead of keeping a business it can no longer use.
        setBusiness(null);
        localStorage.removeItem(activeBusinessStorageKey);
      }

      setMode(place.mode);
      setView(place.view);
      if (place.conversationId !== undefined) setActiveConversationId(place.conversationId);
      localStorage.setItem(activeModeStorageKey, place.mode);
      if (place.navigateTo !== null) navigateToOwnerRoute(place.navigateTo, { replace: true });
      return true;
    } catch {
      // Offline launch continues from the device cache; sessionContextRetry retries the load
      // when GrogoniApplication sees a reconnect or the app shown again.
      return false;
    }
  }

  // Restores mode/shop for one specific conversation's own session context (Phase 2 data model),
  // instead of the account-wide default loadGrogoniSessionContext restores on login. Used when
  // switching between an account's own agent sessions so Buy/Sell mode is per-session, not shared.
  async function applySessionContextForConversation(
    conversationId: string
  ): Promise<GrogoniMode | null> {
    try {
      const context = await apiFetch<GrogoniSessionContext>(
        `/v1/session/context?conversationId=${encodeURIComponent(conversationId)}`
      );
      setGrogoniSessionContext(context);
      const activeShop =
        context.shops.find((shop) => shop.business.id === context.activeShopId) ?? context.shops[0];
      const restoredMode =
        context.mode === "seller" && activeShop === undefined ? "marketplace" : context.mode;
      setMode(restoredMode);
      localStorage.setItem(activeModeStorageKey, restoredMode);
      return restoredMode;
    } catch {
      return null;
    }
  }

  async function patchGrogoniSessionContext(patch: {
    mode?: GrogoniMode;
    activeShopId?: string | null;
    activeSurface?: GrogoniChatSurface;
    conversationId?: string;
  }) {
    if (grogoniSessionContext === null) return;
    const accountId = grogoniSessionContext.accountId;
    try {
      const updated = await applySessionContextPatchWithConflictRetry(
        patch,
        grogoniSessionContext.sessionVersion,
        {
          patchContext: (body) => patchJson<GrogoniSessionContext>("/v1/session/context", body),
          fetchLatestContext: () => apiFetch<GrogoniSessionContext>("/v1/session/context"),
          onDropped: (attempts) => {
            logClientEvent("session.context_update_dropped", {
              accountId,
              conversationId: patch.conversationId ?? grogoniSessionContext.conversationId,
              attempts
            });
          }
        }
      );
      if (updated !== null) setGrogoniSessionContext(updated);
    } catch {
      // Offline navigation remains available; the next connected state change retries sync.
    }
  }

  function switchActiveBusiness(shop: AccountShopSummary, options?: { announce?: boolean }) {
    const nextBusiness: ActiveBusiness = { ...shop.business, role: shop.membership.role };
    const nextAgent = createDefaultAgent(nextBusiness);
    setBusiness(nextBusiness);
    setAgentSettings(nextAgent);
    setMode("seller");
    setView("chat");
    localStorage.setItem(activeBusinessStorageKey, JSON.stringify(nextBusiness));
    localStorage.setItem(activeAgentStorageKey, JSON.stringify(nextAgent));
    navigateToOwnerRoute({ mode: "seller", view: "chat" }, { replace: true });
    if (options?.announce !== false) {
      setStatusMessage(`Switched to ${nextBusiness.name}.`);
    }
  }

  // After accepting a staff invitation (StaffInvitationsPrompt): refresh the account's shop list
  // first, then open the shop just joined, so the refresh cannot switch back to the previous one.
  async function joinStaffShop(
    shop: AccountShopSummary,
    setActiveConversationId: (conversationId: string | null) => void
  ) {
    // The user chose this shop: a retry already in flight is superseded (its result is dropped)
    // and retrying ends for this sign-in, so nothing re-applies the server's last shop over the
    // one just joined, even if this load fails or hangs.
    const load = sessionContextRetryRef.current.beginExternalLoad();
    let applied = false;
    try {
      applied = await loadGrogoniSessionContext(setActiveConversationId, load.shouldApply);
    } finally {
      load.settle(applied);
    }
    switchActiveBusiness(shop);
  }

  deps.registerReset("auth", () => {
    setOauthProviders([]);
    setOauthProvidersLoaded(false);
    setIsAuthOpen(false);
    setIsAccountRestorationOpen(false);
    setGrogoniSessionContext(null);
  });

  return {
    sessionContextRetry: sessionContextRetryRef.current,
    authBootstrapState,
    setAuthBootstrapState,
    oauthProviders,
    setOauthProviders,
    oauthProvidersLoaded,
    setOauthProvidersLoaded,
    isAuthOpen,
    setIsAuthOpen,
    authenticationView,
    setAuthenticationView,
    isAccountRestorationOpen,
    setIsAccountRestorationOpen,
    forgetRememberedOwnerAuth,
    handleOAuthCallback,
    loadOAuthProviders,
    acceptAuthenticatedSession,
    continueToGrogoni,
    completePhoneFirstAuthentication,
    completeOAuthSession,
    refreshSession,
    ensureAuthenticatedSession,
    rejectDefinitiveAuthenticationFailure,
    authenticateSocialProfile,
    completeAccountRestoration,
    loadGrogoniSessionContext,
    patchGrogoniSessionContext,
    applySessionContextForConversation,
    switchActiveBusiness,
    joinStaffShop
  };
}
