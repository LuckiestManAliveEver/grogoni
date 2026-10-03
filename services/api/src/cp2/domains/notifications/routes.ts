/**
 * Second domain slice of in-process modularization for services/api/src/cp2/routes.ts (see
 * docs/architecture/routes-modularization-roadmap.md). Smallest route surface (2 routes) after
 * logistics.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BusinessNotificationStatus } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { type Cp2Store, readSessionCookie } from "../../store.js";
import { parseString, sendCp2Error, type BusinessParams } from "../../route-helpers.js";

interface NotificationParams extends BusinessParams {
  notificationId: string;
}

interface NotificationStatusBody {
  status?: string;
}

export function registerNotificationsRoutes(app: FastifyInstance, store: Cp2Store): void {
  app.get(
    "/businesses/:businessId/notifications",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listNotifications({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/notifications/:notificationId",
    async (
      request: FastifyRequest<{ Params: NotificationParams; Body: NotificationStatusBody }>,
      reply
    ) => {
      try {
        return store.updateNotificationStatus({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          notificationId: request.params.notificationId,
          status: parseNotificationStatus(request.body?.status)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

function parseNotificationStatus(value: unknown): BusinessNotificationStatus {
  const status = parseString(value, "status");

  if (status === "unread" || status === "read" || status === "archived") {
    return status;
  }

  throw new Cp2Error(400, "notification_status_invalid", "Notification status is not supported.");
}
