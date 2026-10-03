import { readFile } from "node:fs/promises";
import type {
  ConnectedMailboxProviderSummary,
  ConversationView,
  RuntimeModelPrompt,
  RuntimeModelProvider
} from "@grogoni/shared-types";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { activateGenericGlobalDefaultModel } from "./fixtures/native-runtime-test-helpers";
import {
  createEmailMailboxProviderClient,
  EmailProviderClientError,
  type EmailMailboxProviderClient,
  type EmailProviderAuthorization,
  type EmailProviderSendRequest,
  type EmailProviderTokens,
  type NormalizedProviderEmail
} from "../services/api/src/messaging/email-provider-client";

describe("connected email channel", () => {
  it("maps Gmail send and inbox APIs into normalized provider messages", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/messages/send")) {
        return Response.json({ id: "gmail-message-1", threadId: "gmail-thread-1" });
      }
      if (url.includes("/messages?") || url.endsWith("/messages")) {
        return Response.json({ messages: [{ id: "gmail-inbound-1" }] });
      }
      return Response.json({
        id: "gmail-inbound-1",
        threadId: "gmail-thread-1",
        internalDate: String(Date.parse("2026-08-13T14:00:00.000Z")),
        payload: {
          mimeType: "text/html",
          headers: [
            { name: "From", value: "Brian <brian@example.com>" },
            { name: "To", value: "sales@example.com" },
            { name: "Subject", value: "Re: Order #104" }
          ],
          body: {
            data: Buffer.from(
              "<p>Thanks</p><script>alert(1)</script><p>&gt; old quote</p>"
            ).toString("base64url")
          }
        }
      });
    }) as typeof fetch;
    const client = createEmailMailboxProviderClient(
      {
        MAILBOX_GOOGLE_CLIENT_ID: "gmail-client",
        MAILBOX_GOOGLE_CLIENT_SECRET: "gmail-secret"
      },
      fetcher
    );
    const authorization = client.beginAuthorization({
      provider: "gmail",
      redirectUri: "https://api.example.test/v1/mailboxes/oauth/gmail/callback"
    });
    expect(authorization.authorizationUrl).toContain("gmail.send");
    expect(authorization.authorizationUrl).toContain("access_type=offline");

    const sent = await client.send({
      provider: "gmail",
      accessToken: "access",
      senderAddress: "sales@example.com",
      recipientAddress: "brian@example.com",
      subject: "Order #104",
      text: "Ready",
      idempotencyKey: "gmail-send-1",
      externalThreadId: null,
      replyToProviderMessageId: null,
      attachments: [
        {
          filename: "invoice-104.txt",
          mimeType: "text/plain",
          contentBase64: Buffer.from("Invoice 104").toString("base64")
        }
      ]
    });
    expect(sent).toEqual({
      externalMessageId: "gmail-message-1",
      externalThreadId: "gmail-thread-1"
    });
    const inbound = await client.fetchInbound({
      provider: "gmail",
      accessToken: "access",
      since: "2026-08-13T13:00:00.000Z"
    });
    expect(inbound).toEqual([
      expect.objectContaining({
        externalMessageId: "gmail-inbound-1",
        externalThreadId: "gmail-thread-1",
        senderAddress: "brian@example.com",
        text: "Thanks"
      })
    ]);
    expect(requests.some((request) => request.url.includes("in%3Ainbox"))).toBe(true);
    const gmailSend = requests.find((request) => request.url.endsWith("/messages/send"));
    const gmailPayload = JSON.parse(String(gmailSend?.init?.body)) as { raw: string };
    expect(Buffer.from(gmailPayload.raw, "base64url").toString("utf8")).toContain(
      'filename="invoice-104.txt"'
    );
  });

  it("creates and sends an Outlook draft so a new email retains its conversation ID", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/me/messages")) {
        return Response.json({ id: "outlook-draft-1", conversationId: "outlook-thread-1" });
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const client = createEmailMailboxProviderClient(
      {
        MAILBOX_MICROSOFT_CLIENT_ID: "outlook-client",
        MAILBOX_MICROSOFT_CLIENT_SECRET: "outlook-secret"
      },
      fetcher
    );
    const sent = await client.send({
      provider: "outlook",
      accessToken: "access",
      senderAddress: "sales@example.com",
      recipientAddress: "brian@example.com",
      subject: "Order #104",
      text: "Ready",
      idempotencyKey: "outlook-send-1",
      externalThreadId: null,
      replyToProviderMessageId: null,
      attachments: []
    });
    expect(sent).toEqual({
      externalMessageId: "outlook-draft-1",
      externalThreadId: "outlook-thread-1"
    });
    expect(requests).toEqual([
      { url: "https://graph.microsoft.com/v1.0/me/messages", method: "POST" },
      {
        url: "https://graph.microsoft.com/v1.0/me/messages/outlook-draft-1/send",
        method: "POST"
      }
    ]);
  });

  it("keeps registered account email distinct from mailbox authorization", async () => {
    const provider = new FakeMailboxProvider();
    const store = createCp2Store({ emailMailboxProviderClient: provider });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwner(app, "seller@example.com", "Registered Email Shop");
    const customer = await createCustomer(app, owner, "Brian", "brian@example.com");

    const response = await app.inject({
      method: "POST",
      url: `/businesses/${owner.business.id}/channel-messages`,
      headers: { "content-type": "application/json", cookie: owner.cookie },
      payload: JSON.stringify({
        customerId: customer.id,
        provider: "email",
        subject: "Order update",
        text: "Your order is ready.",
        idempotencyKey: "registered-is-not-connected"
      })
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe("EMAIL_MAILBOX_NOT_CONNECTED");
    expect(provider.sends).toHaveLength(0);
    await app.close();
  });

  it("sends once, preserves a provider thread, deduplicates inbound mail, and reuses agent context", async () => {
    const prompts: RuntimeModelPrompt[] = [];
    const runtimeProvider: RuntimeModelProvider = {
      name: "email-agent-contract",
      async complete(prompt) {
        prompts.push(prompt);
        return {
          provider: "email-agent-contract",
          status: "available",
          outputText: JSON.stringify({ type: "response", message: "Draft response." }),
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    };
    const provider = new FakeMailboxProvider();
    const store = createCp2Store({
      emailMailboxProviderClient: provider,
      runtimeModelProvider: runtimeProvider
    });
    // Global default model/host are seeded unavailable until a verified health check runs (see
    // services/api/src/index.ts's production startup gate); mirror that here so the injected
    // provider is actually reachable.
    activateGenericGlobalDefaultModel(store, new Date().toISOString());
    const app = buildApi({ cp2: { store } });
    const owner = await createOwner(app, "owner@example.com", "Email Shop");
    const customer = await createCustomer(app, owner, "Brian", "brian@example.com");
    const existing = store.createProviderConversation({
      sessionId: sessionIdFromCookie(owner.cookie),
      businessId: owner.business.id,
      customerId: customer.id,
      provider: "grogoni",
      externalUserId: "brian-grogoni",
      externalConversationId: "brian-grogoni-thread"
    });
    const mailbox = await connectMailbox(store, owner, provider);
    const emailConversation = await postJson<ConversationView>(
      app,
      `/businesses/${owner.business.id}/mailboxes/${mailbox.id}/conversations`,
      { recipientAddress: "brian@example.com", displayName: "Brian" },
      owner.cookie
    );
    expect(emailConversation.conversation.id).toBe(existing.channel.conversationId);

    const payload = {
      conversationId: emailConversation.conversation.id,
      provider: "email",
      mailboxId: mailbox.id,
      subject: "Order #104",
      text: "Your order is ready.",
      idempotencyKey: "email-order-104"
    };
    const sent = await postJson<{
      message: { id: string; status: string; externalThreadId: string };
    }>(app, `/businesses/${owner.business.id}/channel-messages`, payload, owner.cookie);
    const replay = await postJson<typeof sent>(
      app,
      `/businesses/${owner.business.id}/channel-messages`,
      payload,
      owner.cookie
    );
    expect(sent.message).toMatchObject({ status: "sent", externalThreadId: "thread-104" });
    expect(replay.message.id).toBe(sent.message.id);
    expect(provider.sends).toHaveLength(1);
    expect(provider.sends[0]).toMatchObject({
      senderAddress: "sales@example.com",
      recipientAddress: "brian@example.com",
      subject: "Order #104"
    });

    provider.inbound = [
      inboundMessage({ externalMessageId: "reply-104", text: "I'll collect tomorrow." }),
      inboundMessage({ externalMessageId: "automatic-104", automated: true })
    ];
    const firstSync = await postJson<{
      ingested: number;
      filtered: number;
      deduplicated: number;
    }>(app, `/businesses/${owner.business.id}/mailboxes/${mailbox.id}/sync`, {}, owner.cookie);
    const secondSync = await postJson<typeof firstSync>(
      app,
      `/businesses/${owner.business.id}/mailboxes/${mailbox.id}/sync`,
      {},
      owner.cookie
    );
    expect(firstSync).toMatchObject({ ingested: 1, filtered: 1, deduplicated: 0 });
    expect(secondSync).toMatchObject({ ingested: 0, filtered: 1, deduplicated: 1 });

    const conversation = await getJson<ConversationView>(
      app,
      `/v1/conversations/${emailConversation.conversation.id}`,
      owner.cookie
    );
    const inbound = conversation.messages.find(
      (message) => message.providerMessageId === "reply-104"
    );
    expect(inbound).toMatchObject({
      conversationId: emailConversation.conversation.id,
      provider: "email",
      direction: "inbound",
      externalThreadId: "thread-104",
      subject: "Re: Order #104",
      senderAddress: "brian@example.com"
    });
    if (inbound === undefined) throw new Error("Expected the synchronized email reply.");

    await postJson(
      app,
      `/businesses/${owner.business.id}/channel-messages`,
      {
        conversationId: emailConversation.conversation.id,
        provider: "email",
        mailboxId: mailbox.id,
        replyToMessageId: inbound.id,
        text: "We'll expect you tomorrow.",
        idempotencyKey: "email-order-104-reply"
      },
      owner.cookie
    );
    expect(provider.sends[1]).toMatchObject({
      externalThreadId: "thread-104",
      replyToProviderMessageId: "reply-104",
      subject: "Re: Order #104"
    });

    await postJson(
      app,
      "/v1/messages",
      {
        conversationId: emailConversation.conversation.id,
        clientMessageId: "email-agent-context-1",
        content: { type: "text", text: "Suggest a response to Brian." },
        agent: { businessId: owner.business.id, message: "Suggest a response to Brian." }
      },
      owner.cookie
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.conversationHistory).toEqual(
      expect.arrayContaining([{ role: "user", content: "I'll collect tomorrow." }])
    );
    await app.close();
  });

  it("refreshes expired authorization and marks revoked authorization for reconnection", async () => {
    const provider = new FakeMailboxProvider();
    const store = createCp2Store({ emailMailboxProviderClient: provider });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwner(app, "refresh@example.com", "Refresh Shop");
    const mailbox = await connectMailbox(store, owner, provider);
    const conversation = await postJson<ConversationView>(
      app,
      `/businesses/${owner.business.id}/mailboxes/${mailbox.id}/conversations`,
      { recipientAddress: "customer@example.com" },
      owner.cookie
    );

    expireMailbox(store, mailbox.id);
    await sendEmail(app, owner, conversation.conversation.id, mailbox.id, "refresh-success");
    expect(provider.refreshes).toBe(1);

    provider.sendReauthorizationFailures = 1;
    await sendEmail(app, owner, conversation.conversation.id, mailbox.id, "provider-401-refresh");
    expect(provider.refreshes).toBe(2);

    expireMailbox(store, mailbox.id);
    provider.refreshRevoked = true;
    const failed = await app.inject({
      method: "POST",
      url: `/businesses/${owner.business.id}/channel-messages`,
      headers: { "content-type": "application/json", cookie: owner.cookie },
      payload: JSON.stringify(
        emailPayload(conversation.conversation.id, mailbox.id, "refresh-fail")
      )
    });
    expect(failed.statusCode, failed.body).toBe(401);
    expect(failed.json<{ code: string }>().code).toBe("EMAIL_REAUTHORIZATION_REQUIRED");
    const mailboxes = await getJson<{ mailboxes: Array<{ id: string; readiness: string }> }>(
      app,
      `/businesses/${owner.business.id}/mailboxes`,
      owner.cookie
    );
    expect(mailboxes.mailboxes.find((candidate) => candidate.id === mailbox.id)).toMatchObject({
      readiness: "REAUTHORIZATION_REQUIRED"
    });
    await app.close();
  });

  it("runs bounded history sync and sends opt-in rate-limited automatic acknowledgements", async () => {
    const provider = new FakeMailboxProvider();
    const store = createCp2Store({ emailMailboxProviderClient: provider });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwner(app, "automation@example.com", "Automation Shop");
    const customer = await createCustomer(app, owner, "Brian", "brian@example.com");
    const product = await postJson<{ id: string }>(
      app,
      `/businesses/${owner.business.id}/products`,
      { name: "Maize Flour", unit: "packet", quantity: 5, sellingPrice: 100 },
      owner.cookie
    );
    const invoice = await postJson<{ id: string }>(
      app,
      `/businesses/${owner.business.id}/invoices`,
      {
        customerId: customer.id,
        taxRate: 0,
        items: [{ productId: product.id, quantity: 1, unitPrice: 100 }]
      },
      owner.cookie
    );
    await postJson(
      app,
      `/businesses/${owner.business.id}/invoices/${invoice.id}/confirm`,
      {},
      owner.cookie
    );
    const mailbox = await connectMailbox(store, owner, provider);
    const conversation = await postJson<ConversationView>(
      app,
      `/businesses/${owner.business.id}/mailboxes/${mailbox.id}/conversations`,
      { recipientAddress: "brian@example.com" },
      owner.cookie
    );
    await postJson(
      app,
      `/businesses/${owner.business.id}/channel-messages`,
      {
        ...emailPayload(conversation.conversation.id, mailbox.id, "automation-thread"),
        attachments: [{ resourceType: "invoice", resourceId: invoice.id }]
      },
      owner.cookie
    );
    expect(provider.sends[0]?.attachments).toEqual([
      expect.objectContaining({ filename: "invoice-INV-00001.txt", mimeType: "text/plain" })
    ]);
    expect(
      Buffer.from(provider.sends[0]?.attachments[0]?.contentBase64 ?? "", "base64").toString()
    ).toContain("Invoice INV-00001");
    store.updateConnectedMailbox({
      sessionId: sessionIdFromCookie(owner.cookie),
      businessId: owner.business.id,
      mailboxId: mailbox.id,
      automaticReplyEnabled: true,
      automaticReplyText: "Thanks — we received your message."
    });
    provider.inbound = [inboundMessage({ externalMessageId: "automation-inbound" })];

    await postJson(
      app,
      `/businesses/${owner.business.id}/mailboxes/${mailbox.id}/sync`,
      { historyDays: 30 },
      owner.cookie
    );
    expect(provider.fetches.at(-1)).toMatchObject({ limit: 100 });
    expect(provider.sends).toHaveLength(2);
    expect(provider.sends[1]).toMatchObject({
      text: "Thanks — we received your message.",
      replyToProviderMessageId: "automation-inbound",
      externalThreadId: "thread-104"
    });

    await postJson(
      app,
      `/businesses/${owner.business.id}/mailboxes/${mailbox.id}/sync`,
      {},
      owner.cookie
    );
    expect(provider.sends).toHaveLength(2);
    provider.inbound = [inboundMessage({ externalMessageId: "background-inbound" })];
    await expect(
      store.syncDueConnectedMailboxes({
        now: new Date(Date.now() + 10 * 60_000),
        staleAfterMs: 5 * 60_000
      })
    ).resolves.toMatchObject({ checked: 1, synchronized: 1, ingested: 1, failed: 0 });
    expect(provider.sends).toHaveLength(2);
    await app.close();
  });

  it("enforces tenant ownership and ships reversible durable schema", async () => {
    const provider = new FakeMailboxProvider();
    const store = createCp2Store({ emailMailboxProviderClient: provider });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwner(app, "first@example.com", "First Shop");
    const other = await createOwner(app, "second@example.com", "Second Shop");
    const mailbox = await connectMailbox(store, owner, provider);

    const crossTenant = await app.inject({
      method: "PATCH",
      url: `/businesses/${other.business.id}/mailboxes/${mailbox.id}`,
      headers: { "content-type": "application/json", cookie: other.cookie },
      payload: JSON.stringify({ isDefault: true })
    });
    expect(crossTenant.statusCode).toBe(404);

    const [migration, rollback] = await Promise.all([
      readFile("infra/db/migrations/055_connected_email_channel.sql", "utf8"),
      readFile("infra/db/rollbacks/055_connected_email_channel.down.sql", "utf8")
    ]);
    expect(migration).toContain("connected_mailboxes");
    expect(migration).toContain("connected_mailbox_oauth_sessions");
    expect(migration).toContain("external_thread_id");
    expect(rollback.toLowerCase()).toContain("drop table if exists connected_mailboxes");
    await app.close();
  });
});

class FakeMailboxProvider implements EmailMailboxProviderClient {
  sends: EmailProviderSendRequest[] = [];
  inbound: NormalizedProviderEmail[] = [];
  refreshes = 0;
  refreshRevoked = false;
  sendReauthorizationFailures = 0;
  fetches: Array<{ since: string; limit?: number }> = [];

  providers(): ConnectedMailboxProviderSummary[] {
    return [
      {
        provider: "gmail",
        displayName: "Gmail",
        configured: true,
        canSend: true,
        canReceive: true
      },
      {
        provider: "outlook",
        displayName: "Microsoft Outlook",
        configured: true,
        canSend: true,
        canReceive: true
      }
    ];
  }

  beginAuthorization() {
    return {
      authorizationUrl: "https://accounts.example.test/authorize?state=fake-mailbox-state",
      state: "fake-mailbox-state",
      codeVerifier: "fake-code-verifier"
    };
  }

  async completeAuthorization(): Promise<EmailProviderAuthorization> {
    return {
      profile: { providerAccountId: "gmail-sales-account", address: "sales@example.com" },
      tokens: validTokens()
    };
  }

  async refreshAuthorization(): Promise<EmailProviderTokens> {
    this.refreshes += 1;
    if (this.refreshRevoked) {
      throw new EmailProviderClientError(
        "EMAIL_REAUTHORIZATION_REQUIRED",
        "Mailbox authorization was revoked."
      );
    }
    return validTokens();
  }

  async send(input: EmailProviderSendRequest) {
    if (this.sendReauthorizationFailures > 0) {
      this.sendReauthorizationFailures -= 1;
      throw new EmailProviderClientError(
        "EMAIL_REAUTHORIZATION_REQUIRED",
        "Provider rejected the access token."
      );
    }
    this.sends.push(input);
    return { externalMessageId: `provider-${this.sends.length}`, externalThreadId: "thread-104" };
  }

  async fetchInbound(input: { since: string; limit?: number }) {
    this.fetches.push(input);
    return this.inbound;
  }

  async revoke() {}
}

function validTokens(): EmailProviderTokens {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    scope:
      "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
    tokenType: "Bearer"
  };
}

function inboundMessage(overrides: Partial<NormalizedProviderEmail>): NormalizedProviderEmail {
  return {
    externalMessageId: "reply-104",
    externalThreadId: "thread-104",
    senderAddress: "brian@example.com",
    recipientAddresses: ["sales@example.com"],
    ccAddresses: [],
    subject: "Re: Order #104",
    text: "Reply",
    receivedAt: "2026-08-13T14:00:00.000Z",
    automated: false,
    ...overrides
  };
}

async function connectMailbox(
  store: ReturnType<typeof createCp2Store>,
  owner: Owner,
  provider: FakeMailboxProvider
) {
  store.beginConnectedMailboxOAuth({
    sessionId: sessionIdFromCookie(owner.cookie),
    businessId: owner.business.id,
    provider: "gmail",
    redirectUri: "http://localhost/v1/mailboxes/oauth/gmail/callback",
    returnUrl: "http://localhost/?mailbox=connected"
  });
  const connected = await store.completeConnectedMailboxOAuth({
    provider: "gmail",
    code: "authorization-code",
    state: "fake-mailbox-state"
  });
  expect(provider.sends).toHaveLength(0);
  return connected.mailbox;
}

function expireMailbox(store: ReturnType<typeof createCp2Store>, mailboxId: string) {
  const snapshot = store.snapshot();
  store.hydrateSnapshot({
    ...snapshot,
    connectedMailboxes: snapshot.connectedMailboxes?.map((mailbox) =>
      mailbox.id === mailboxId
        ? { ...mailbox, tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() }
        : mailbox
    )
  });
}

async function sendEmail(
  app: ReturnType<typeof buildApi>,
  owner: Owner,
  conversationId: string,
  mailboxId: string,
  idempotencyKey: string
) {
  return postJson(
    app,
    `/businesses/${owner.business.id}/channel-messages`,
    emailPayload(conversationId, mailboxId, idempotencyKey),
    owner.cookie
  );
}

function emailPayload(conversationId: string, mailboxId: string, idempotencyKey: string) {
  return {
    conversationId,
    provider: "email",
    mailboxId,
    subject: "Order update",
    text: "Your order is ready.",
    idempotencyKey
  };
}

interface Owner {
  business: { id: string };
  cookie: string;
}

let ownerSequence = 790;

async function createOwner(
  app: ReturnType<typeof buildApi>,
  email: string,
  name: string
): Promise<Owner> {
  ownerSequence += 1;
  const phone = `+254700000${ownerSequence}`;
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: phone, pin: "2468" })
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const cookie = extractCookie(signup.headers["set-cookie"]);
  const result = await postJson<{ business: { id: string } }>(
    app,
    "/businesses",
    { name, language: "en" },
    cookie
  );
  const challenge = await postJson<{
    challengeId: string;
    developmentCode: string;
    mergeRequired: boolean;
  }>(app, "/auth/identity/email/start", { email }, cookie);
  expect(challenge.mergeRequired).toBe(false);
  await postJson(
    app,
    "/auth/identity/email/verify",
    { challengeId: challenge.challengeId, code: challenge.developmentCode },
    cookie
  );
  return { business: result.business, cookie };
}

async function createCustomer(
  app: ReturnType<typeof buildApi>,
  owner: Owner,
  name: string,
  email: string
) {
  return postJson<{ id: string }>(
    app,
    `/businesses/${owner.business.id}/customers`,
    { name, phone: null, email, notes: null },
    owner.cookie
  );
}

async function postJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function getJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie: string
): Promise<T> {
  const response = await app.inject({ method: "GET", url, headers: { cookie } });
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
