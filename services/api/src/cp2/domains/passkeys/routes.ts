/**
 * Third domain slice of in-process modularization for services/api/src/cp2/routes.ts (see
 * docs/architecture/routes-modularization-roadmap.md). Needs `authRuntime` (computed once in
 * `registerCp2Routes` from env/allowed-origins config) passed in as a parameter, since
 * `passkeyRelyingParty` depends on `authRuntime.passkeysEnabled`/`expectedPasskeyOrigins`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { Cp2Error } from "../../cp2-error.js";
import { type Cp2Store, readSessionCookie } from "../../store.js";
import type { AuthRuntimeConfig } from "../../auth-runtime-config.js";
import {
  parseOptionalString,
  parseString,
  sendCp2Error,
  setAuthSessionCookies
} from "../../route-helpers.js";

interface PasskeyRegistrationVerifyBody {
  ceremonyId?: string;
  label?: string;
  response?: RegistrationResponseJSON;
}

interface PasskeyAuthenticationVerifyBody {
  ceremonyId?: string;
  response?: AuthenticationResponseJSON;
}

interface PasskeyAuthenticationOptionsBody {
  purpose?: string;
}

export function registerPasskeysRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  authRuntime: AuthRuntimeConfig
): void {
  function passkeyRelyingParty(request: FastifyRequest): { origin: string; rpId: string } {
    const origin = request.headers.origin;

    if (
      !authRuntime.passkeysEnabled ||
      origin === undefined ||
      !authRuntime.expectedPasskeyOrigins.has(origin)
    ) {
      throw new Cp2Error(
        403,
        "passkey_origin_not_allowed",
        "Passkeys are not available from this origin."
      );
    }

    const url = new URL(origin);
    const configuredRpId = process.env.WEBAUTHN_RP_ID?.trim();
    const rpId =
      configuredRpId && configuredRpId.length > 0
        ? configuredRpId
        : url.hostname.startsWith("www.")
          ? url.hostname.slice(4)
          : url.hostname;

    return { origin: url.origin, rpId };
  }

  app.post("/auth/passkeys/register/options", async (request, reply) => {
    try {
      const relyingParty = passkeyRelyingParty(request);
      return await store.beginPasskeyRegistration({
        sessionId: readSessionCookie(request.headers.cookie),
        rpId: relyingParty.rpId
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/auth/passkeys/register/verify",
    async (request: FastifyRequest<{ Body: PasskeyRegistrationVerifyBody }>, reply) => {
      try {
        const relyingParty = passkeyRelyingParty(request);
        const label = parseOptionalString(request.body.label);
        return await store.completePasskeyRegistration({
          sessionId: readSessionCookie(request.headers.cookie),
          ceremonyId: parseString(request.body.ceremonyId, "ceremonyId"),
          ...(label === undefined ? {} : { label }),
          origin: relyingParty.origin,
          rpId: relyingParty.rpId,
          response: parsePasskeyResponse<RegistrationResponseJSON>(request.body.response)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/passkeys/login/options",
    async (request: FastifyRequest<{ Body: PasskeyAuthenticationOptionsBody }>, reply) => {
      try {
        const relyingParty = passkeyRelyingParty(request);
        return await store.beginPasskeyAuthentication({
          rpId: relyingParty.rpId,
          purpose: parsePasskeyAuthenticationPurpose(request.body?.purpose)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/passkeys/login/verify",
    async (request: FastifyRequest<{ Body: PasskeyAuthenticationVerifyBody }>, reply) => {
      try {
        const relyingParty = passkeyRelyingParty(request);
        const result = await store.completePasskeyAuthentication({
          ceremonyId: parseString(request.body.ceremonyId, "ceremonyId"),
          origin: relyingParty.origin,
          rpId: relyingParty.rpId,
          response: parsePasskeyResponse<AuthenticationResponseJSON>(request.body.response)
        });
        setAuthSessionCookies(reply, request, store, result.session.id);
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/auth/passkeys", async (request, reply) => {
    try {
      return {
        passkeys: store.listPasskeys({
          sessionId: readSessionCookie(request.headers.cookie)
        })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.patch(
    "/auth/passkeys/:credentialId",
    async (
      request: FastifyRequest<{ Params: { credentialId: string }; Body: { label?: string } }>,
      reply
    ) => {
      try {
        return store.renamePasskey({
          sessionId: readSessionCookie(request.headers.cookie),
          credentialId: parseString(request.params.credentialId, "credentialId"),
          label: parseString(request.body.label, "label")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/auth/passkeys/:credentialId",
    async (request: FastifyRequest<{ Params: { credentialId: string } }>, reply) => {
      try {
        return store.revokePasskey({
          sessionId: readSessionCookie(request.headers.cookie),
          credentialId: parseString(request.params.credentialId, "credentialId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/pin/recover/device",
    async (request: FastifyRequest<{ Body: { pin?: string } }>, reply) => {
      try {
        const result = store.recoverPhoneAccountPinWithDevice({
          sessionId: readSessionCookie(request.headers.cookie),
          pin: parseString(request.body.pin, "pin")
        });
        setAuthSessionCookies(reply, request, store, result.session.id);
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

function parsePasskeyResponse<T>(value: unknown): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Cp2Error(400, "passkey_response_required", "Passkey response is required.");
  }

  return value as T;
}

function parsePasskeyAuthenticationPurpose(value: string | undefined): "login" {
  if (value === undefined || value === "login") {
    return "login";
  }

  throw new Cp2Error(400, "passkey_purpose_invalid", "Passkey purpose is invalid.");
}
