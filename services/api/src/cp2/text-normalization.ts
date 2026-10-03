/**
 * Split out of store.ts (same reasoning as cp2-error.ts) so domain modules can validate text
 * fields without a circular value-import back into store.ts. These are generic, stateless string
 * validators used across many domains, not commerce-specific - kept here rather than in a
 * commerce-only shared module.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AccountSummary, SupportedLanguage } from "@grogoni/shared-types";
import { Cp2Error } from "./cp2-error.js";

/**
 * Re-exported (not redefined) from @grogoni/shared-types so the web app can derive the same
 * commerce address from a grogoniId it already has, without an extra API round trip, and without a
 * second copy of this logic drifting from this one.
 */
export {
  commerceAddressFromGrogoniId,
  normalizeCommerceAddress,
  grogoniIdFromCommerceAddress
} from "@grogoni/shared-types";

export function normalizeRequiredBoundedText(
  value: string,
  label: string,
  maximumLength: number
): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Cp2Error(400, `${label.replaceAll(" ", "_")}_required`, `${label} is required.`);
  }
  if (normalized.length > maximumLength) {
    throw new Cp2Error(
      400,
      `${label.replaceAll(" ", "_")}_too_long`,
      `${label} must be ${maximumLength} characters or fewer.`
    );
  }
  return normalized;
}

export function normalizeOptionalBoundedText(
  value: string | null,
  maximumLength: number
): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > maximumLength) {
    throw new Cp2Error(
      400,
      "value_too_long",
      `Value must be ${maximumLength} characters or fewer.`
    );
  }
  return normalized;
}

export function normalizeStorefrontLookupId(value: string): string {
  return value.trim().toLowerCase();
}

export function isGrogoniStorefrontId(value: string): boolean {
  return /^grogoni\.[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/iu.test(value.trim());
}

/**
 * Reserved handles a store may never claim, whether via initial generation or the rename flow
 * (docs/architecture/grogoni-id-slug-system.md). Derived from what's actually in this monorepo today
 * - not a guessed list - so a change to real routing does not silently drift out of sync with
 * this constant:
 *   - `api` (services/api's own domain, render.yaml:23 `grogoni`) and `www` (an origin this
 *     app already treats as canonical - see WEB_ORIGINS/AUTH_ALLOWED_REDIRECT_ORIGINS in
 *     render.yaml/.env.example - even though no literal `www.grogoni.com` Render domain exists yet).
 *   - Every top-level API path segment (grep `app.(get|post|put|delete|patch)("/<segment>`,
 *     services/api/src/cp2/routes.ts / app.ts): auth, account, account-restoration, businesses,
 *     logout, logout-all, roles, session, sessions, v1.
 *   - Every top-level PWA route segment (apps/web/src/routes.ts): chat, marketplace, sell,
 *     workspace, catalogue, products, shops, agent, agents, customers, suppliers, pos, invoices,
 *     network, sync, runtime, payments, receipts, logistics, settings, beta, launch, reports,
 *     notifications, signup, login, account-deletion, terms, privacy.
 *   - `s`: the universal short-link prefix this same phase adds (`GET /s/:slug`) - a store must
 *     never be able to claim the handle that would collide with that route itself.
 *   - Generic infra/product conventions with no literal owner in this repo yet, but real enough
 *     that a store claiming them would be confusing or actively break something the moment they
 *     are wired up: admin, app, assets, cdn, docs, help, mail, staging, status, support.
 */
export const reservedGrogoniHandles: ReadonlySet<string> = new Set([
  "api",
  "www",
  "auth",
  "account",
  "account-restoration",
  "businesses",
  "logout",
  "logout-all",
  "roles",
  "session",
  "sessions",
  "v1",
  "chat",
  "marketplace",
  "sell",
  "workspace",
  "catalogue",
  "products",
  "shops",
  "agent",
  "agents",
  "customers",
  "suppliers",
  "pos",
  "invoices",
  "network",
  "sync",
  "runtime",
  "payments",
  "receipts",
  "logistics",
  "settings",
  "beta",
  "launch",
  "reports",
  "notifications",
  "signup",
  "login",
  "account-deletion",
  "terms",
  "privacy",
  "s",
  "admin",
  "app",
  "assets",
  "cdn",
  "docs",
  "help",
  "mail",
  "staging",
  "status",
  "support"
]);

export function isReservedGrogoniHandle(handle: string): boolean {
  return reservedGrogoniHandles.has(handle.trim().toLowerCase());
}

/** DNS label / Telegram `start` param minimum this repo treats as a usable handle - below this,
 *  callers fall back to a generated base (see Cp2Store.createGlobalShopId). */
export const minimumGrogoniHandleLength = 2;

/** DNS label maximum (RFC 1035) - documented here as the ceiling any handle must respect to also
 *  work as a `{handle}.grogoni.com` subdomain label. `createGrogoniHandle`'s own auto-generation cap
 *  below (48) already sits comfortably under this and is left unchanged - this constant exists for
 *  the rename flow, where a merchant-supplied custom handle is validated against the real DNS
 *  limit rather than the more conservative auto-generation cap. */
export const maximumGrogoniHandleLength = 63;

export function createGrogoniHandle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLowerCase()
    .replace(/[’']/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/gu, "");
}

export function destinationAccountKey(
  channel: AccountSummary["primaryAuthChannel"],
  destination: string
): string {
  return `${channel}:${destination}`;
}

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return value === "en" || value === "sw";
}

export function readBoundedSecurityInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const configured = process.env[name]?.trim();
  if (configured === undefined || configured.length === 0) return fallback;
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

/** Shared between the OAuth domain (`beginOAuthSession`) and OTP challenges (`requestOtp`). */
export const otpTtlMs = 5 * 60 * 1000;

/**
 * Shared between the OTP-request rate limiter (`otpRequestHistory`, in the OTP domain) and the
 * failed-PIN-attempt tracker (`failedPinAttempts`, which stays on `Cp2Store` as core-kernel
 * state) - both are bounded in-memory `Map`s evicting their oldest entry at this same capacity.
 */
export const pinAttemptTrackerMaximumEntries = 10_000;

/**
 * Shared between the OTP domain (`requestOtp`/`verifyOtp`) and three `Cp2Store` methods
 * (`verifyEmailRecovery`, `verifyEmailIdentityMerge`, `verifyPendingEmail`) that validate an OTP
 * code against an `otpChallenges` record with their own inlined checks rather than going through
 * the OTP domain's `validateOtpChallenge`/`completeOtpVerification`.
 */
export function hashOtp(challengeId: string, code: string): string {
  return createHmac("sha256", otpHmacSecret()).update(`${challengeId}:${code}`).digest("hex");
}

export function otpHmacSecret(): string {
  const configured = process.env.OTP_HMAC_SECRET?.trim();
  if (configured !== undefined && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Cp2Error(
      503,
      "otp_secret_unconfigured",
      "Verification codes are temporarily unavailable."
    );
  }
  return "grogoni-local-otp-hmac-secret";
}

/**
 * Generic constant-time hex-digest comparison. Shared between the OTP domain and the legacy
 * SHA-256 PIN-hash fallback comparison on `Cp2Store` (`resolvePinHashOutcome`), so it lives here
 * rather than in either domain's own `shared.ts`.
 */
export function hashMatches(actual: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
