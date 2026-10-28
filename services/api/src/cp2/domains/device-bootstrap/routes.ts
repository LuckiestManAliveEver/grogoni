/**
 * Fifteenth and final domain slice of in-process modularization for
 * services/api/src/cp2/routes.ts (see docs/architecture/routes-modularization-roadmap.md). Owns
 * `/auth/continue` (one-tap device account creation/restore), `/auth/device/recover`
 * (device-credential account recovery), and `/auth/identity/merge/pin` (merging the current
 * device account into an existing PIN account) - the three routes that call into
 * `domains/device-bootstrap/store.ts`'s `DeviceBootstrapDomain` on the store.ts side
 * (`continueWithDevice`/`recoverWithDeviceCredential`/`mergeCurrentDeviceAccountWithPin`).
 *
 * The roadmap doc flagged this as "medium coupling, shared-closure entanglement" because all
 * three routes also call `store.prepareDeviceSession`/`readDeviceSessionMetadata` and
 * `enforceAuthIpRate`. The first two turned out to be non-issues:
 * `readDeviceSessionMetadata` already lives in `route-helpers.ts` (import like everyone else),
 * and `store.prepareDeviceSession` is a genuine `Cp2Store` method (touches `this.sessions`
 * directly) - ordinary cross-domain store calls, the same pattern every other domain uses.
 *
 * `enforceAuthIpRate` was the one real shared closure: it captured `authAttemptsByIp` from
 * `registerCp2Routes`'s scope and is called by 9 other CORE auth routes besides these 3. Moved to
 * `route-helpers.ts` as a plain function taking `authAttemptsByIp` as an explicit parameter
 * instead of via closure - `registerDeviceBootstrapRoutes` receives the same `Map` instance CORE
 * uses, so rate-limit counters stay shared across both.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Cp2Error } from "../../cp2-error.js";
import {
  type Cp2Store,
  readSessionCookie,
  serializeRefreshCookie,
  serializeSessionCookie
} from "../../store.js";
import {
  enforceAuthIpRate,
  parseAuthChannel,
  parseString,
  readDeviceSessionMetadata,
  readHeader,
  sendCp2Error
} from "../../route-helpers.js";

export function registerDeviceBootstrapRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  authAttemptsByIp: Map<string, number[]>
): void {
  app.post(
    "/auth/continue",
    async (
      request: FastifyRequest<{ Body: { devicePublicKeyJwk?: unknown } | undefined }>,
      reply
    ) => {
      try {
        enforceAuthIpRate(authAttemptsByIp, request, "device_continue", 10);
        const result = store.continueWithDevice({
          sessionId: readSessionCookie(request.headers.cookie),
          idempotencyKey: readHeader(request, "idempotency-key"),
          devicePublicKeyJwk: request.body?.devicePublicKeyJwk
        });
        const { refreshToken, ...session } = result;
        if (refreshToken !== null) {
          store.prepareDeviceSession(session.session.id, readDeviceSessionMetadata(request));
          reply.header("set-cookie", [
            serializeSessionCookie(session.session.id),
            serializeRefreshCookie(refreshToken)
          ]);
        }
        request.log.info(
          {
            event: session.isNewAccount
              ? "auth.device_account_created"
              : "auth.device_account_restored",
            accountId: session.account.id,
            sessionId: session.session.id,
            requestCorrelationId: request.id
          },
          "One-tap Grogoni access completed."
        );
        return session;
      } catch (error) {
        request.log.warn(
          {
            event: "auth.device_continue_failed",
            code: error instanceof Cp2Error ? error.code : "device_continue_failed",
            requestCorrelationId: request.id
          },
          "One-tap Grogoni access failed."
        );
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/device/recover",
    async (
      request: FastifyRequest<{
        Body: { credentialId?: string; nonce?: string; issuedAt?: number; signature?: string };
      }>,
      reply
    ) => {
      try {
        enforceAuthIpRate(authAttemptsByIp, request, "device_recover", 10);
        const result = await store.recoverWithDeviceCredential({
          credentialId: parseString(request.body.credentialId, "credentialId"),
          nonce: parseString(request.body.nonce, "nonce"),
          issuedAt: request.body.issuedAt ?? Number.NaN,
          signature: parseString(request.body.signature, "signature")
        });
        const { refreshToken, ...session } = result;
        store.prepareDeviceSession(session.session.id, readDeviceSessionMetadata(request));
        reply.header("set-cookie", [
          serializeSessionCookie(session.session.id),
          serializeRefreshCookie(refreshToken)
        ]);
        request.log.info(
          {
            event: "auth.device_recovered",
            accountId: session.account.id,
            sessionId: session.session.id,
            requestCorrelationId: request.id
          },
          "Device-bound Grogoni account recovered."
        );
        return session;
      } catch (error) {
        request.log.warn(
          {
            event: "auth.device_recovery_failed",
            code: error instanceof Cp2Error ? error.code : "device_recovery_failed",
            requestCorrelationId: request.id
          },
          "Device-bound Grogoni account recovery failed."
        );
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/identity/merge/pin",
    async (
      request: FastifyRequest<{
        Body: { method?: string; contact?: string; pin?: string };
      }>,
      reply
    ) => {
      try {
        enforceAuthIpRate(authAttemptsByIp, request, "identity_merge_pin", 10);
        const result = store.mergeCurrentDeviceAccountWithPin({
          sessionId: readSessionCookie(request.headers.cookie),
          channel: parseAuthChannel(request.body.method ?? "phone"),
          destination: parseString(request.body.contact, "contact"),
          pin: parseString(request.body.pin, "pin")
        });
        const { refreshToken, ...session } = result;
        store.prepareDeviceSession(session.session.id, readDeviceSessionMetadata(request));
        reply.header("set-cookie", [
          serializeSessionCookie(session.session.id),
          serializeRefreshCookie(refreshToken)
        ]);
        return session;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}
