/**
 * First slice of in-process modularization for services/api/src/cp2/routes.ts (see
 * docs/architecture/routes-modularization-roadmap.md), split out before any per-domain route
 * file existed - the same "move-it-out-first" reasoning that produced cp2-error.ts and
 * text-normalization.ts on the store.ts side. These are generic, domain-agnostic request-parsing
 * and error-response helpers used across nearly every route (sendCp2Error alone is called from
 * ~250 of the file's 307 route handlers); every future domain route file imports from here
 * instead of from routes.ts, avoiding a circular import back into the file being split apart.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthChannel } from "@grogoni/shared-types";
import { Cp2Error } from "./cp2-error.js";
import {
  type Cp2Store,
  type DeviceSessionMetadata,
  serializeRefreshCookie,
  serializeSessionCookie
} from "./store.js";

/** Nearly every business-scoped route's `Params` type extends this. */
export interface BusinessParams {
  businessId: string;
}

/** Shared between suppliers, sales/customers, and the sync-queue mutation-replay dispatcher. */
export interface ContactRecordBody {
  name?: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
}

/** Shared between CORE's getPublicStorefront and the sales/messaging public-storefront routes. */
export interface StorefrontParams {
  agentId: string;
}

/** Shared between sales customer routes and messaging's channel-link-grant route. */
export interface CustomerParams extends BusinessParams {
  customerId: string;
}

export function parseRequestBody(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new Cp2Error(400, "body_invalid", "Request body must be a JSON object.");
  }

  return value as Record<string, unknown>;
}

export function parseString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Cp2Error(400, `${name}_required`, `${name} is required.`);
  }

  return value.trim();
}

export function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Cp2Error(400, "value_invalid", "Expected a string value.");
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function parseNullableString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Cp2Error(400, "value_invalid", "Expected a string value.");
  }

  return value;
}

export function parseStringArray(value: unknown, name: string, maximumItems: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Cp2Error(400, `${name}_invalid`, `${name} is invalid.`);
  }
  return value.map((item, index) => parseString(item, `${name}[${index}]`));
}

export function parseNumber(value: unknown, name: string): number {
  if (typeof value !== "number") {
    throw new Cp2Error(400, `${name}_required`, `${name} is required.`);
  }

  return value;
}

export function parseNullableNumber(value: unknown, name: string): number | null {
  if (value === null) {
    return null;
  }

  return parseNumber(value, name);
}

export function parsePositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new Cp2Error(400, `${name}_invalid`, `${name} must be a positive integer.`);
  }

  return value;
}

export function parseNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw new Cp2Error(400, `${name}_invalid`, `${name} must be a non-negative integer.`);
  }

  return value;
}

export function parseOptionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : parseNonNegativeInteger(value, name);
}

export function parseIntegerString(value: string, name: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Cp2Error(400, `${name}_invalid`, `${name} must be a positive integer.`);
  }

  return parsed;
}

export function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Cp2Error(400, `${name}_invalid`, `${name} must be a boolean.`);
  }

  return value;
}

export function parseIsoTimestamp(value: unknown, name: string): string {
  const timestamp = parseString(value, name);

  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Cp2Error(400, `${name}_invalid`, `${name} must be an ISO timestamp.`);
  }

  return timestamp;
}

/** Shared between CORE's auth routes (identify, PIN login, merge) and the OTP domain. */
export function parseAuthChannel(value: string | undefined): AuthChannel {
  if (value === "email" || value === "phone") {
    return value;
  }

  throw new Cp2Error(400, "channel_invalid", "Auth channel must be email or phone.");
}

export function parseContactRecordBody(body: ContactRecordBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    name: parseString(record.name, "name"),
    phone: parseNullableString(record.phone),
    email: parseNullableString(record.email),
    notes: parseNullableString(record.notes)
  };
}

export function sendCp2Error(reply: FastifyReply, error: unknown) {
  if (error instanceof Cp2Error) {
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
      ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
      ...(error.details === undefined ? {} : { details: error.details })
    });
  }

  throw error;
}

export function readHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readDeviceSessionMetadata(request: FastifyRequest): DeviceSessionMetadata {
  return {
    deviceId: readHeader(request, "x-grogoni-device-id") ?? "unknown-device",
    deviceName: readHeader(request, "x-grogoni-device-name") ?? "This device",
    platform: readHeader(request, "x-grogoni-platform") ?? "unknown",
    browserOrApp: readHeader(request, "x-grogoni-client") ?? "web",
    userAgent: request.headers["user-agent"] ?? ""
  };
}

/** Sets the session+refresh cookies after any login/signup/session-issuing flow completes. */
export function setAuthSessionCookies(
  reply: FastifyReply,
  request: FastifyRequest,
  store: Cp2Store,
  sessionId: string
): void {
  store.prepareDeviceSession(sessionId, readDeviceSessionMetadata(request));
  reply.header("set-cookie", [
    serializeSessionCookie(sessionId),
    serializeRefreshCookie(store.consumeSessionRefreshToken(sessionId))
  ]);
}

/**
 * Shared between CORE's signup/identity/password/recovery/PIN auth routes and the
 * device-bootstrap domain's routes - `authAttemptsByIp` is created once in `registerCp2Routes`'s
 * scope and passed explicitly rather than captured by closure, so both CORE and the domain file
 * can call it.
 */
export function enforceAuthIpRate(
  authAttemptsByIp: Map<string, number[]>,
  request: FastifyRequest,
  purpose: string,
  maximum: number
): void {
  const now = Date.now();
  const key = `${purpose}:${request.ip}`;
  const attempts = (authAttemptsByIp.get(key) ?? []).filter(
    (attemptedAt) => attemptedAt > now - 10 * 60_000
  );
  if (attempts.length >= maximum) {
    throw new Cp2Error(429, "auth_rate_limited", "Too many attempts. Please try again later.");
  }
  attempts.push(now);
  authAttemptsByIp.set(key, attempts);
  if (authAttemptsByIp.size > 10_000) {
    const oldest = authAttemptsByIp.keys().next().value;
    if (oldest !== undefined) authAttemptsByIp.delete(oldest);
  }
}
