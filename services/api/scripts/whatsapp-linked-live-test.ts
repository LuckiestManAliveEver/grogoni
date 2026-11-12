/** Explicit account-owner certification helper. No OTP collection or existing credentials.
 * Pairing codes are displayed once for the owner's approval, never written to a log file.
 * The temporary linked device is logged out after restoration verification (or timeout).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { buildApi } from "../src/app.js";
import { createCp2Store } from "../src/cp2/store.js";
import { createLinkedDaemonTestHost } from "./linked-daemon-test-host.js";
import {
  baileysLinkedDriver,
  createBaileysLinkedDriver
} from "../src/messaging/whatsapp-linked/baileys-driver.js";

const phone = process.argv.find((arg) => arg.startsWith("--authorize-phone="))?.split("=")[1];
const contact = process.argv.find((arg) => arg.startsWith("--authorize-contact="))?.split("=")[1];
const authorizeAiReply = process.argv.includes("--authorize-ai-reply");
if (authorizeAiReply && !contact)
  throw new Error("An explicitly approved test contact is required.");
if (contact && !/^[1-9][0-9]{6,14}$/.test(contact))
  throw new Error("The authorized contact must include its country code.");
if (!phone || !/^[1-9][0-9]{6,14}$/.test(phone))
  throw new Error(
    "Explicit account-owner authorization is required: --authorize-phone=<country-code-and-number>"
  );
process.env.NODE_ENV = "development";
process.env.WHATSAPP_LINKED_ENABLED = "true";
const sessionRoot = mkdtempSync(join(tmpdir(), "grogoni-wa-certification-"));
process.env.WHATSAPP_LINKED_SESSION_DIR = sessionRoot;
process.env.WHATSAPP_LINKED_SESSION_KEY = randomBytes(32).toString("hex");
delete process.env.WHATSAPP_LINKED_DAEMON_URL; // Pairing certification never enables automatic messages.
const daemonHost = authorizeAiReply ? await createLinkedDaemonTestHost() : undefined;
if (daemonHost) {
  process.env.WHATSAPP_LINKED_DAEMON_URL = daemonHost.base;
  process.env.DAEMON_SERVICE_TOKEN = daemonHost.token;
  process.env.DAEMON_ALLOW_LOCAL_API = "true";
}
let deliveryWindowReady = false;
let acceptedAiInbound = false;
let outboundAttempts = 0;
let outboundAcks = 0;
let diagnosticCount = 0;
const diagnostic = (event: { type: string; count?: number; addressing?: string }) => {
  if (diagnosticCount++ < 30)
    console.log(JSON.stringify({ event: "protocol_diagnostic", ...event }));
};
let diagnosticDriver = createBaileysLinkedDriver(diagnostic);
let reloadRequested = false;
process.stdin.on("data", (chunk: Buffer) => {
  if (chunk.toString("utf8").trim() === "reload") reloadRequested = true;
});
baileysLinkedDriver.open = async (input) => {
  const socket = await diagnosticDriver.open({
    ...input,
    expectedPhone: phone,
    approvedContacts: () => (contact ? [`${contact}@s.whatsapp.net`] : []),
    inbound: (message) => {
      if (authorizeAiReply && deliveryWindowReady && message.chat === `${contact}@s.whatsapp.net`) {
        if (acceptedAiInbound) return;
        acceptedAiInbound = true;
      }
      if (diagnosticCount++ < 30)
        console.log(
          JSON.stringify({
            event: "protocol_scope_check",
            authorizedChat: message.chat === `${contact}@s.whatsapp.net`
          })
        );
      input.inbound(message);
    }
  });
  return {
    ...socket,
    send: async (chat, text, id) => {
      if (chat !== `${contact}@s.whatsapp.net` || outboundAttempts >= 1)
        throw new Error("Only one send to the explicitly approved test contact is allowed.");
      outboundAttempts++;
      const result = await socket.send(chat, text, id);
      outboundAcks++;
      return result;
    }
  };
};
let store = createCp2Store();

let app = buildApi({ cp2: { store } });
app.log.level = "silent";
let cookie = "";
let path = "";
async function post(url: string, payload: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url,
    headers: cookie ? { cookie } : {},
    payload
  });
  if (response.statusCode !== 200)
    throw new Error(
      `Certification request failed (${response.statusCode}, ${response.json().code ?? "unknown"}).`
    );
  return response;
}
async function status() {
  const response = await app.inject({ method: "GET", url: path, headers: { cookie } });
  if (response.statusCode !== 200) throw new Error("Cannot read certification connection state.");
  return response.json() as { state: string; pairingCode: string | null };
}
try {
  const signup = await post("/auth/pin/signup", {
    method: "phone",
    contact: "254700000991",
    pin: String(randomInt(1000, 10000))
  });
  const header = signup.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header[0]! : header!).split(";")[0]!;
  const business = (
    await post("/businesses", { name: "Temporary WhatsApp certification", language: "en" })
  ).json().business;
  path = `/businesses/${business.id}/channels/whatsapp-linked`;
  const pairing = (await post(`${path}/connect`, { consent: true, phone })).json();
  // This is the deliberate device-code display to the approving owner, not protocol logging.
  console.log(
    JSON.stringify({
      event: "owner_approval_required",
      pairingCode: pairing.pairingCode,
      expiresAt: pairing.expiresAt
    })
  );
  async function awaitConnected() {
    const until = Date.now() + 150_000;
    while (Date.now() < until) {
      const current = await status();
      if (current.state === "CONNECTED") return;
      if (["AUTH_REQUIRED", "REVOKED", "ERROR"].includes(current.state))
        throw new Error(`Connection state: ${current.state}`);
      await delay(1000);
    }
    throw new Error("Owner approval or restoration timed out.");
  }
  await awaitConnected();
  console.log(JSON.stringify({ event: "live_pairing_verified" }));
  const snapshot = store.snapshot();
  await app.close();
  store = createCp2Store();
  store.hydrateSnapshot(snapshot);
  app = buildApi({ cp2: { store } });
  app.log.level = "silent";
  await app.ready();
  await awaitConnected();
  console.log(JSON.stringify({ event: "live_session_restoration_verified" }));
  if (contact) {
    const chat = `${contact}@s.whatsapp.net`;
    await post(`${path}/scopes`, { chat, approved: true, automation: authorizeAiReply });
    deliveryWindowReady = true;
    console.log(JSON.stringify({ event: "awaiting_authorized_test_message", timeoutSeconds: 300 }));
    const until = Date.now() + 300_000;
    let delivered = false;
    let inboundReported = false;
    while (Date.now() < until) {
      if (reloadRequested) {
        reloadRequested = false;
        const snapshot = store.snapshot();
        await app.close();
        const refreshed = await import(
          new URL(
            `../src/messaging/whatsapp-linked/baileys-driver.ts?reload=${Date.now()}`,
            import.meta.url
          ).href
        );
        diagnosticDriver = refreshed.createBaileysLinkedDriver(diagnostic);
        diagnosticCount = 0;
        store = createCp2Store();
        store.hydrateSnapshot(snapshot);
        app = buildApi({ cp2: { store } });
        app.log.level = "silent";
        await app.ready();
        await awaitConnected();
        console.log(JSON.stringify({ event: "diagnostic_driver_reloaded" }));
      }
      const inbound = store
        .snapshot()
        .conversationMessages.find(
          (message) => message.provider === "whatsapp_linked" && message.senderAddress === chat
        );
      if (inbound) {
        if (!inboundReported)
          console.log(JSON.stringify({ event: "live_canonical_inbound_verified" }));
        inboundReported = true;
        if (authorizeAiReply) {
          if (outboundAcks === 1) {
            console.log(
              JSON.stringify({
                event: "live_whatsapp_daemon_luna_reply_verified",
                modelId: daemonHost!.modelId
              })
            );
            delivered = true;
            break;
          }
          await delay(1000);
          continue;
        }
        await post(`/businesses/${business.id}/channel-messages`, {
          conversationId: inbound.conversationId,
          provider: "whatsapp_linked",
          text: "Grogoni connection test: your message was received. This is the single authorized test reply.",
          idempotencyKey: `certification:${business.id}`
        });
        console.log(JSON.stringify({ event: "live_gateway_outbound_acknowledged" }));
        delivered = true;
        break;
      }
      await delay(1000);
    }
    if (!delivered) throw new Error("Authorized inbound test message timed out.");
  }
} catch (error) {
  console.error(
    JSON.stringify({
      event: "certification_incomplete",
      reason: error instanceof Error ? error.message : "unknown"
    })
  );
  process.exitCode = 1;
} finally {
  if (path && cookie)
    await app.inject({ method: "DELETE", url: path, headers: { cookie } }).catch(() => undefined);
  await app.close();
  await daemonHost?.close();
  rmSync(sessionRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ event: "temporary_linked_device_cleanup_completed" }));
  delete process.env.WHATSAPP_LINKED_SESSION_KEY;
  process.stdin.destroy();
}
