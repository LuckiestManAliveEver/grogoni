import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { McpAccessScope } from "@grogoni/shared-types";
import { Cp2Error, readSessionCookie, type Cp2Store } from "../cp2/store.js";

const authorizationCodeTtlMs = 5 * 60 * 1_000;
const accessTokenTtlSeconds = 3_600;
const chatGptClientId = "https://chatgpt.com/oauth/client.json";
const chatGptRedirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";

interface PendingAuthorization {
  clientId: string;
  codeChallenge: string;
  expiresAt: number;
  redirectUri: string;
  resource: string;
  scopes: McpAccessScope[];
  sessionId: string;
  state: string;
}

type AuthorizationCode = PendingAuthorization;

export interface McpOAuthOptions {
  publicOrigin: string;
  store: Cp2Store;
  state?: McpOAuthState;
}

export interface McpOAuthState {
  pendingAuthorizations: Map<string, PendingAuthorization>;
  authorizationCodes: Map<string, AuthorizationCode>;
}

export function createMcpOAuthState(): McpOAuthState {
  return { pendingAuthorizations: new Map(), authorizationCodes: new Map() };
}

export function registerMcpOAuthRoutes(app: FastifyInstance, options: McpOAuthOptions): void {
  const publicOrigin = options.publicOrigin.replace(/\/+$/u, "");
  const issuer = publicOrigin;
  const resource = `${publicOrigin}/mcp`;
  const { pendingAuthorizations, authorizationCodes } = options.state ?? createMcpOAuthState();

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body))))
  );

  app.get("/.well-known/oauth-protected-resource", async () => ({
    resource,
    authorization_servers: [issuer],
    scopes_supported: ["mcp:read", "mcp:act"],
    resource_documentation: `${publicOrigin}/privacy`,
    resource_policy_uri: `${publicOrigin}/privacy`,
    resource_tos_uri: `${publicOrigin}/terms`
  }));

  app.get("/.well-known/oauth-authorization-server", async () => ({
    issuer,
    authorization_endpoint: `${publicOrigin}/oauth/authorize`,
    token_endpoint: `${publicOrigin}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp:read", "mcp:act"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true
  }));

  app.get("/oauth/authorize", async (request, reply) => {
    try {
      const query = recordValue(request.query);
      const sessionId = requireGrogoniSession(request, options.store);
      const authorization = validateAuthorizationRequest(query, resource, sessionId);
      pruneExpired(pendingAuthorizations);
      const requestId = randomToken();
      pendingAuthorizations.set(requestId, authorization);
      return reply
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(consentPage(requestId, authorization.scopes));
    } catch (error) {
      return sendAuthorizationError(reply, error, publicOrigin);
    }
  });

  app.get("/oauth/authorize/decision", async (request, reply) => {
    try {
      const query = recordValue(request.query);
      const requestId = requiredParameter(query, "request_id");
      const pending = pendingAuthorizations.get(requestId);
      pendingAuthorizations.delete(requestId);
      if (pending === undefined || pending.expiresAt <= Date.now()) {
        throw new OAuthError("invalid_request", "The authorization request expired.");
      }
      const sessionId = requireGrogoniSession(request, options.store);
      if (sessionId !== pending.sessionId) {
        throw new OAuthError("access_denied", "The Grogoni session changed during authorization.");
      }
      if (query.decision !== "approve") {
        return reply.redirect(authorizationRedirect(pending, { error: "access_denied" }), 302);
      }
      pruneExpired(authorizationCodes);
      const code = randomToken();
      authorizationCodes.set(hashToken(code), pending);
      return reply.redirect(authorizationRedirect(pending, { code }), 302);
    } catch (error) {
      return sendAuthorizationError(reply, error, publicOrigin);
    }
  });

  app.post("/oauth/token", async (request, reply) => {
    try {
      const body = recordValue(request.body);
      if (body.grant_type !== "authorization_code") {
        throw new OAuthError("unsupported_grant_type", "Only authorization_code is supported.");
      }
      const code = requiredParameter(body, "code");
      const grant = authorizationCodes.get(hashToken(code));
      authorizationCodes.delete(hashToken(code));
      if (grant === undefined || grant.expiresAt <= Date.now()) {
        throw new OAuthError("invalid_grant", "The authorization code is invalid or expired.");
      }
      if (
        body.client_id !== grant.clientId ||
        body.redirect_uri !== grant.redirectUri ||
        body.resource !== grant.resource
      ) {
        throw new OAuthError("invalid_grant", "The authorization request binding does not match.");
      }
      const verifier = requiredParameter(body, "code_verifier");
      if (!validPkceVerifier(verifier) || pkceChallenge(verifier) !== grant.codeChallenge) {
        throw new OAuthError("invalid_grant", "PKCE verification failed.");
      }
      const created = options.store.createMcpAccessToken({
        sessionId: grant.sessionId,
        name: "ChatGPT OAuth connection",
        scopes: grant.scopes,
        expiresInSeconds: accessTokenTtlSeconds
      });
      return reply.header("cache-control", "no-store").send({
        access_token: created.accessToken,
        token_type: "Bearer",
        expires_in: accessTokenTtlSeconds,
        scope: grant.scopes.join(" ")
      });
    } catch (error) {
      return sendTokenError(reply, error);
    }
  });

  function validateAuthorizationRequest(
    query: Record<string, unknown>,
    expectedResource: string,
    sessionId: string
  ): PendingAuthorization {
    if (query.response_type !== "code") {
      throw new OAuthError(
        "unsupported_response_type",
        "Only the code response type is supported."
      );
    }
    const clientId = requiredParameter(query, "client_id");
    const redirectUri = requiredParameter(query, "redirect_uri");
    if (clientId !== chatGptClientId || redirectUri !== chatGptRedirectUri) {
      throw new OAuthError("unauthorized_client", "This OAuth client is not authorized.");
    }
    if (query.code_challenge_method !== "S256") {
      throw new OAuthError("invalid_request", "PKCE with S256 is required.");
    }
    const codeChallenge = requiredParameter(query, "code_challenge");
    if (!/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge)) {
      throw new OAuthError("invalid_request", "The PKCE code challenge is invalid.");
    }
    if (query.resource !== expectedResource) {
      throw new OAuthError(
        "invalid_target",
        "The OAuth resource must identify the Grogoni MCP endpoint."
      );
    }
    return {
      clientId,
      redirectUri,
      resource: expectedResource,
      codeChallenge,
      scopes: parseScopes(query.scope),
      state: requiredParameter(query, "state"),
      sessionId,
      expiresAt: Date.now() + authorizationCodeTtlMs
    };
  }
}

export function mcpOAuthChallenge(publicOrigin: string, scope = "mcp:read"): string {
  const origin = publicOrigin.replace(/\/+$/u, "");
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${scope}"`;
}

export function mcpSecuritySchemes(scopes: McpAccessScope[]) {
  return [{ type: "oauth2", scopes }];
}

function requireGrogoniSession(request: FastifyRequest, store: Cp2Store): string {
  const sessionId = readSessionCookie(request.headers.cookie);
  if (store.getSession(sessionId) === null || sessionId === null) {
    throw new OAuthError("login_required", "Sign in to Grogoni before authorizing ChatGPT.");
  }
  return sessionId;
}

function parseScopes(value: unknown): McpAccessScope[] {
  const requested =
    typeof value === "string" && value.trim() !== "" ? value.trim().split(/\s+/u) : ["mcp:read"];
  if (requested.some((scope) => scope !== "mcp:read" && scope !== "mcp:act")) {
    throw new OAuthError("invalid_scope", "Only mcp:read and mcp:act scopes are supported.");
  }
  return [...new Set(requested)] as McpAccessScope[];
}

function authorizationRedirect(
  grant: PendingAuthorization,
  result: { code: string } | { error: string }
): string {
  const redirect = new URL(grant.redirectUri);
  if ("code" in result) redirect.searchParams.set("code", result.code);
  else redirect.searchParams.set("error", result.error);
  redirect.searchParams.set("state", grant.state);
  redirect.searchParams.set("iss", new URL(grant.resource).origin);
  return redirect.toString();
}

function consentPage(requestId: string, scopes: McpAccessScope[]): string {
  const permissions = scopes
    .map((scope) =>
      scope === "mcp:act"
        ? "Propose and confirm changes to your authorized shops"
        : "Read your authorized shops and catalogue"
    )
    .map((label) => `<li>${escapeHtml(label)}</li>`)
    .join("");
  const encodedId = encodeURIComponent(requestId);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize ChatGPT</title><style>body{font-family:system-ui,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1.5rem;color:#18221d}h1{font-size:1.7rem}li{margin:.6rem 0}.actions{display:flex;gap:.75rem;margin-top:2rem}a{padding:.7rem 1rem;border:1px solid #167d5a;color:#126548;text-decoration:none}a.primary{background:#167d5a;color:white}</style></head><body><main><h1>Connect ChatGPT to Grogoni</h1><p>ChatGPT is requesting permission to:</p><ul>${permissions}</ul><p>Business changes still use Grogoni's confirmation controls.</p><div class="actions"><a class="primary" href="/oauth/authorize/decision?request_id=${encodedId}&decision=approve">Allow</a><a href="/oauth/authorize/decision?request_id=${encodedId}&decision=deny">Cancel</a></div></main></body></html>`;
}

function sendAuthorizationError(reply: FastifyReply, error: unknown, publicOrigin: string) {
  if (error instanceof OAuthError) {
    return reply
      .code(error.code === "login_required" ? 401 : 400)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization failed</title></head><body><main><h1>Authorization failed</h1><p>${escapeHtml(error.message)}</p><p><a href="${escapeHtml(publicOrigin)}">Open Grogoni</a></p></main></body></html>`
      );
  }
  throw error;
}

function sendTokenError(reply: FastifyReply, error: unknown) {
  if (error instanceof OAuthError) {
    return reply.code(400).header("cache-control", "no-store").send({
      error: error.code,
      error_description: error.message
    });
  }
  if (error instanceof Cp2Error) {
    return reply.code(error.statusCode === 401 ? 400 : error.statusCode).send({
      error: error.statusCode === 401 ? "invalid_grant" : "invalid_request",
      error_description: error.message
    });
  }
  throw error;
}

class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OAuthError("invalid_request", "The OAuth request is malformed.");
  }
  return value as Record<string, unknown>;
}

function requiredParameter(value: Record<string, unknown>, name: string): string {
  const parameter = value[name];
  if (typeof parameter !== "string" || parameter.trim() === "") {
    throw new OAuthError("invalid_request", `${name} is required.`);
  }
  return parameter;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function validPkceVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/u.test(value);
}

function pruneExpired<T extends { expiresAt: number }>(records: Map<string, T>): void {
  const now = Date.now();
  for (const [key, record] of records) {
    if (record.expiresAt <= now) records.delete(key);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}
