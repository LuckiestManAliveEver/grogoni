/**
 * Trusted-device recovery approval routes. Contract: packages/shared-types/src/recovery-approval.ts.
 *
 * The two browser routes (start, status) run signed out. The four approver routes need the
 * signed-in session of the trusted device. Edge resolves which account to load for each of them
 * in edge-snapshot-scope.ts, by transaction id for status and by the approver's phone otherwise.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type {
  RecoveryApprovalApproveRequest,
  RecoveryApprovalOptionsRequest
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { type Cp2Store, readSessionCookie } from "../../store.js";
import type { AuthRuntimeConfig } from "../../auth-runtime-config.js";
import type { EmailProvider } from "../../email-provider.js";
import {
  enforceAuthIpRate,
  parseString,
  sendCp2Error,
  setAuthSessionCookies
} from "../../route-helpers.js";
import { resolvePasskeyRelyingParty } from "../passkeys/routes.js";
import { approvalClientKey, describeApprovalClient } from "./shared.js";

export function registerRecoveryApprovalRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  authRuntime: AuthRuntimeConfig,
  authAttemptsByIp: Map<string, number[]>,
  emailProvider: EmailProvider
): void {
  app.post(
    "/auth/recovery/device-approval/start",
    async (request: FastifyRequest<{ Body: { identifier?: string } }>, reply) => {
      try {
        enforceAuthIpRate(authAttemptsByIp, request, "recovery_approval_start", 5);
        const started = store.startRecoveryApproval({
          identifier: parseString(request.body?.identifier, "identifier"),
          client: describeApprovalClient(request.headers["user-agent"]),
          clientKey: approvalClientKey([request.headers["x-forwarded-for"]].flat()[0], request.ip)
        });
        request.log.info(
          {
            event: "auth.recovery_approval_requested",
            requestId: started.transactionId,
            requestCorrelationId: request.id
          },
          "Browser asked a trusted device to approve account recovery."
        );
        return started;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/recovery/device-approval/status",
    async (
      request: FastifyRequest<{ Body: { transactionId?: string; pollSecret?: string } }>,
      reply
    ) => {
      try {
        const result = store.recoveryApprovalStatus({
          transactionId: parseString(request.body?.transactionId, "transactionId"),
          pollSecret: parseString(request.body?.pollSecret, "pollSecret")
        });
        if (result.status === "approved") {
          setAuthSessionCookies(reply, request, store, result.session.id);
          await notifyBrowserApprovedByEmail(store, emailProvider, request, result.session.id);
          request.log.info(
            {
              event: "auth.recovery_approval_completed",
              accountId: result.account.id,
              sessionId: result.session.id,
              requestCorrelationId: request.id
            },
            "Browser recovered its account with a trusted device's approval."
          );
        }
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/auth/recovery/device-approval/pending", async (request, reply) => {
    try {
      return store.pendingRecoveryApprovals({
        sessionId: readSessionCookie(request.headers.cookie)
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/auth/recovery/device-approval/options",
    async (request: FastifyRequest<{ Body: Partial<RecoveryApprovalOptionsRequest> }>, reply) => {
      try {
        enforceAuthIpRate(authAttemptsByIp, request, "recovery_approval_options", 10);
        const method = parseMethod(request.body?.method);
        return await store.beginRecoveryApproval({
          sessionId: readSessionCookie(request.headers.cookie),
          code: parseString(request.body?.code, "code"),
          method,
          ...(method === "device"
            ? { credentialId: parseString(request.body?.credentialId, "credentialId") }
            : resolvePasskeyRelyingParty(request, authRuntime))
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/recovery/device-approval/approve",
    async (request: FastifyRequest<{ Body: Partial<RecoveryApprovalApproveRequest> }>, reply) => {
      try {
        enforceAuthIpRate(authAttemptsByIp, request, "recovery_approval_approve", 10);
        const body = (request.body ?? {}) as Record<string, unknown>;
        const sessionId = readSessionCookie(request.headers.cookie);
        const requestId = parseString(body.requestId, "requestId");
        const method = parseMethod(body.method);
        const result =
          method === "device"
            ? await store.approveRecoveryApproval({
                sessionId,
                requestId,
                method,
                credentialId: parseString(body.credentialId, "credentialId"),
                challengeId: parseString(body.challengeId, "challengeId"),
                nonce: parseString(body.nonce, "nonce"),
                issuedAt: parseIssuedAt(body.issuedAt),
                signature: parseString(body.signature, "signature")
              })
            : await store.approveRecoveryApproval({
                sessionId,
                requestId,
                method,
                ceremonyId: parseString(body.ceremonyId, "ceremonyId"),
                response: parseAssertion(body.response),
                ...resolvePasskeyRelyingParty(request, authRuntime)
              });
        request.log.info(
          { event: "auth.recovery_approval_approved", method, requestCorrelationId: request.id },
          "Trusted device approved a browser's account recovery."
        );
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/recovery/device-approval/decline",
    async (request: FastifyRequest<{ Body: { requestId?: string } }>, reply) => {
      try {
        return store.declineRecoveryApproval({
          sessionId: readSessionCookie(request.headers.cookie),
          requestId: parseString(request.body?.requestId, "requestId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

function parseMethod(value: unknown): "device" | "passkey" {
  if (value === "device" || value === "passkey") return value;
  throw new Cp2Error(400, "validation_failed", "method must be device or passkey.");
}

function parseIssuedAt(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new Cp2Error(400, "validation_failed", "issuedAt must be an integer.");
}

function parseAssertion(value: unknown): AuthenticationResponseJSON {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { response?: unknown }).response !== "object"
  )
    throw new Cp2Error(400, "validation_failed", "response must be a passkey assertion.");
  return value as AuthenticationResponseJSON;
}

/** Out-of-band notice to a verified backup email. Delivery failure never fails the login. */
async function notifyBrowserApprovedByEmail(
  store: Cp2Store,
  provider: EmailProvider,
  request: FastifyRequest,
  sessionId: string
): Promise<void> {
  try {
    const to = store.getRecoveryNotificationRecipient(sessionId);
    if (!to) return;
    const outcome = await provider.sendRecoveryNotification?.({
      to,
      sessionId,
      credential: "PIN",
      kind: "browser_approved"
    });
    if (outcome !== "sent")
      request.log.warn(
        { event: "auth.recovery_approval_notice_failed", sessionId },
        "Browser approval notice was not delivered."
      );
  } catch {
    request.log.warn(
      { event: "auth.recovery_approval_notice_failed", sessionId },
      "Browser approval notice was not delivered."
    );
  }
}
