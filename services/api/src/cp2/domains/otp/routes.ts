/**
 * Fourteenth domain slice of in-process modularization for services/api/src/cp2/routes.ts (see
 * docs/architecture/routes-modularization-roadmap.md). Owns the 8 `/auth/otp/*` and
 * `/auth/email/*-otp` route aliases (request/verify, each with a bare and `/api`-prefixed path,
 * plus an email-forced variant of each).
 *
 * The roadmap doc flagged this domain as "high coupling, shared-closure entanglement" based on an
 * earlier research pass that assumed the CORE signup/recovery/merge routes
 * (`/auth/email/verification/start`, `/auth/identity/email/start`, `/auth/recovery/start`,
 * `/auth/recovery/verify`, `/auth/identity/email/merge/verify`) called the same
 * `requestOtpForBody`/`verifyOtpForBody` closures as these 8 routes. Re-reading those five CORE
 * routes directly (the "read the method bodies, not just the names" lesson the doc itself
 * flags) showed they actually call `store.requestOtp`/`store.verifyPendingEmail`/
 * `store.verifyEmailIdentityMerge` etc. directly, with their own bespoke orchestration - ordinary
 * cross-domain store-method calls, not a shared-closure dependency. `requestOtpForBody`/
 * `verifyOtpForBody` turned out to have exactly 8 call sites, all inside this file's own routes,
 * so this ships as a clean, fully self-contained extraction with nothing to export back.
 *
 * The two closures captured `store`/`emailProvider` from `registerCp2Routes`'s scope; here they
 * become plain functions taking both as explicit parameters instead, called from
 * `registerOtpRoutes`.
 *
 * `parseAuthChannel` moved to `route-helpers.ts` rather than staying a routes.ts export, since
 * it's genuinely shared with CORE's `/auth/identify`, PIN login, and account-merge routes (9
 * call sites total, only 3 of which are inside this domain) - the same "genuinely shared →
 * route-helpers.ts" home used for `StorefrontParams`/`CustomerParams`/`ContactRecordBody`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthChannel } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { type Cp2Store } from "../../store.js";
import type { EmailProvider } from "../../email-provider.js";
import {
  parseAuthChannel,
  parseString,
  sendCp2Error,
  setAuthSessionCookies
} from "../../route-helpers.js";

interface OtpRequestBody {
  channel?: string;
  contact?: string;
  deliveryChannel?: string;
  destination?: string;
  method?: string;
  purpose?: string;
}

interface OtpVerifyBody {
  challengeId?: string;
  code?: string;
  contact?: string;
  method?: string;
  otp?: string;
}

async function requestOtpForBody(
  store: Cp2Store,
  emailProvider: EmailProvider,
  body: OtpRequestBody
) {
  const channel = parseAuthChannel(body.method ?? body.channel);
  const destination = parseString(body.contact ?? body.destination, "contact");

  if (channel === "phone") {
    throw new Cp2Error(403, "phone_pin_only", "Phone accounts use PIN-only signup and login.");
  }
  parseOtpDeliveryChannel(body.deliveryChannel, channel);
  const purpose = parseOtpPurpose(body.purpose);

  const otp = store.requestOtp({ channel, destination, purpose });

  if (channel === "email") {
    await emailProvider.sendOtp({
      challengeId: otp.challengeId,
      code: otp.devOtp,
      expiresAt: otp.expiresAt,
      to: otp.destination
    });

    if (emailProvider.exposesDevOtp) {
      return otp;
    }

    return {
      challengeId: otp.challengeId,
      destination: otp.destination,
      expiresAt: otp.expiresAt
    };
  }

  return otp;
}

async function verifyOtpForBody(store: Cp2Store, body: OtpVerifyBody) {
  if (body.method !== undefined && parseAuthChannel(body.method) === "phone") {
    throw new Cp2Error(403, "phone_pin_only", "Phone accounts use PIN-only signup and login.");
  }
  const challenge =
    body.challengeId === undefined
      ? store.getOtpChallengeDeliveryByContact({
          channel: parseAuthChannel(body.method),
          destination: parseString(body.contact, "contact")
        })
      : store.getOtpChallengeDelivery(parseString(body.challengeId, "challengeId"));

  if (challenge.channel === "phone") {
    throw new Cp2Error(403, "phone_pin_only", "Phone accounts use PIN-only signup and login.");
  }

  const code = parseString(body.otp ?? body.code, "otp");
  return store.verifyOtp({ challengeId: challenge.challengeId, code });
}

export function registerOtpRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  emailProvider: EmailProvider
): void {
  app.post(
    "/auth/otp/request",
    async (request: FastifyRequest<{ Body: OtpRequestBody }>, reply) => {
      try {
        return await requestOtpForBody(store, emailProvider, request.body);
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/api/auth/otp/request",
    async (request: FastifyRequest<{ Body: OtpRequestBody }>, reply) => {
      try {
        return await requestOtpForBody(store, emailProvider, request.body);
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/email/request-otp",
    async (request: FastifyRequest<{ Body: OtpRequestBody }>, reply) => {
      try {
        return await requestOtpForBody(store, emailProvider, { ...request.body, method: "email" });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/api/auth/email/request-otp",
    async (request: FastifyRequest<{ Body: OtpRequestBody }>, reply) => {
      try {
        return await requestOtpForBody(store, emailProvider, { ...request.body, method: "email" });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post("/auth/otp/verify", async (request: FastifyRequest<{ Body: OtpVerifyBody }>, reply) => {
    try {
      const result = await verifyOtpForBody(store, request.body);
      setAuthSessionCookies(reply, request, store, result.session.id);
      return result;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/api/auth/otp/verify",
    async (request: FastifyRequest<{ Body: OtpVerifyBody }>, reply) => {
      try {
        const result = await verifyOtpForBody(store, request.body);
        setAuthSessionCookies(reply, request, store, result.session.id);
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/email/verify-otp",
    async (request: FastifyRequest<{ Body: OtpVerifyBody }>, reply) => {
      try {
        const result = await verifyOtpForBody(store, { ...request.body, method: "email" });
        setAuthSessionCookies(reply, request, store, result.session.id);
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/api/auth/email/verify-otp",
    async (request: FastifyRequest<{ Body: OtpVerifyBody }>, reply) => {
      try {
        const result = await verifyOtpForBody(store, { ...request.body, method: "email" });
        setAuthSessionCookies(reply, request, store, result.session.id);
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

function parseOtpPurpose(value: string | undefined): "signup" | "recovery" {
  if (value === undefined || value === "signup") {
    return "signup";
  }

  if (value === "recovery") {
    return "recovery";
  }

  throw new Cp2Error(400, "otp_purpose_invalid", "OTP purpose must be signup or recovery.");
}

function parseOtpDeliveryChannel(value: string | undefined, authChannel: AuthChannel): "email" {
  const deliveryChannel = value ?? "email";

  if (authChannel !== "email" || deliveryChannel !== "email") {
    throw new Cp2Error(400, "otp_delivery_channel_invalid", "OTP delivery channel must be email.");
  }

  return "email";
}
