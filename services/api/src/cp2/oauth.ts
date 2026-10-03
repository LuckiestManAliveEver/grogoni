import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthProvider } from "@grogoni/shared-types";
import { Cp2Error } from "./store.js";

// Moved to secret-box.ts so non-OAuth credential stores (inference provider keys) share the same
// AES-256-GCM key and envelope format without importing this module's store.ts dependency.
export { decryptOAuthToken, encryptOAuthToken } from "./secret-box.js";

export interface OAuthProviderConfig {
  id: OAuthProvider;
  displayName: string;
  icon: string;
  implemented: boolean;
  enabled: boolean;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string | null;
  scopes: string[];
  pkce: boolean;
  clientIdEnv: string;
  clientSecretEnv: string;
  clientIdEnvAliases?: string[];
  clientSecretEnvAliases?: string[];
  callbackPath: string;
}

export interface PublicOAuthProviderConfig {
  id: OAuthProvider;
  displayName: string;
  icon: string;
  implemented: boolean;
  enabled: boolean;
  authorizationUrl: string;
  callbackPath: string;
  tokenUrl: string;
  userInfoUrl: string | null;
  scopes: string[];
  pkce: boolean;
  configured: boolean;
}

export interface OAuthStartPayload {
  authorizationUrl: string;
  codeChallenge: string;
  codeVerifier: string;
  csrfToken: string;
  redirectUri: string;
  state: string;
}

export interface OAuthTokenResponse {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  tokenType?: string;
  expiresIn?: number;
  scope?: string;
}

export interface OAuthProfile {
  providerSubject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

const oauthProviders: OAuthProviderConfig[] = [
  {
    id: "google",
    displayName: "Google",
    icon: "G",
    implemented: true,
    enabled: false,
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
    pkce: true,
    clientIdEnv: "OAUTH_GOOGLE_CLIENT_ID",
    clientSecretEnv: "OAUTH_GOOGLE_CLIENT_SECRET",
    clientIdEnvAliases: ["GOOGLE_CLIENT_ID"],
    clientSecretEnvAliases: ["GOOGLE_CLIENT_SECRET"],
    callbackPath: "/auth/oauth/callback"
  },
  {
    id: "facebook",
    displayName: "Facebook",
    icon: "M",
    implemented: true,
    enabled: false,
    authorizationUrl: "https://www.facebook.com/v20.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v20.0/oauth/access_token",
    userInfoUrl: "https://graph.facebook.com/me?fields=id,name,email",
    scopes: ["email", "public_profile"],
    pkce: true,
    clientIdEnv: "OAUTH_FACEBOOK_CLIENT_ID",
    clientSecretEnv: "OAUTH_FACEBOOK_CLIENT_SECRET",
    clientIdEnvAliases: ["META_CLIENT_ID", "FACEBOOK_CLIENT_ID"],
    clientSecretEnvAliases: ["META_CLIENT_SECRET", "FACEBOOK_CLIENT_SECRET"],
    callbackPath: "/auth/oauth/callback"
  },
  {
    id: "tiktok",
    displayName: "TikTok",
    icon: "TT",
    implemented: true,
    enabled: false,
    authorizationUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    userInfoUrl:
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name",
    scopes: ["user.info.basic"],
    pkce: true,
    clientIdEnv: "OAUTH_TIKTOK_CLIENT_ID",
    clientSecretEnv: "OAUTH_TIKTOK_CLIENT_SECRET",
    clientIdEnvAliases: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_ID"],
    clientSecretEnvAliases: ["TIKTOK_CLIENT_SECRET"],
    callbackPath: "/auth/oauth/callback"
  },
  {
    id: "apple",
    displayName: "Apple",
    icon: "A",
    implemented: true,
    enabled: false,
    authorizationUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    userInfoUrl: null,
    scopes: ["name", "email"],
    pkce: true,
    clientIdEnv: "OAUTH_APPLE_CLIENT_ID",
    clientSecretEnv: "OAUTH_APPLE_CLIENT_SECRET",
    callbackPath: "/auth/oauth/callback"
  },
  {
    id: "github",
    displayName: "GitHub",
    icon: "GH",
    implemented: true,
    enabled: false,
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    scopes: ["read:user", "user:email"],
    pkce: false,
    clientIdEnv: "OAUTH_GITHUB_CLIENT_ID",
    clientSecretEnv: "OAUTH_GITHUB_CLIENT_SECRET",
    callbackPath: "/auth/oauth/callback"
  },
  {
    id: "microsoft",
    displayName: "Microsoft",
    icon: "M",
    implemented: true,
    enabled: false,
    authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userInfoUrl: "https://graph.microsoft.com/oidc/userinfo",
    scopes: ["openid", "email", "profile", "offline_access"],
    pkce: true,
    clientIdEnv: "OAUTH_MICROSOFT_CLIENT_ID",
    clientSecretEnv: "OAUTH_MICROSOFT_CLIENT_SECRET",
    callbackPath: "/auth/oauth/callback"
  },
  {
    id: "linkedin",
    displayName: "LinkedIn",
    icon: "in",
    implemented: true,
    enabled: false,
    authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    userInfoUrl: "https://api.linkedin.com/v2/userinfo",
    scopes: ["openid", "profile", "email"],
    pkce: true,
    clientIdEnv: "OAUTH_LINKEDIN_CLIENT_ID",
    clientSecretEnv: "OAUTH_LINKEDIN_CLIENT_SECRET",
    clientIdEnvAliases: ["LINKEDIN_CLIENT_ID"],
    clientSecretEnvAliases: ["LINKEDIN_CLIENT_SECRET"],
    callbackPath: "/auth/oauth/callback"
  },
  {
    id: "x",
    displayName: "X",
    icon: "X",
    implemented: true,
    enabled: false,
    authorizationUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    userInfoUrl: "https://api.twitter.com/2/users/me?user.fields=id,name,username",
    scopes: ["users.read", "tweet.read", "offline.access"],
    pkce: true,
    clientIdEnv: "OAUTH_X_CLIENT_ID",
    clientSecretEnv: "OAUTH_X_CLIENT_SECRET",
    clientIdEnvAliases: ["X_CLIENT_ID"],
    clientSecretEnvAliases: ["X_CLIENT_SECRET"],
    callbackPath: "/auth/oauth/callback"
  }
];

export function listOAuthProviders(): PublicOAuthProviderConfig[] {
  return oauthProviders.map((provider) => {
    const enabled = isOAuthProviderEnabled(provider);

    return {
      id: provider.id,
      displayName: provider.displayName,
      icon: provider.icon,
      implemented: provider.implemented,
      enabled,
      authorizationUrl: provider.authorizationUrl,
      callbackPath: provider.callbackPath,
      tokenUrl: provider.tokenUrl,
      userInfoUrl: provider.userInfoUrl,
      scopes: provider.scopes,
      pkce: provider.pkce,
      configured: isOAuthProviderConfigured(provider)
    };
  });
}

export function parseOAuthProvider(value: unknown): OAuthProvider {
  if (
    value === "google" ||
    value === "facebook" ||
    value === "apple" ||
    value === "github" ||
    value === "microsoft" ||
    value === "linkedin" ||
    value === "x" ||
    value === "tiktok"
  ) {
    return value;
  }

  throw new Cp2Error(400, "provider_invalid", "OAuth provider is not supported.");
}

export function getOAuthProviderConfig(provider: OAuthProvider): OAuthProviderConfig {
  const config = oauthProviders.find((item) => item.id === provider);

  if (config === undefined) {
    throw new Cp2Error(400, "provider_invalid", "OAuth provider is not supported.");
  }

  return {
    ...config,
    enabled: isOAuthProviderEnabled(config)
  };
}

export function isOAuthProviderConfigured(provider: OAuthProviderConfig): boolean {
  return (
    isOAuthProviderEnabled(provider) &&
    provider.implemented &&
    getOAuthClientId(provider).length > 0 &&
    getOAuthClientSecret(provider).length > 0
  );
}

export function createOAuthStartPayload(input: {
  provider: OAuthProviderConfig;
  redirectUri: string;
  scopes?: string[];
}): OAuthStartPayload {
  const state = createOpaqueToken();
  const csrfToken = createOpaqueToken();
  const codeVerifier = createOpaqueToken(64);
  const codeChallenge = createCodeChallenge(codeVerifier);
  const url = new URL(input.provider.authorizationUrl);

  url.searchParams.set("client_id", getOAuthClientId(input.provider));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (input.scopes ?? input.provider.scopes).join(" "));
  url.searchParams.set("state", state);

  if (input.provider.pkce) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  if (input.provider.id === "apple") {
    url.searchParams.set("response_mode", "form_post");
  }

  if (input.provider.id === "google" && input.scopes !== undefined) {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("prompt", "consent");
  }

  return {
    authorizationUrl: url.toString(),
    codeChallenge,
    codeVerifier,
    csrfToken,
    redirectUri: input.redirectUri,
    state
  };
}

export async function exchangeOAuthCode(input: {
  provider: OAuthProviderConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OAuthTokenResponse> {
  const clientId = getOAuthClientId(input.provider);
  const clientSecret = getOAuthClientSecret(input.provider);

  if (clientId.length === 0 || clientSecret.length === 0) {
    throw new Cp2Error(503, "oauth_provider_unconfigured", "OAuth provider is not configured.");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri
  });

  if (input.provider.pkce) {
    body.set("code_verifier", input.codeVerifier);
  }

  const response = await fetch(input.provider.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new Cp2Error(401, "oauth_token_exchange_failed", "OAuth token exchange failed.");
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return compactOAuthTokenResponse({
    accessToken: optionalString(payload.access_token),
    refreshToken: optionalString(payload.refresh_token),
    idToken: optionalString(payload.id_token),
    tokenType: optionalString(payload.token_type),
    expiresIn: optionalNumber(payload.expires_in),
    scope: optionalString(payload.scope)
  });
}

export async function fetchOAuthProfile(input: {
  provider: OAuthProviderConfig;
  tokens: OAuthTokenResponse;
}): Promise<OAuthProfile> {
  if (input.provider.userInfoUrl === null) {
    const claims = parseJwtPayload(input.tokens.idToken);
    return normalizeProfile(input.provider.id, claims);
  }

  if (input.tokens.accessToken === undefined) {
    throw new Cp2Error(401, "oauth_access_token_missing", "OAuth access token is missing.");
  }

  const response = await fetch(input.provider.userInfoUrl, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.tokens.accessToken}`,
      "user-agent": "grogoni"
    }
  });

  if (!response.ok) {
    throw new Cp2Error(401, "oauth_profile_failed", "OAuth profile lookup failed.");
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return normalizeProfile(input.provider.id, payload);
}

export function hashOAuthSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertOAuthSecretMatches(actual: string, expectedHash: string, code: string): void {
  const actualHash = Buffer.from(hashOAuthSecret(actual), "hex");
  const expected = Buffer.from(expectedHash, "hex");

  if (actualHash.length !== expected.length || !timingSafeEqual(actualHash, expected)) {
    throw new Cp2Error(401, code, "OAuth session validation failed.");
  }
}

function createOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

function createCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function getOAuthClientId(provider: OAuthProviderConfig): string {
  return getFirstConfiguredEnv([provider.clientIdEnv, ...(provider.clientIdEnvAliases ?? [])]);
}

function getOAuthClientSecret(provider: OAuthProviderConfig): string {
  return getFirstConfiguredEnv([
    provider.clientSecretEnv,
    ...(provider.clientSecretEnvAliases ?? [])
  ]);
}

function isOAuthProviderEnabled(provider: OAuthProviderConfig): boolean {
  const envName = `OAUTH_${provider.id.toUpperCase()}_ENABLED`;
  const value = process.env[envName]?.trim().toLowerCase();

  if (value === undefined || value.length === 0) {
    return provider.enabled;
  }

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  throw new Error(`${envName} must be true or false.`);
}

function getFirstConfiguredEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();

    if (value !== undefined && value.length > 0) {
      return value;
    }
  }

  return "";
}

function parseJwtPayload(idToken: string | undefined): Record<string, unknown> {
  if (idToken === undefined) {
    throw new Cp2Error(401, "oauth_id_token_missing", "OAuth ID token is missing.");
  }

  const payload = idToken.split(".")[1];

  if (payload === undefined) {
    throw new Cp2Error(401, "oauth_id_token_invalid", "OAuth ID token is invalid.");
  }

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function normalizeProfile(provider: OAuthProvider, payload: Record<string, unknown>): OAuthProfile {
  const xData =
    provider === "x" && typeof payload.data === "object" && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : null;
  const tiktokData =
    provider === "tiktok" && typeof payload.data === "object" && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : null;
  const tiktokUser =
    tiktokData !== null && typeof tiktokData.user === "object" && tiktokData.user !== null
      ? (tiktokData.user as Record<string, unknown>)
      : null;
  const subject =
    optionalString(payload.sub) ??
    optionalString(payload.id) ??
    optionalString(payload.userPrincipalName) ??
    (xData === null ? undefined : optionalString(xData.id)) ??
    (tiktokUser === null
      ? undefined
      : (optionalString(tiktokUser.open_id) ?? optionalString(tiktokUser.union_id)));
  const email = optionalString(payload.email) ?? optionalString(payload.mail);
  const displayName =
    optionalString(payload.name) ??
    optionalString(payload.login) ??
    optionalString(payload.preferred_username) ??
    (xData === null ? undefined : optionalString(xData.name)) ??
    (xData === null ? undefined : optionalString(xData.username)) ??
    (tiktokUser === null ? undefined : optionalString(tiktokUser.display_name));
  const emailVerifiedValue = payload.email_verified;

  if (subject === undefined) {
    throw new Cp2Error(401, "oauth_profile_invalid", "OAuth profile is missing a subject.");
  }

  return {
    providerSubject: subject,
    email: email ?? null,
    emailVerified: emailVerifiedValue === true || emailVerifiedValue === "true",
    displayName: displayName ?? null
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactOAuthTokenResponse(input: {
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
  idToken?: string | undefined;
  tokenType?: string | undefined;
  expiresIn?: number | undefined;
  scope?: string | undefined;
}): OAuthTokenResponse {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as OAuthTokenResponse;
}
