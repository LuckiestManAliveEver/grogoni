import webPush from "web-push";
import type { PushSubscriptionSummary } from "@grogoni/shared-types";
import type { PushNotificationPayload, PushNotificationSender } from "./store.js";

export interface WebPushConfiguration {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function readWebPushConfiguration(): WebPushConfiguration | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = process.env.VAPID_SUBJECT?.trim() ?? "";

  if (!publicKey && !privateKey && !subject) return null;
  if (!publicKey || !privateKey || !subject) {
    throw new Error(
      "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must be configured together."
    );
  }
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new Error("VAPID_SUBJECT must be a mailto: or HTTPS URL.");
  }
  return { publicKey, privateKey, subject };
}

export function createWebPushSender(config: WebPushConfiguration): PushNotificationSender {
  webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return async (subscription: PushSubscriptionSummary, payload: PushNotificationPayload) => {
    try {
      await webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          expirationTime: subscription.expirationTime,
          keys: subscription.keys
        },
        JSON.stringify(payload),
        { TTL: 60 * 60, urgency: "high" }
      );
      return "sent";
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown }).statusCode;
      if (statusCode === 404 || statusCode === 410) return "expired";
      console.error("Web Push delivery failed.", error);
      return "failed";
    }
  };
}
