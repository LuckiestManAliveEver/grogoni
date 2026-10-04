import type { FastifyInstance, FastifyRequest } from "fastify";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import type { Cp2Store } from "./cp2/store.js";

// Render sends deploy notifications as Standard Webhooks (https://www.standardwebhooks.com/)
// requests: webhook-id/webhook-timestamp/webhook-signature headers, HMAC-SHA256 over
// "id.timestamp.body" with a whsec_-prefixed base64 secret. `standardwebhooks` is the reference
// implementation for that spec (also used internally by Svix, which Render's docs point to), so
// we lean on it instead of hand-rolling HMAC/timestamp verification.
const deployEndedEventType = "deploy_ended";

interface RenderWebhookPayload {
  type?: string;
  data?: {
    id?: string;
    serviceId?: string;
    serviceName?: string;
    status?: string;
  };
}

export interface RenderDeployWebhookOptions {
  store: Pick<Cp2Store, "broadcastAppUpdateAvailable">;
  signingSecret: string;
  /** Render service names that should trigger an "update available" push. Others are ignored. */
  notifiedServiceNames?: Record<string, string>;
}

const defaultNotifiedServiceNames: Record<string, string> = {
  grogoni: "Grogoni"
};

// Render retries a webhook delivery on any non-2xx response, replaying the identical
// webhook-id. Without this, a slow downstream push provider that causes us to occasionally
// answer late (or Render's own retry policy) would double-notify every subscriber. Capacity and
// TTL are generous relative to Render's real retry window, not tuned for volume.
const dedupeWindowMs = 24 * 60 * 60 * 1000;
const dedupeMaxEntries = 2_000;

export function createDeployWebhookEventDedupe() {
  const seenAt = new Map<string, number>();

  return {
    /** Returns true the first time an event id is seen (within the window); false on replay. */
    admit(eventId: string, now: number): boolean {
      for (const [id, at] of seenAt) {
        if (now - at > dedupeWindowMs) seenAt.delete(id);
      }
      if (seenAt.has(eventId)) return false;
      if (seenAt.size >= dedupeMaxEntries) {
        const oldest = seenAt.keys().next().value;
        if (oldest !== undefined) seenAt.delete(oldest);
      }
      seenAt.set(eventId, now);
      return true;
    }
  };
}

export function registerRenderDeployWebhook(
  app: FastifyInstance,
  options: RenderDeployWebhookOptions
): void {
  const webhook = new Webhook(options.signingSecret);
  const notifiedServiceNames = options.notifiedServiceNames ?? defaultNotifiedServiceNames;
  const dedupe = createDeployWebhookEventDedupe();

  void app.register(async (route) => {
    // Signature verification needs the exact bytes Render sent, so this route (and only this
    // route, thanks to Fastify plugin encapsulation) opts out of JSON body parsing.
    route.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body)
    );

    route.post("/internal/render/deploy-webhook", async (request: FastifyRequest, reply) => {
      const rawBody = request.body as Buffer;
      let parsed: RenderWebhookPayload;
      try {
        const verified = webhook.verify(rawBody, request.headers as Record<string, string>);
        parsed = (verified as RenderWebhookPayload | undefined) ?? {};
      } catch (error) {
        if (error instanceof WebhookVerificationError) {
          return reply.code(401).send({
            code: "render_webhook_signature_invalid",
            message: "Webhook signature verification failed."
          });
        }
        throw error;
      }

      if (parsed.type !== deployEndedEventType || parsed.data?.status !== "succeeded") {
        return reply.code(202).send({ code: "render_webhook_ignored" });
      }

      const serviceName = parsed.data?.serviceName ?? "";
      const serviceLabel = notifiedServiceNames[serviceName];
      if (serviceLabel === undefined) {
        return reply.code(202).send({ code: "render_webhook_service_not_notified" });
      }

      const eventId = parsed.data?.id;
      if (eventId === undefined || eventId.length === 0) {
        return reply.code(400).send({
          code: "render_webhook_event_id_missing",
          message: "Webhook payload is missing data.id."
        });
      }
      if (!dedupe.admit(eventId, Date.now())) {
        return reply.code(202).send({ code: "render_webhook_duplicate" });
      }

      const summary = await options.store.broadcastAppUpdateAvailable({
        deployId: eventId,
        service: serviceName,
        title: "Grogoni update available",
        body: `${serviceLabel} just deployed a new version. Open Grogoni to refresh.`
      });

      request.log.info(
        { event: "render.deploy_webhook_broadcast", serviceName, deployId: eventId, ...summary },
        "Broadcast an app-update push notification after a Render deploy."
      );

      return reply.code(200).send({ code: "render_webhook_processed", ...summary });
    });
  });
}
