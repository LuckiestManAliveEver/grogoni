import { lazy, Profiler, Suspense, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { AppIcon } from "./AppIcon";
import {
  browserLocationSnapshot,
  installBrowserLinkInterceptor,
  subscribeToBrowserNavigation
} from "./browser-navigation";
import { appRouteModuleKeys, loadLazyModuleWithRecovery } from "./lazy-module-recovery";
import { LazyModuleErrorBoundary } from "./LazyModuleErrorBoundary";
import { recordComponentRender, recordRouteRender } from "./performance";
import {
  matchStorefrontRoute,
  shouldWarmOwnerRoute,
  type StorefrontRoute
} from "./app-route-matching";
import { readAuthenticationRoutePath, readOwnerRoute, routes } from "./routes";
import { isSokoId, normalizeSokoId } from "./sokoid-and-storefront";

const initialPathname = window.location.pathname;
const initialSokoApplicationModule = shouldWarmOwnerRoute(initialPathname)
  ? loadLazyModuleWithRecovery(appRouteModuleKeys.ownerApp, () => import("./SokoApplication"))
  : null;

const TermsOfServicePage = lazy(() =>
  loadLazyModuleWithRecovery(
    appRouteModuleKeys.termsOfService,
    () => import("./legal/TermsOfServicePage")
  )
);
const PrivacyPolicyPage = lazy(() =>
  loadLazyModuleWithRecovery(
    appRouteModuleKeys.privacyPolicy,
    () => import("./legal/PrivacyPolicyPage")
  )
);
const AccountDeletionPage = lazy(() =>
  loadLazyModuleWithRecovery(
    appRouteModuleKeys.accountDeletion,
    () => import("./legal/AccountDeletionPage")
  )
);
const OwnerApp = lazy(() => loadSokoApplication().then((module) => ({ default: module.OwnerApp })));
// Loaded on its own: a storefront visitor chats with a shop without downloading the owner app.
const PublicStorefront = lazy(() =>
  loadLazyModuleWithRecovery(
    appRouteModuleKeys.publicStorefront,
    () => import("./PublicStorefrontChat")
  ).then((module) => ({ default: module.PublicStorefrontChat }))
);

function loadSokoApplication() {
  return (
    initialSokoApplicationModule ??
    loadLazyModuleWithRecovery(appRouteModuleKeys.ownerApp, () => import("./SokoApplication"))
  );
}

export function AppRouter() {
  useSyncExternalStore(
    subscribeToBrowserNavigation,
    browserLocationSnapshot,
    browserLocationSnapshot
  );
  useEffect(() => installBrowserLinkInterceptor(), []);
  const storefrontRoute = readStorefrontRoute();

  if (storefrontRoute !== null) {
    return (
      <LazyRoute
        moduleKey={appRouteModuleKeys.publicStorefront}
        label="This shop"
        page={
          <PublicStorefront
            agentId={storefrontRoute.agentId}
            productId={storefrontRoute.productId}
          />
        }
      />
    );
  }

  if (window.location.pathname === routes.terms) {
    return (
      <LegalRoute
        moduleKey={appRouteModuleKeys.termsOfService}
        label="Terms of Service"
        page={<TermsOfServicePage />}
      />
    );
  }

  if (window.location.pathname === routes.privacy) {
    return (
      <LegalRoute
        moduleKey={appRouteModuleKeys.privacyPolicy}
        label="Privacy Policy"
        page={<PrivacyPolicyPage />}
      />
    );
  }

  if (window.location.pathname === routes.accountDeletion) {
    return (
      <LegalRoute
        moduleKey={appRouteModuleKeys.accountDeletion}
        label="account deletion"
        page={<AccountDeletionPage />}
      />
    );
  }

  if (
    readOwnerRoute(window.location.pathname) === null &&
    readAuthenticationRoutePath(window.location.pathname) === null &&
    window.location.pathname !== routes.oauthCallback
  ) {
    return (
      <main className="legal-placeholder">
        <AppIcon className="route-brand-icon" />
        <h1>Destination unavailable</h1>
        <p>This address does not match a Soko.market page.</p>
        <a href={routes.marketplace}>Return to the marketplace</a>
      </main>
    );
  }

  return (
    <LazyRoute moduleKey={appRouteModuleKeys.ownerApp} label="Soko.market" page={<OwnerApp />} />
  );
}

function LazyRoute({
  moduleKey,
  label,
  page
}: {
  moduleKey: string;
  label: string;
  page: ReactNode;
}) {
  return (
    <Profiler
      id="application-route"
      onRender={(_, phase, actualDuration, baseDuration) => {
        recordComponentRender("application-route", phase, actualDuration, baseDuration);
        recordRouteRender(window.location.pathname);
      }}
    >
      <LazyModuleErrorBoundary moduleKey={moduleKey} label={label}>
        <Suspense
          fallback={
            <main className="legal-placeholder" aria-busy="true">
              <AppIcon className="route-brand-icon" />
              <p>Loading Soko.market…</p>
            </main>
          }
        >
          {page}
        </Suspense>
      </LazyModuleErrorBoundary>
    </Profiler>
  );
}

function LegalRoute({
  moduleKey,
  label,
  page
}: {
  moduleKey: string;
  label: string;
  page: ReactNode;
}) {
  return (
    <LazyModuleErrorBoundary moduleKey={moduleKey} label={label}>
      <Suspense
        fallback={
          <main className="legal-placeholder" aria-busy="true">
            <AppIcon className="route-brand-icon" />
            <p>Loading {label}…</p>
          </main>
        }
      >
        {page}
      </Suspense>
    </LazyModuleErrorBoundary>
  );
}

export function readStorefrontAgentId(): string | null {
  return readStorefrontRoute()?.agentId ?? null;
}

export function readStorefrontRoute(
  pathname: string = window.location.pathname
): StorefrontRoute | null {
  const route = matchStorefrontRoute(pathname);
  if (route === null) return null;

  // /shop/:id, /shops/:id and /soko/:id are aliases: show the canonical /agent/:id address.
  if (!pathname.startsWith("/agent/")) {
    const canonicalAgentId = isSokoId(route.agentId)
      ? normalizeSokoId(route.agentId)
      : route.agentId;
    window.history.replaceState(
      null,
      "",
      `${routes.publicAgent(canonicalAgentId)}${window.location.search}`
    );
  }

  return route;
}
