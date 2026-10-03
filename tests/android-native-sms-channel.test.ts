import { readFile } from "node:fs/promises";
import type { RuntimeModelPrompt, RuntimeModelProvider } from "@grogoni/shared-types";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { activateGenericGlobalDefaultModel } from "./fixtures/native-runtime-test-helpers";

const androidHeaders = {
  "x-grogoni-device-id": "android-device-1",
  "x-grogoni-device-name": "Pixel Test",
  "x-grogoni-platform": "android",
  "x-grogoni-client": "android-native"
};

describe("Android native SMS channel", () => {
  it("registers only capabilities that Android actually reports", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createAndroidOwner(app, "+254700000781", "Capability Shop", "1781");

    const setupRequired = await putJson<{
      readiness: string;
      capabilities: string[];
    }>(
      app,
      "/v1/devices/native-sms",
      capabilityPayload({ roleGranted: false }),
      owner.cookie,
      androidHeaders
    );
    expect(setupRequired).toMatchObject({ readiness: "setup_required", capabilities: [] });

    const ready = await putJson<{ readiness: string; capabilities: string[]; preferred: boolean }>(
      app,
      "/v1/devices/native-sms",
      capabilityPayload(),
      owner.cookie,
      androidHeaders
    );
    expect(ready).toMatchObject({ readiness: "ready", preferred: true });
    expect(ready.capabilities).toEqual(["native_sms_send", "native_sms_receive"]);

    const ordinaryBrowser = await createOwner(app, "+254700000782", "Browser Shop", "1782");
    const rejected = await app.inject({
      method: "PUT",
      url: "/v1/devices/native-sms",
      headers: { "content-type": "application/json", cookie: ordinaryBrowser.cookie },
      payload: JSON.stringify(capabilityPayload())
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json<{ code: string }>().code).toBe("SMS_DEVICE_UNAVAILABLE");
    await app.close();
  });

  it("normalizes and deduplicates inbound SMS in the canonical customer conversation and agent history", async () => {
    // Relative to the test run, not hardcoded: normalizeNativeSmsOccurredAt rejects anything
    // more than 30 days old, so a fixed calendar date eventually falls outside that window.
    const smsOccurredAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const secondSmsOccurredAt = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    const prompts: RuntimeModelPrompt[] = [];
    const provider: RuntimeModelProvider = {
      name: "native-sms-agent-contract",
      async complete(prompt) {
        prompts.push(prompt);
        return {
          provider: "native-sms-agent-contract",
          status: "available",
          outputText: JSON.stringify({ type: "response", message: "Draft response." }),
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    // Global default model/host are seeded unavailable until a verified health check runs (see
    // services/api/src/index.ts's production startup gate); mirror that here so the injected
    // provider is actually reachable.
    activateGenericGlobalDefaultModel(store, new Date().toISOString());
    const app = buildApi({ cp2: { store } });
    const owner = await createAndroidOwner(app, "+254700000783", "Inbound Shop", "1783");
    await registerReadyDevice(app, owner.cookie);
    const sessionId = sessionIdFromCookie(owner.cookie);
    const existingCustomer = await postJson<{ id: string }>(
      app,
      `/businesses/${owner.business.id}/customers`,
      { name: "Brian", phone: "+254712345678", email: null, notes: null },
      owner.cookie
    );
    const existingConversation = store.createProviderConversation({
      sessionId,
      businessId: owner.business.id,
      customerId: existingCustomer.id,
      provider: "grogoni",
      externalUserId: "brian-grogoni",
      externalConversationId: "brian-grogoni-thread"
    });

    const inbound = await postJson<{
      customer: { id: string; phone: string };
      message: { id: string; conversationId: string; provider: string; direction: string };
      receipt: { id: string };
    }>(
      app,
      "/v1/devices/native-sms/messages",
      {
        businessId: owner.business.id,
        externalMessageId: "android-sms-901",
        sender: "+254712345678",
        text: "Do you have maize?",
        occurredAt: smsOccurredAt
      },
      owner.cookie,
      androidHeaders
    );
    const duplicate = await postJson<typeof inbound>(
      app,
      "/v1/devices/native-sms/messages",
      {
        businessId: owner.business.id,
        externalMessageId: "android-sms-901",
        sender: "+254712345678",
        text: "Do you have maize?",
        occurredAt: smsOccurredAt
      },
      owner.cookie,
      androidHeaders
    );
    expect(inbound.customer).toMatchObject({ id: existingCustomer.id, phone: "+254712345678" });
    expect(inbound.message).toMatchObject({
      conversationId: existingConversation.channel.conversationId,
      provider: "native_sms",
      direction: "inbound"
    });
    expect(duplicate.message.id).toBe(inbound.message.id);
    expect(duplicate.receipt.id).toBe(inbound.receipt.id);

    await postJson(
      app,
      "/v1/messages",
      {
        conversationId: inbound.message.conversationId,
        clientMessageId: "owner-follow-up-1",
        content: { type: "text", text: "Suggest a response to this customer." },
        agent: {
          businessId: owner.business.id,
          message: "Suggest a response to this customer."
        }
      },
      owner.cookie
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.conversationHistory).toEqual(
      expect.arrayContaining([{ role: "user", content: "Do you have maize?" }])
    );

    const unknown = await postJson<{ customer: { id: string; phone: string } }>(
      app,
      "/v1/devices/native-sms/messages",
      {
        businessId: owner.business.id,
        externalMessageId: "android-sms-902",
        sender: "+254733445566",
        text: "Hello",
        occurredAt: secondSmsOccurredAt
      },
      owner.cookie,
      androidHeaders
    );
    expect(unknown.customer).toMatchObject({ phone: "+254733445566" });
    expect(unknown.customer.id).not.toBe(existingCustomer.id);
    await app.close();
  });

  it("queues offline sends once, enforces device ownership, and advances canonical delivery", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createAndroidOwner(app, "+254700000784", "Outbound Shop", "1784");
    const other = await createAndroidOwner(app, "+254700000785", "Other Tenant Shop", "1785", {
      ...androidHeaders,
      "x-grogoni-device-id": "android-device-2",
      "x-grogoni-device-name": "Other Pixel"
    });
    await registerReadyDevice(app, owner.cookie);
    await registerReadyDevice(app, other.cookie, {
      ...androidHeaders,
      "x-grogoni-device-id": "android-device-2",
      "x-grogoni-device-name": "Other Pixel"
    });
    const customer = await postJson<{ id: string }>(
      app,
      `/businesses/${owner.business.id}/customers`,
      { name: "Amina", phone: "+254711223344", email: null, notes: null },
      owner.cookie
    );

    const snapshot = store.snapshot();
    store.hydrateSnapshot({
      ...snapshot,
      nativeSmsDevices: snapshot.nativeSmsDevices?.map((device) =>
        device.deviceId === "android-device-1"
          ? { ...device, lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString() }
          : device
      )
    });
    const payload = {
      customerId: customer.id,
      provider: "native_sms",
      text: "Your order is ready.",
      idempotencyKey: "native-sms-order-ready-1"
    };
    const queued = await postJson<{ message: { id: string; status: string } }>(
      app,
      `/businesses/${owner.business.id}/channel-messages`,
      payload,
      owner.cookie
    );
    const duplicate = await postJson<typeof queued>(
      app,
      `/businesses/${owner.business.id}/channel-messages`,
      payload,
      owner.cookie
    );
    expect(queued.message.status).toBe("queued");
    expect(duplicate.message.id).toBe(queued.message.id);
    expect(store.snapshot().nativeSmsDeviceCommands).toHaveLength(1);
    expect(store.snapshot().nativeSmsDeviceCommands?.[0]?.status).toBe("waiting_for_device");

    const fetched = await getJson<{
      commands: Array<{ id: string; recipient: string; text: string; status: string }>;
    }>(app, "/v1/devices/native-sms/commands", owner.cookie, androidHeaders);
    expect(fetched.commands).toEqual([
      expect.objectContaining({
        recipient: "+254711223344",
        text: "Your order is ready.",
        status: "dispatched"
      })
    ]);
    const commandId = fetched.commands[0]?.id as string;
    const replayedFetch = await getJson<typeof fetched>(
      app,
      "/v1/devices/native-sms/commands",
      owner.cookie,
      androidHeaders
    );
    expect(replayedFetch.commands[0]?.id).toBe(commandId);

    const crossTenant = await app.inject({
      method: "POST",
      url: `/v1/devices/native-sms/commands/${commandId}/result`,
      headers: {
        "content-type": "application/json",
        cookie: other.cookie,
        ...{
          ...androidHeaders,
          "x-grogoni-device-id": "android-device-2",
          "x-grogoni-device-name": "Other Pixel"
        }
      },
      payload: JSON.stringify({ status: "sent", resultCode: "SMS_SENT" })
    });
    expect(crossTenant.statusCode).toBe(404);

    await postJson(
      app,
      `/v1/devices/native-sms/commands/${commandId}/acknowledge`,
      {},
      owner.cookie,
      androidHeaders
    );
    const sent = await postJson<{ message: { status: string; sentAt: string } }>(
      app,
      `/v1/devices/native-sms/commands/${commandId}/result`,
      { status: "sent", resultCode: "SMS_SENT" },
      owner.cookie,
      androidHeaders
    );
    expect(sent.message).toMatchObject({ status: "sent" });
    const duplicateSent = await postJson<typeof sent>(
      app,
      `/v1/devices/native-sms/commands/${commandId}/result`,
      { status: "sent", resultCode: "SMS_SENT" },
      owner.cookie,
      androidHeaders
    );
    expect(duplicateSent.message.sentAt).toBe(sent.message.sentAt);
    const delivered = await postJson<{ message: { status: string; deliveredAt: string } }>(
      app,
      `/v1/devices/native-sms/commands/${commandId}/result`,
      { status: "delivered", resultCode: "SMS_DELIVERED" },
      owner.cookie,
      androidHeaders
    );
    expect(delivered.message).toMatchObject({ status: "delivered" });
    expect(delivered.message.deliveredAt).toBeTruthy();
    await app.close();
  });

  it("ships durable native SMS records and Android role declarations", async () => {
    const [migration, manifest, store] = await Promise.all([
      readFile("infra/db/migrations/054_android_native_sms_channel.sql", "utf8"),
      readFile("apps/android/app/src/main/AndroidManifest.xml", "utf8"),
      readFile("apps/android/app/src/main/java/market/grogoni/app/sms/NativeSmsStore.kt", "utf8")
    ]);
    expect(migration).toContain("native_sms_devices");
    expect(migration).toContain("native_sms_device_commands");
    expect(manifest).toContain("android.provider.Telephony.SMS_DELIVER");
    expect(manifest).toContain("android.intent.action.RESPOND_VIA_MESSAGE");
    expect(store).toContain("AndroidSecretBox");
    expect(store).toContain("executed_commands");
  });
});

function capabilityPayload(overrides: Record<string, unknown> = {}) {
  return {
    roleAvailable: true,
    roleGranted: true,
    sendPermissionGranted: true,
    receivePermissionGranted: true,
    simReady: true,
    subscriptionId: 1,
    preferred: true,
    ...overrides
  };
}

async function registerReadyDevice(
  app: ReturnType<typeof buildApi>,
  cookie: string,
  headers = androidHeaders
) {
  return putJson(app, "/v1/devices/native-sms", capabilityPayload(), cookie, headers);
}

async function createAndroidOwner(
  app: ReturnType<typeof buildApi>,
  destination: string,
  name: string,
  pin: string,
  headers = androidHeaders
) {
  return createOwner(app, destination, name, pin, headers);
}

async function createOwner(
  app: ReturnType<typeof buildApi>,
  destination: string,
  name: string,
  pin: string,
  headers: Record<string, string> = {}
) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify({ method: "phone", contact: destination, pin })
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const cookie = extractCookie(signup.headers["set-cookie"]);
  const result = await postJson<{ business: { id: string } }>(
    app,
    "/businesses",
    { name, language: "en" },
    cookie
  );
  return { business: result.business, cookie };
}

async function postJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string,
  headers: Record<string, string> = {}
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function putJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie: string,
  headers: Record<string, string> = {}
): Promise<T> {
  const response = await app.inject({
    method: "PUT",
    url,
    headers: { "content-type": "application/json", cookie, ...headers },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function getJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie: string,
  headers: Record<string, string> = {}
): Promise<T> {
  const response = await app.inject({ method: "GET", url, headers: { cookie, ...headers } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

function sessionIdFromCookie(cookie: string): string {
  return cookie.slice(cookie.indexOf("=") + 1);
}

function extractCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Missing cookie");
  return value.split(";")[0] as string;
}
