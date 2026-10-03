import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII=";

describe("public chat commerce foundation", () => {
  it("resolves commerce addresses through a public privacy-safe identity endpoint", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700000500", "Identity Shop", "1500");

    const resolved = await getJson<{
      status: string;
      identity: {
        canonicalBusinessId: string;
        commerceAddress: string;
        displayName: string;
        entryPoints: Array<{ type: string; href: string }>;
      };
    }>(
      app,
      `/public/commerce-identities/${owner.business.grogoniId.replace("grogoni.", "")}@grogoni.com`
    );

    expect(resolved).toMatchObject({
      status: "active",
      identity: {
        canonicalBusinessId: owner.business.id,
        commerceAddress: `${owner.business.grogoniId.replace("grogoni.", "")}@grogoni.com`,
        displayName: "Identity Shop",
        entryPoints: expect.arrayContaining([expect.objectContaining({ type: "conversation" })])
      }
    });
    expect(JSON.stringify(resolved)).not.toContain("owner");

    const availability = await getJson<{ available: boolean; reason: string }>(
      app,
      `/public/commerce-identities/availability?address=${owner.business.grogoniId.replace("grogoni.", "")}@grogoni.com`
    );
    expect(availability).toEqual(expect.objectContaining({ available: false, reason: "taken" }));
    await app.close();
  });

  it("uses a scoped customer principal and persists catalogue replies as canonical messages", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const first = await createOwnerBusiness(app, "254700000501", "Tomato Shop", "1501");
    const second = await createOwnerBusiness(app, "254700000502", "Other Shop", "1502");
    const product = await postJson<{ id: string }>(
      app,
      `/businesses/${first.business.id}/products`,
      {
        name: "Tomatoes",
        aliases: ["nyanya"],
        unit: "crate",
        quantity: 6,
        buyingPrice: 75,
        sellingPrice: 150
      },
      first.cookie
    );
    const customer = await postJson<{ conversationId: string; capabilityToken: string }>(
      app,
      `/public/storefronts/${first.business.grogoniId}/sessions`,
      { visitorId: "browser-visitor-501", displayName: "Amina" }
    );

    const reply = await postJson<{
      conversationId: string;
      agentReply: { body: string };
    }>(app, `/public/storefronts/${first.business.grogoniId}/messages`, {
      capabilityToken: customer.capabilityToken,
      body: "find product nyanya",
      attachmentNames: []
    });
    expect(reply.conversationId).toBe(customer.conversationId);
    expect(reply.agentReply.body).toContain("Found 1 verified catalogue product");

    const snapshot = store.snapshot();
    expect(snapshot.publicStorefrontMessages).toEqual([]);
    expect(snapshot.conversationMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: customer.conversationId,
          author: "user",
          content: expect.objectContaining({ type: "text", text: "find product nyanya" })
        }),
        expect.objectContaining({
          conversationId: customer.conversationId,
          author: "agent",
          content: expect.objectContaining({ type: "text" })
        }),
        expect.objectContaining({
          conversationId: customer.conversationId,
          author: "agent",
          content: {
            type: "product-card",
            product: expect.objectContaining({
              productId: product.id,
              sellingPrice: 150,
              image: null
            })
          }
        })
      ])
    );
    expect(JSON.stringify(snapshot.customerRuntimeCapabilities)).not.toContain(
      customer.capabilityToken
    );
    expect(snapshot.runtimeTurns).toEqual([
      expect.objectContaining({
        actorId: expect.stringMatching(/^external:/u),
        plan: expect.objectContaining({ toolName: "products.list" }),
        context: expect.objectContaining({ role: "view_only" })
      })
    ]);

    const wrongShop = await app.inject({
      method: "POST",
      url: `/public/storefronts/${second.business.grogoniId}/messages`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        capabilityToken: customer.capabilityToken,
        body: "find product tomatoes",
        attachmentNames: []
      })
    });
    expect(wrongShop.statusCode).toBe(401);
    await app.close();
  });

  it("turns a public order into a canonical draft invoice with unpaid payment state", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700000503", "Invoice Shop", "1503");
    const product = await postJson<{ id: string }>(
      app,
      `/businesses/${owner.business.id}/products`,
      { name: "Mangoes", unit: "crate", quantity: 4, sellingPrice: 500 },
      owner.cookie
    );
    const customer = await postJson<{ capabilityToken: string; conversationId: string }>(
      app,
      `/public/storefronts/${owner.business.grogoniId}/sessions`,
      { visitorId: "browser-visitor-503" }
    );
    const order = await postJson<{
      invoiceId: string;
      conversationId: string;
      payment: { status: string; paidTotal: number; balanceDue: number };
    }>(app, `/public/storefronts/${owner.business.grogoniId}/orders`, {
      capabilityToken: customer.capabilityToken,
      customerName: "Amina",
      phone: "+254700000504",
      note: null,
      items: [{ productId: product.id, quantity: 2 }]
    });
    expect(order).toMatchObject({
      conversationId: customer.conversationId,
      payment: { status: "unpaid", paidTotal: 0, balanceDue: 1000 }
    });
    expect(store.snapshot().invoices).toEqual([
      expect.objectContaining({ id: order.invoiceId, status: "draft", total: 1000 })
    ]);
    await app.close();
  });
});

describe("camera catalogue publication", () => {
  it("keeps capture data out of the catalogue until review and publishes canonical image and price", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700000505", "Camera Shop", "1505");
    const capture = await postJson<{
      id: string;
      status: string;
      fields: { title: { value: string }; visiblePrice: { value: number } };
      temporaryMediaId: string;
    }>(
      app,
      `/businesses/${owner.business.id}/product-captures`,
      {
        fileName: "tomatoes.png",
        contentType: "image/png",
        contentBase64: onePixelPng,
        extractedText: "Tomatoes\nKSh 150"
      },
      owner.cookie
    );
    expect(capture).toMatchObject({
      status: "REVIEW_REQUIRED",
      fields: { title: { value: "Tomatoes" }, visiblePrice: { value: 150 } }
    });
    expect(
      (capture as unknown as { statusHistory: Array<{ status: string }> }).statusHistory[0]
    ).toMatchObject({ status: "CAPTURED" });
    expect(store.snapshot().products).toEqual([]);

    await patchJson(
      app,
      `/businesses/${owner.business.id}/product-captures/${capture.id}/review`,
      {
        title: "Fresh Tomatoes",
        category: "Produce",
        description: "Seller reviewed",
        visiblePrice: 160,
        keepImageAsProductMedia: true
      },
      owner.cookie
    );
    const published = await postJson<{
      job: { status: string; publishedProductId: string };
      product: { id: string; primaryMediaId: string; sellingPrice: number };
    }>(
      app,
      `/businesses/${owner.business.id}/product-captures/${capture.id}/confirm`,
      { unit: "crate", quantity: 8, aliases: ["nyanya"] },
      owner.cookie
    );
    expect(published).toMatchObject({
      job: { status: "PUBLISHED", publishedProductId: published.product.id },
      product: { sellingPrice: 160, primaryMediaId: capture.temporaryMediaId }
    });

    const storefront = await getJson<{
      products: Array<{ id: string; sellingPrice: number; image: string }>;
    }>(app, `/public/storefronts/${owner.business.grogoniId}`);
    expect(storefront.products).toEqual([
      expect.objectContaining({
        id: published.product.id,
        sellingPrice: 160,
        image: `/public/product-media/${capture.temporaryMediaId}`
      })
    ]);
    const media = await app.inject({
      method: "GET",
      url: `/public/product-media/${capture.temporaryMediaId}`
    });
    expect(media.statusCode).toBe(200);
    expect(media.headers["content-type"]).toContain("image/png");
    expect(media.rawPayload).toEqual(Buffer.from(onePixelPng, "base64"));
    await app.close();
  });

  it("supports extraction failure, retry, manual fallback, and cancellation cleanup", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700000506", "Fallback Shop", "1506");
    const failed = await postJson<{ id: string; status: string; temporaryMediaId: string }>(
      app,
      `/businesses/${owner.business.id}/product-captures`,
      {
        fileName: "unknown.png",
        contentType: "image/png",
        contentBase64: onePixelPng,
        extractedText: ""
      },
      owner.cookie
    );
    expect(failed.status).toBe("EXTRACTION_FAILED");
    const retried = await postJson<{ status: string; retryCount: number }>(
      app,
      `/businesses/${owner.business.id}/product-captures/${failed.id}/retry`,
      { extractedText: "Beans\nKES 90" },
      owner.cookie
    );
    expect(retried).toMatchObject({ status: "REVIEW_REQUIRED", retryCount: 1 });

    const cancelled = await postJson<{ status: string; temporaryMediaId: null }>(
      app,
      `/businesses/${owner.business.id}/product-captures/${failed.id}/cancel`,
      {},
      owner.cookie
    );
    expect(cancelled).toMatchObject({ status: "CANCELLED", temporaryMediaId: null });
    expect(store.snapshot().productMedia).toEqual([]);
    await app.close();
  });
});

describe("provider-neutral conversation channels", () => {
  it("maps Telegram identities without account linking and deduplicates provider updates", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700000507", "Telegram Shop", "1507");
    const sessionId = owner.cookie.slice(owner.cookie.indexOf("=") + 1);
    const provider = store.createProviderConversation({
      sessionId,
      businessId: owner.business.id,
      provider: "telegram",
      externalUserId: "tg-user-77",
      externalConversationId: "tg-chat-88",
      displayName: "Telegram Buyer"
    });
    expect(provider.identity.accountId).toBeNull();
    expect(provider.channel.provider).toBe("telegram");

    const first = store.ingestProviderMessage({
      provider: "telegram",
      businessId: owner.business.id,
      externalConversationId: "tg-chat-88",
      externalUpdateId: "update-901",
      providerMessageId: "message-902",
      body: "Do you have tomatoes?"
    });
    const duplicate = store.ingestProviderMessage({
      provider: "telegram",
      businessId: owner.business.id,
      externalConversationId: "tg-chat-88",
      externalUpdateId: "update-901",
      providerMessageId: "message-902",
      body: "Do you have tomatoes?"
    });
    expect(duplicate.receipt.id).toBe(first.receipt.id);
    expect(duplicate.message?.id).toBe(first.message?.id);

    const outbound = store.createConversationMessage({
      sessionId,
      conversationId: provider.channel.conversationId,
      clientMessageId: "telegram-outbound-001",
      selectedChannel: "telegram",
      content: { type: "text", text: "Yes, they are available." }
    });
    expect(outbound).toMatchObject({
      status: "queued",
      selectedChannel: "telegram",
      failureCode: "provider_adapter_unconfigured"
    });
    expect(store.snapshot().providerUpdateReceipts).toHaveLength(1);
    expect(
      store
        .snapshot()
        .conversationMessages.filter(
          (message) => message.conversationId === provider.channel.conversationId
        )
    ).toHaveLength(2);
    await app.close();
  });

  it("ships the durable provider, capability, media, and capture schema migration", async () => {
    const migration = await readFile(
      "infra/db/migrations/049_platform_chat_commerce_foundation.sql",
      "utf8"
    );
    expect(migration).toContain("platform_identities");
    expect(migration).toContain("conversation_channels");
    expect(migration).toContain("provider_update_receipts_provider_update_unique_idx");
    expect(migration).toContain("customer_runtime_capabilities_token_hash_unique_idx");
    expect(migration).toContain("product_capture_jobs");
    expect(migration).toContain("primary_media_id");
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  destination: string,
  name: string,
  pin: string
) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin })
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const cookie = extractCookie(signup.headers["set-cookie"]);
  const result = await postJson<{ business: { id: string; grogoniId: string } }>(
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
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: jsonHeaders(cookie),
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function patchJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie: string
): Promise<T> {
  const response = await app.inject({
    method: "PATCH",
    url,
    headers: jsonHeaders(cookie),
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function getJson<T>(app: ReturnType<typeof buildApi>, url: string): Promise<T> {
  const response = await app.inject({ method: "GET", url });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

function jsonHeaders(cookie?: string) {
  return { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) };
}

function extractCookie(header: string | string[] | number | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(typeof value).toBe("string");
  return String(value).split(";")[0] ?? "";
}
