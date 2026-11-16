import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  parseLinkedWorkerLabel,
  type LinkedWorkerCredentialIssued,
  type LinkedWorkerSummary
} from "@grogoni/shared-types";
import type { Cp2Store } from "../../cp2/store.js";
import { readSessionCookie } from "../../cp2/store.js";
import { Cp2Error } from "../../cp2/cp2-error.js";
import { parseRequestBody, parseString, sendCp2Error } from "../../cp2/route-helpers.js";
import {
  formatLinkedWorkerCredential,
  linkedWorkerSummary,
  type LinkedWorkerRegistry
} from "./worker-registry.js";

/**
 * Owner-only enrollment of remote connector workers (docs/architecture/whatsapp-linked-devices.md,
 * "Remote connector workers"). Every write here is refused during trusted-device recovery
 * probation (services/api/src/cp2/recovery-probation-routes.ts): a credential is lasting access.
 *
 * The credential a worker gets is narrower than the owner's session in every way: it is bound
 * to one business, can only carry that business's WhatsApp transport through the hub (it opens
 * no API route), stops working when the issuing owner loses ownership, and expires.
 */
export interface LinkedWorkerEnrollmentService {
  registry: LinkedWorkerRegistry;
  credentialTtlMs: number;
  /** Closes the worker's live connection on this host (revocation or rotation). */
  disconnectWorker(workerId: string): void;
  /**
   * Logs the business's WhatsApp device out and erases its session, wherever it runs. Revoking
   * a worker does this first: that worker has held the device keys.
   */
  unlinkSession(businessId: string, ownerId: string): Promise<void>;
}

export function registerLinkedWorkerEnrollmentRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  service: () => LinkedWorkerEnrollmentService | undefined
): void {
  type Params = { businessId: string };
  type WorkerParams = Params & { workerId: string };
  const path = "/businesses/:businessId/channels/whatsapp-linked/workers";

  function owner(request: FastifyRequest<{ Params: Params }>) {
    const businessId = parseString(request.params.businessId, "businessId");
    const actor = store.authorizeBusinessPermission({
      sessionId: readSessionCookie(request.headers.cookie),
      businessId,
      permission: "business:read"
    });
    if (actor.role !== "owner")
      throw new Cp2Error(
        403,
        "permission_denied",
        "Only the business owner can manage WhatsApp workers."
      );
    store.validateLinkedWhatsAppOwner(businessId, actor.userId);
    return { businessId, ownerId: actor.userId };
  }
  function enabled(): LinkedWorkerEnrollmentService {
    const current = service();
    if (!current)
      throw new Cp2Error(
        503,
        "whatsapp_linked_workers_unavailable",
        "Remote WhatsApp workers are not enabled on this host."
      );
    return current;
  }
  function workerId(request: FastifyRequest<{ Params: WorkerParams }>) {
    const id = parseString(request.params.workerId, "workerId");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
      throw new Cp2Error(404, "whatsapp_worker_not_found", "WhatsApp worker not found.");
    return id;
  }
  const notFound = () =>
    new Cp2Error(404, "whatsapp_worker_not_found", "WhatsApp worker not found.");

  app.get<{ Params: Params }>(path, async (request, reply) => {
    try {
      const actor = owner(request);
      reply.header("cache-control", "no-store");
      const current = service();
      const workers: LinkedWorkerSummary[] = current
        ? (await current.registry.list(actor.businessId)).map(linkedWorkerSummary)
        : [];
      return { available: current !== undefined, workers };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post<{ Params: Params; Body: unknown }>(path, async (request, reply) => {
    try {
      const actor = owner(request);
      const current = enabled();
      const body = parseRequestBody(request.body);
      if (body.consent !== true)
        throw new Cp2Error(
          400,
          "whatsapp_worker_consent_required",
          "Approve that this worker will hold this business's WhatsApp device credentials."
        );
      const label = parseLinkedWorkerLabel(body.label);
      if (!label)
        throw new Cp2Error(
          400,
          "whatsapp_worker_label_invalid",
          "Name the worker with 1 to 80 letters, numbers, spaces or simple punctuation."
        );
      const issued = await current.registry.enroll({
        businessId: actor.businessId,
        ownerId: actor.ownerId,
        label,
        ttlMs: current.credentialTtlMs
      });
      request.log.info(
        {
          event: "whatsapp_linked.worker_enrolled",
          businessId: actor.businessId,
          workerId: issued.record.id
        },
        "WhatsApp worker enrolled."
      );
      reply.header("cache-control", "no-store");
      reply.code(201);
      return {
        worker: linkedWorkerSummary(issued.record),
        credential: formatLinkedWorkerCredential(issued.record.id, issued.secret)
      } satisfies LinkedWorkerCredentialIssued;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post<{ Params: WorkerParams }>(`${path}/:workerId/rotate`, async (request, reply) => {
    try {
      const actor = owner(request);
      const current = enabled();
      const id = workerId(request);
      const issued = await current.registry.rotate({
        businessId: actor.businessId,
        workerId: id,
        ownerId: actor.ownerId,
        ttlMs: current.credentialTtlMs
      });
      if (!issued) throw notFound();
      // The old secret stopped verifying with the update; drop its live connection too.
      current.disconnectWorker(id);
      request.log.info(
        { event: "whatsapp_linked.worker_rotated", businessId: actor.businessId, workerId: id },
        "WhatsApp worker credential rotated."
      );
      reply.header("cache-control", "no-store");
      return {
        worker: linkedWorkerSummary(issued.record),
        credential: formatLinkedWorkerCredential(id, issued.secret)
      } satisfies LinkedWorkerCredentialIssued;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.delete<{ Params: WorkerParams }>(`${path}/:workerId`, async (request, reply) => {
    try {
      const actor = owner(request);
      const current = enabled();
      const id = workerId(request);
      const existing = (await current.registry.list(actor.businessId)).find(
        (record) => record.id === id
      );
      if (!existing) throw notFound();
      if (existing.status === "active") {
        // Unlink first, while the worker can still deliver WhatsApp's logout. Local erasure
        // happens even when that fails, so the session never quietly moves to another host.
        try {
          await current.unlinkSession(actor.businessId, actor.ownerId);
        } catch {
          throw new Cp2Error(
            503,
            "whatsapp_linked_unavailable",
            "The WhatsApp session could not be unlinked right now. Try again shortly.",
            true
          );
        }
      }
      const revoked = await current.registry.revoke(actor.businessId, id);
      if (!revoked) throw notFound();
      current.disconnectWorker(id);
      request.log.info(
        { event: "whatsapp_linked.worker_revoked", businessId: actor.businessId, workerId: id },
        "WhatsApp worker revoked."
      );
      reply.header("cache-control", "no-store");
      return { worker: linkedWorkerSummary(revoked) };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
}
