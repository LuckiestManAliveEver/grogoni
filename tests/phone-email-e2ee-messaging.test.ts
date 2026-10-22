import { signupPhone, signupWithBackupEmail } from "./fixtures/account-auth";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  ConversationMessageSummary,
  ConversationView,
  E2eeDeviceSummary
} from "@grogoni/shared-types";
import { buildApi } from "../services/api/src/app";
import { createPostgresCp2Store } from "../services/api/src/cp2/postgres-store";
import {
  createCp2Store,
  type Cp2Store,
  type MessageEmailNotificationInput
} from "../services/api/src/cp2/store";
import {
  decryptDirectMessage,
  encryptDirectMessage,
  type E2eeIdentity
} from "../apps/web/src/e2ee";

describe("registered phone and email end-to-end messaging", () => {
  it("does not resolve or notify an unverified backup email", async () => {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
    const notifications: MessageEmailNotificationInput[] = [];
    const store = createCp2Store({
      messageEmailNotificationSender: async (input) => {
        notifications.push(input);
        return "sent";
      }
    });
    const app = buildApi({ cp2: { store } });
    const sender = await signupPhone(app, "unverified-email-sender");
    const recipient = await signupPhone(app, "unverified-email-recipient");
    const email = "unverified-recipient@example.test";
    await postJson(app, "/auth/identity/email/start", { email }, recipient.cookie);
    const unresolved = await postResponse(
      app,
      "/v1/conversations",
      {
        kind: "personal",
        activeShopId: null,
        recipient: email
      },
      sender.cookie
    );
    expect(unresolved.statusCode).toBe(404);
    await registerEncryptionDevice(
      app,
      sender.cookie,
      await createIdentity("unverified-sender-device")
    );
    await registerEncryptionDevice(
      app,
      recipient.cookie,
      await createIdentity("unverified-recipient-device")
    );
    const conversation = await createConversation(
      app,
      sender.cookie,
      recipient.phone,
      "Phone only"
    );
    await sendEncryptedMessage({
      app,
      cookie: sender.cookie,
      conversation,
      message: "Private message"
    });
    await Promise.resolve();
    expect(notifications).toEqual([]);
    expect(store.snapshot().messageNotificationDeliveries).toEqual([]);
    await app.close();
  });
  it("signs up mock phone/email accounts and persists encrypted messages in both directions", async () => {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
    const emailNotifications: MessageEmailNotificationInput[] = [];
    const databaseUrl = process.env.PHONE_EMAIL_E2EE_TEST_DATABASE_URL;
    const storeOptions = {
      messageEmailNotificationSender: async (input: MessageEmailNotificationInput) => {
        emailNotifications.push(input);
        return "sent" as const;
      },
      messageWebBaseUrl: "https://grogoni.com"
    };
    const store =
      databaseUrl === undefined
        ? createCp2Store(storeOptions)
        : await createPostgresCp2Store({ databaseUrl, ...storeOptions });
    const app = buildApi({ cp2: { store } });
    const suffix = `${Date.now()}${Math.floor(Math.random() * 10_000)}`.slice(-8);
    const phone = `+25471${suffix.slice(-7)}`;
    const email = `mock-${suffix}@example.test`;
    const phoneCookie = await createAccountSession(app, "phone", phone);
    const emailCookie = await createAccountSession(app, "email", email);
    const phoneIdentity = await createIdentity(`device-phone-${suffix}`);
    const emailIdentity = await createIdentity(`device-email-${suffix}`);
    await registerEncryptionDevice(app, phoneCookie, phoneIdentity);
    await registerEncryptionDevice(app, emailCookie, emailIdentity);

    const unsignedConversation = await postResponse(app, "/v1/conversations", {
      kind: "personal",
      activeShopId: null,
      recipient: email
    });
    expect(unsignedConversation.statusCode).toBe(401);

    const phoneToEmailConversation = await createConversation(
      app,
      phoneCookie,
      email,
      "Phone to email"
    );
    const phoneToEmailText = `private phone to email message ${suffix}`;
    const phoneToEmailMessage = await sendEncryptedMessage({
      app,
      cookie: phoneCookie,
      conversation: phoneToEmailConversation,
      message: phoneToEmailText
    });
    const receivedByEmail = await getJson<ConversationView>(
      app,
      `/v1/conversations/${phoneToEmailConversation.conversation.id}`,
      emailCookie
    );
    await expect(
      decryptDirectMessage({
        conversationId: phoneToEmailConversation.conversation.id,
        content: encryptedContent(receivedByEmail.messages[0]),
        identity: emailIdentity
      })
    ).resolves.toEqual({ text: phoneToEmailText, attachments: [] });

    const emailToPhoneConversation = await createConversation(
      app,
      emailCookie,
      phone,
      "Email to phone"
    );
    const emailToPhoneText = `private email to phone message ${suffix}`;
    const emailToPhoneMessage = await sendEncryptedMessage({
      app,
      cookie: emailCookie,
      conversation: emailToPhoneConversation,
      message: emailToPhoneText
    });
    const receivedByPhone = await getJson<ConversationView>(
      app,
      `/v1/conversations/${emailToPhoneConversation.conversation.id}`,
      phoneCookie
    );
    await expect(
      decryptDirectMessage({
        conversationId: emailToPhoneConversation.conversation.id,
        content: encryptedContent(receivedByPhone.messages[0]),
        identity: phoneIdentity
      })
    ).resolves.toEqual({ text: emailToPhoneText, attachments: [] });

    expect(phoneToEmailMessage.content.type).toBe("encrypted");
    expect(emailToPhoneMessage.content.type).toBe("encrypted");
    expect(JSON.stringify(store.snapshot().conversationMessages)).not.toContain(phoneToEmailText);
    expect(JSON.stringify(store.snapshot().conversationMessages)).not.toContain(emailToPhoneText);
    await Promise.resolve();
    expect(emailNotifications).toEqual([
      {
        conversationId: phoneToEmailConversation.conversation.id,
        messageId: phoneToEmailMessage.id,
        openUrl: `https://grogoni.com/?conversation=${phoneToEmailConversation.conversation.id}`,
        to: email
      }
    ]);
    expect(JSON.stringify(emailNotifications)).not.toContain(phoneToEmailText);

    const persistentStore = store as Cp2Store & {
      flush?: () => Promise<void>;
      close?: () => Promise<void>;
    };
    await persistentStore.flush?.();
    await app.close();
    await persistentStore.close?.();

    if (databaseUrl !== undefined) {
      const restoredStore = await createPostgresCp2Store({ databaseUrl, ...storeOptions });
      const restoredApp = buildApi({ cp2: { store: restoredStore } });
      const restoredPhoneToEmail = await getJson<ConversationView>(
        restoredApp,
        `/v1/conversations/${phoneToEmailConversation.conversation.id}`,
        emailCookie
      );
      const restoredEmailToPhone = await getJson<ConversationView>(
        restoredApp,
        `/v1/conversations/${emailToPhoneConversation.conversation.id}`,
        phoneCookie
      );

      await expect(
        decryptDirectMessage({
          conversationId: phoneToEmailConversation.conversation.id,
          content: encryptedContent(restoredPhoneToEmail.messages[0]),
          identity: emailIdentity
        })
      ).resolves.toEqual({ text: phoneToEmailText, attachments: [] });
      await expect(
        decryptDirectMessage({
          conversationId: emailToPhoneConversation.conversation.id,
          content: encryptedContent(restoredEmailToPhone.messages[0]),
          identity: phoneIdentity
        })
      ).resolves.toEqual({ text: emailToPhoneText, attachments: [] });

      await restoredApp.close();
      await restoredStore.close();
    }
  });

  it("persists failed notification delivery and retries it after hydration", async () => {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
    const failingStore = createCp2Store({
      messageEmailNotificationSender: async () => "failed"
    });
    const app = buildApi({ cp2: { store: failingStore } });
    const suffix = `${Date.now()}`.slice(-8);
    const phone = `+25472${suffix.slice(-7)}`;
    const email = `retry-${suffix}@example.test`;
    const phoneCookie = await createAccountSession(app, "phone", phone);
    const emailCookie = await createAccountSession(app, "email", email);
    await registerEncryptionDevice(app, phoneCookie, await createIdentity(`phone-${suffix}`));
    await registerEncryptionDevice(app, emailCookie, await createIdentity(`email-${suffix}`));
    const conversation = await createConversation(app, phoneCookie, email, "Retry delivery");
    const message = await sendEncryptedMessage({
      app,
      cookie: phoneCookie,
      conversation,
      message: "encrypted retry payload"
    });
    const failed = failingStore.snapshot().messageNotificationDeliveries ?? [];
    expect(failed).toEqual([
      expect.objectContaining({
        messageId: message.id,
        channel: "email",
        status: "failed",
        attempts: 1,
        nextAttemptAt: expect.any(String)
      })
    ]);

    const restored = createCp2Store({
      messageEmailNotificationSender: async () => "sent"
    });
    restored.hydrateSnapshot(failingStore.snapshot());
    const result = await restored.deliverPendingMessageNotifications({
      now: new Date(Date.now() + 5 * 60_000)
    });

    expect(result).toEqual({ checked: 1, sent: 1, failed: 0, deadLettered: 0 });
    expect(restored.snapshot().messageNotificationDeliveries).toEqual([
      expect.objectContaining({ status: "sent", attempts: 2, deliveredAt: expect.any(String) })
    ]);
    await app.close();
  });
});

async function createAccountSession(
  app: FastifyInstance,
  channel: "email" | "phone",
  destination: string
): Promise<string> {
  if (channel === "phone") {
    const response = await postResponse(app, "/auth/pin/signup", {
      method: "phone",
      contact: destination,
      pin: "1234"
    });
    expect(response.statusCode).toBe(200);
    return extractSessionCookie(response.headers["set-cookie"]);
  }
  return (await signupWithBackupEmail(app, destination)).cookie;
}

async function createConversation(
  app: FastifyInstance,
  cookie: string,
  recipient: string,
  title: string
): Promise<ConversationView> {
  return postJson<ConversationView>(
    app,
    "/v1/conversations",
    { kind: "personal", activeShopId: null, recipient, title },
    cookie
  );
}

async function sendEncryptedMessage(input: {
  app: FastifyInstance;
  cookie: string;
  conversation: ConversationView;
  message: string;
}): Promise<ConversationMessageSummary> {
  const devices = await getJson<{ devices: E2eeDeviceSummary[] }>(
    input.app,
    `/v1/conversations/${input.conversation.conversation.id}/encryption-devices`,
    input.cookie
  );
  const content = await encryptDirectMessage({
    conversationId: input.conversation.conversation.id,
    devices: devices.devices,
    message: { text: input.message, attachments: [] }
  });
  return postJson<ConversationMessageSummary>(
    input.app,
    "/v1/messages",
    {
      conversationId: input.conversation.conversation.id,
      clientMessageId: `message-${crypto.randomUUID()}`,
      content,
      clientTimestamp: new Date().toISOString()
    },
    input.cookie
  );
}

async function createIdentity(deviceId: string): Promise<E2eeIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits"
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    deviceId,
    privateKey: pair.privateKey,
    publicKey: {
      kty: "EC",
      crv: "P-256",
      x: jwk.x as string,
      y: jwk.y as string,
      ext: true
    }
  };
}

async function registerEncryptionDevice(
  app: FastifyInstance,
  cookie: string,
  identity: E2eeIdentity
): Promise<void> {
  await postJson<E2eeDeviceSummary>(
    app,
    "/v1/e2ee/devices",
    {
      deviceId: identity.deviceId,
      label: "Mock test device",
      publicKey: identity.publicKey
    },
    cookie
  );
}

function encryptedContent(
  message: ConversationMessageSummary | undefined
): Extract<ConversationMessageSummary["content"], { type: "encrypted" }> {
  if (message?.content.type !== "encrypted") {
    throw new Error("Expected an encrypted persisted message.");
  }
  return message.content;
}

async function getJson<T>(app: FastifyInstance, url: string, cookie: string): Promise<T> {
  const response = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function postJson<T>(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await postResponse(app, url, payload, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

function postResponse(app: FastifyInstance, url: string, payload: unknown, cookie?: string) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie })
    },
    payload: JSON.stringify(payload)
  });
}

function extractSessionCookie(value: string | string[] | undefined): string {
  const cookie = Array.isArray(value) ? value[0] : value;
  if (cookie === undefined) throw new Error("Session cookie missing.");
  return cookie.split(";", 1)[0] ?? cookie;
}
