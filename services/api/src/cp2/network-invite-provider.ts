import { createHmac } from "node:crypto";
import type { NetworkInviteSender } from "./store.js";

export function createNetworkInviteSenderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): NetworkInviteSender | undefined {
  const endpoint = environment.NETWORK_INVITE_WEBHOOK_URL?.trim();
  const secret = environment.NETWORK_INVITE_WEBHOOK_SECRET?.trim();
  if (!endpoint && !secret) return undefined;
  if (!endpoint || !secret || secret.length < 32) {
    throw new Error(
      "NETWORK_INVITE_WEBHOOK_URL and a 32-character NETWORK_INVITE_WEBHOOK_SECRET must be configured together."
    );
  }

  const url = new URL(endpoint);
  const localDevelopmentUrl =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !localDevelopmentUrl) {
    throw new Error("NETWORK_INVITE_WEBHOOK_URL must use HTTPS.");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("NETWORK_INVITE_WEBHOOK_URL must not contain credentials or a fragment.");
  }

  return createSignedNetworkInviteSender(url.toString(), secret);
}

export function createSignedNetworkInviteSender(
  endpoint: string,
  secret: string
): NetworkInviteSender {
  return async (input) => {
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
      schemaVersion: 1,
      event: "network.invite.requested",
      invite: input
    });
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": input.inviteId,
          "x-grogoni-invite-signature": `sha256=${signature}`,
          "x-grogoni-invite-timestamp": timestamp
        },
        body,
        signal: AbortSignal.timeout(15_000)
      });
      return response.ok
        ? { status: "sent" }
        : { status: "failed", failureReason: `delivery_http_${response.status}` };
    } catch {
      return { status: "failed", failureReason: "delivery_unavailable" };
    }
  };
}
