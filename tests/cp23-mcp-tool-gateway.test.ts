import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { FulfillmentService } from "../services/api/src/cp2/domains/fulfillment/service";

interface McpTokenResponse {
  accessToken: string;
  token: {
    id: string;
    accountId: string;
    shopId: string | null;
    scopes: string[];
    createdAt: string;
    expiresAt: string;
  };
}

describe("CP23 MCP tool gateway", () => {
  it("supports authenticated E2EE communication between external agents and model runtimes", async () => {
    const app = buildApi();
    const senderCookie = await createSession(app, "254700000241");
    const recipientCookie = await createSession(app, "254700000242");
    await postJson(
      app,
      "/v1/e2ee/devices",
      {
        deviceId: "recipient-model-endpoint",
        label: "Recipient model runtime",
        publicKey: secureFixturePublicKey
      },
      recipientCookie
    );
    const token = await postJson<McpTokenResponse>(
      app,
      "/v1/mcp/tokens",
      { name: "Sender agent runtime", scopes: ["mcp:read", "mcp:act"], shopId: null },
      senderCookie,
      { origin: "http://localhost:5173" }
    );
    const initialized = await mcpPost(app, token.accessToken, initializeRequest());
    const sessionId = String(initialized.headers["mcp-session-id"]);

    const endpoint = await mcpPost(
      app,
      token.accessToken,
      toolCall(2, "grogoni.register_secure_endpoint", {
        endpointId: "sender-agent-endpoint",
        label: "Sender agent runtime",
        publicKey: secureFixturePublicKey
      }),
      sessionId
    );
    expect(endpoint.json().result).toMatchObject({
      isError: false,
      structuredContent: { id: "sender-agent-endpoint", accountId: token.token.accountId }
    });

    const created = await mcpPost(
      app,
      token.accessToken,
      toolCall(3, "grogoni.create_secure_channel", {
        recipient: "+254700000242",
        title: "Agent and model coordination"
      }),
      sessionId
    );
    const conversationId = created.json().result.structuredContent.conversation.id;
    const channel = await mcpPost(
      app,
      token.accessToken,
      toolCall(4, "grogoni.get_secure_channel", { conversationId }),
      sessionId
    );
    expect(channel.json().result.structuredContent.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "sender-agent-endpoint" }),
        expect.objectContaining({ id: "recipient-model-endpoint" })
      ])
    );

    const secureMessage = encryptedMcpFixture([
      "sender-agent-endpoint",
      "recipient-model-endpoint"
    ]);
    const sent = await mcpPost(
      app,
      token.accessToken,
      toolCall(5, "grogoni.send_secure_message", {
        conversationId,
        idempotencyKey: "secure-agent-model-message-1",
        content: secureMessage
      }),
      sessionId
    );
    expect(sent.json().result).toMatchObject({
      isError: false,
      structuredContent: {
        conversationId,
        author: "agent",
        content: { type: "encrypted", ciphertext: secureMessage.ciphertext }
      }
    });

    const replayed = await mcpPost(
      app,
      token.accessToken,
      toolCall(6, "grogoni.send_secure_message", {
        conversationId,
        idempotencyKey: "secure-agent-model-message-1",
        content: secureMessage
      }),
      sessionId
    );
    expect(replayed.json().result.structuredContent.id).toBe(
      sent.json().result.structuredContent.id
    );

    // The E2EE carve-out in the messaging guard must not reopen plaintext agent posts into DMs.
    const plaintext = await mcpPost(
      app,
      token.accessToken,
      toolCall(7, "grogoni.send_message", {
        conversationId,
        text: "Agent and model plaintext leak",
        idempotencyKey: "plaintext-agent-model-message-1"
      }),
      sessionId
    );
    expect(plaintext.json().result).toMatchObject({
      isError: true,
      structuredContent: { code: "e2ee_required" }
    });
    const plaintextDisguised = await mcpPost(
      app,
      token.accessToken,
      toolCall(8, "grogoni.send_secure_message", {
        conversationId,
        idempotencyKey: "plaintext-agent-model-message-2",
        content: { type: "text", text: "Agent and model plaintext leak" }
      }),
      sessionId
    );
    expect(plaintextDisguised.json().result).toMatchObject({
      isError: true,
      structuredContent: { code: "mcp_input_invalid" }
    });

    const recipientView = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conversationId}`,
      headers: { cookie: recipientCookie }
    });
    expect(recipientView.statusCode).toBe(200);
    expect(recipientView.body).not.toContain("Agent and model secret");
    expect(recipientView.body).not.toContain("plaintext leak");
    const agentMessages = recipientView
      .json()
      .messages.filter((message: { author: string }) => message.author === "agent");
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0].content).toMatchObject({ type: "encrypted" });
    await app.close();
  });

  it("rejects secure agent messages whose envelopes do not exactly match the live endpoint set", async () => {
    const app = buildApi();
    const senderCookie = await createSession(app, "254700000243");
    const recipientCookie = await createSession(app, "254700000244");
    const token = await postJson<McpTokenResponse>(
      app,
      "/v1/mcp/tokens",
      { name: "Sender agent runtime", scopes: ["mcp:read", "mcp:act"], shopId: null },
      senderCookie,
      { origin: "http://localhost:5173" }
    );
    const initialized = await mcpPost(app, token.accessToken, initializeRequest());
    const sessionId = String(initialized.headers["mcp-session-id"]);
    let requestId = 2;
    const call = (name: string, args: Record<string, unknown>) =>
      mcpPost(app, token.accessToken, toolCall(requestId++, name, args), sessionId);
    const send = async (idempotencyKey: string, deviceIds: string[]) =>
      (
        await call("grogoni.send_secure_message", {
          conversationId,
          idempotencyKey,
          content: encryptedMcpFixture(deviceIds)
        })
      ).json().result;
    const rejected = (code: string) => ({ isError: true, structuredContent: { code } });

    await call("grogoni.register_secure_endpoint", {
      endpointId: "sender-agent-endpoint",
      label: "Sender agent runtime",
      publicKey: secureFixturePublicKey
    });
    const created = await call("grogoni.create_secure_channel", { recipient: "+254700000244" });
    const conversationId: string = created.json().result.structuredContent.conversation.id;

    // Recipient has no endpoint yet: nothing can be encrypted for them.
    expect(await send("envelope-no-recipient", ["sender-agent-endpoint"])).toMatchObject(
      rejected("e2ee_recipient_unavailable")
    );

    await postJson(
      app,
      "/v1/e2ee/devices",
      {
        deviceId: "recipient-model-endpoint",
        label: "Recipient model",
        publicKey: secureFixturePublicKey
      },
      recipientCookie
    );
    const live = ["sender-agent-endpoint", "recipient-model-endpoint"];

    // Missing recipient, unknown extra recipient, duplicated recipient.
    expect(await send("envelope-missing", ["sender-agent-endpoint"])).toMatchObject(
      rejected("e2ee_device_set_changed")
    );
    expect(await send("envelope-extra", [...live, "attacker-endpoint"])).toMatchObject(
      rejected("e2ee_device_set_changed")
    );
    // Same-size key substitution: an attacker endpoint in place of the real recipient.
    expect(
      await send("envelope-swapped", ["sender-agent-endpoint", "attacker-endpoint"])
    ).toMatchObject(rejected("e2ee_device_set_changed"));
    expect(await send("envelope-duplicate", [...live, "recipient-model-endpoint"])).toMatchObject(
      rejected("e2ee_device_set_changed")
    );
    expect(await send("envelope-exact-1", live)).toMatchObject({ isError: false });

    // Recipient adds a second endpoint: the stale set is refused until the agent refreshes.
    await postJson(
      app,
      "/v1/e2ee/devices",
      {
        deviceId: "recipient-model-endpoint-2",
        label: "Recipient model 2",
        publicKey: secureFixturePublicKey
      },
      recipientCookie
    );
    expect(await send("envelope-stale-add", live)).toMatchObject(
      rejected("e2ee_device_set_changed")
    );
    const refreshed = await call("grogoni.get_secure_channel", { conversationId });
    const refreshedIds = refreshed
      .json()
      .result.structuredContent.devices.map((device: { id: string }) => device.id)
      .sort();
    expect(refreshedIds).toEqual([...live, "recipient-model-endpoint-2"].sort());
    expect(await send("envelope-exact-2", refreshedIds)).toMatchObject({ isError: false });

    // Recipient revokes that endpoint: encrypting for it again is refused.
    const revoked = await app.inject({
      method: "DELETE",
      url: "/v1/e2ee/devices/recipient-model-endpoint-2",
      headers: { cookie: recipientCookie }
    });
    expect(revoked.statusCode).toBe(200);
    expect(await send("envelope-stale-revoke", refreshedIds)).toMatchObject(
      rejected("e2ee_device_set_changed")
    );
    expect(await send("envelope-exact-3", live)).toMatchObject({ isError: false });

    const recipientView = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conversationId}`,
      headers: { cookie: recipientCookie }
    });
    const agentMessages = recipientView
      .json()
      .messages.filter((message: { author: string }) => message.author === "agent");
    expect(
      agentMessages.map((message: { clientMessageId: string }) => message.clientMessageId)
    ).toEqual(["envelope-exact-1", "envelope-exact-2", "envelope-exact-3"]);
    await app.close();
  });

  it("exposes tenant-scoped fulfillment load and dispatch evaluation with decimal gram values", async () => {
    const getCorridorPool = vi.fn(async () => ({
      corridorId: "11111111-1111-4111-8111-111111111111",
      eligibleTotalWeightGrams: "4000000",
      allocatableWeightGrams: "4000000",
      readiness: "DISPATCHABLE",
      orders: []
    }));
    const evaluateDispatch = vi.fn(async () => ({
      outcome: "READY",
      readiness: "DISPATCH_READY",
      maxWaitReached: false,
      recommendation: null,
      reason: "TARGET_REACHED"
    }));
    const fulfillmentService = {
      available: true,
      getCorridorPool,
      evaluateDispatch
    } as unknown as FulfillmentService;
    const app = buildApi({ cp2: { fulfillmentService } });
    const cookie = await createSession(app, "254700000298");
    const shop = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: "MCP Dispatch Shop", language: "en" },
      cookie
    );
    const token = await postJson<McpTokenResponse>(
      app,
      "/v1/mcp/tokens",
      { name: "Dispatch agent", scopes: ["mcp:read", "mcp:act"], shopId: shop.business.id },
      cookie,
      { origin: "http://localhost:5173" }
    );
    const initialized = await mcpPost(app, token.accessToken, initializeRequest());
    const sessionId = String(initialized.headers["mcp-session-id"]);
    const listed = await mcpPost(
      app,
      token.accessToken,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId
    );
    expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(["fulfillment.get_corridor_load", "fulfillment.evaluate_dispatch"])
    );
    const corridorId = "11111111-1111-4111-8111-111111111111";
    const load = await mcpPost(
      app,
      token.accessToken,
      toolCall(3, "fulfillment.get_corridor_load", { shopId: shop.business.id, corridorId }),
      sessionId
    );
    expect(load.json().result).toMatchObject({
      isError: false,
      structuredContent: { eligibleTotalWeightGrams: "4000000" }
    });
    const evaluation = await mcpPost(
      app,
      token.accessToken,
      toolCall(4, "fulfillment.evaluate_dispatch", {
        shopId: shop.business.id,
        corridorId,
        idempotencyKey: "evaluate-corridor-once"
      }),
      sessionId
    );
    expect(evaluation.json().result).toMatchObject({
      isError: false,
      structuredContent: { outcome: "READY" }
    });
    expect(getCorridorPool).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: null, businessId: shop.business.id, corridorId })
    );
    expect(evaluateDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "evaluate-corridor-once" })
    );
    await app.close();
  });

  it("links ChatGPT through OAuth 2.1 authorization code with PKCE", async () => {
    const app = buildApi();
    const cookie = await createSession(app, "254700000230");
    const verifier = "grogoni-chatgpt-oauth-verifier-0123456789abcdef";
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const resourceMetadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource"
    });
    expect(resourceMetadata.statusCode).toBe(200);
    expect(resourceMetadata.json()).toMatchObject({
      resource: "https://grogoni.com/mcp",
      authorization_servers: ["https://grogoni.com"],
      scopes_supported: ["mcp:read", "mcp:act"]
    });

    const serverMetadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server"
    });
    expect(serverMetadata.json()).toMatchObject({
      issuer: "https://grogoni.com",
      authorization_endpoint: "https://grogoni.com/oauth/authorize",
      token_endpoint: "https://grogoni.com/oauth/token",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true
    });

    const authorizeUrl = new URL("https://grogoni.com/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "https://chatgpt.com/oauth/client.json");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "https://chatgpt.com/connector_platform_oauth_redirect"
    );
    authorizeUrl.searchParams.set("resource", "https://grogoni.com/mcp");
    authorizeUrl.searchParams.set("scope", "mcp:read mcp:act");
    authorizeUrl.searchParams.set("state", "chatgpt-state");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const consent = await app.inject({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { cookie }
    });
    expect(consent.statusCode).toBe(200);
    expect(consent.headers["cache-control"]).toBe("no-store");
    expect(consent.body).toContain("Connect ChatGPT to Grogoni");
    const requestId = consent.body.match(/request_id=([^&"]+)/u)?.[1];
    expect(requestId).toBeTruthy();

    const decision = await app.inject({
      method: "GET",
      url: `/oauth/authorize/decision?request_id=${requestId}&decision=approve`,
      headers: { cookie }
    });
    expect(decision.statusCode).toBe(302);
    const callback = new URL(String(decision.headers.location));
    expect(callback.origin + callback.pathname).toBe(
      "https://chatgpt.com/connector_platform_oauth_redirect"
    );
    expect(callback.searchParams.get("state")).toBe("chatgpt-state");
    expect(callback.searchParams.get("iss")).toBe("https://grogoni.com");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        client_id: "https://chatgpt.com/oauth/client.json",
        redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
        resource: "https://grogoni.com/mcp",
        code_verifier: verifier
      }).toString()
    });
    expect(token.statusCode).toBe(200);
    expect(token.json()).toMatchObject({
      access_token: expect.stringMatching(/^grogoni_mcp_[a-f0-9]{64}$/u),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "mcp:read mcp:act"
    });

    const initialized = await mcpPost(app, token.json().access_token, initializeRequest());
    const listed = await mcpPost(
      app,
      token.json().access_token,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      String(initialized.headers["mcp-session-id"])
    );
    expect(listed.json().result.tools[0]).toMatchObject({
      name: "grogoni.get_profile",
      outputSchema: { required: ["id"] },
      securitySchemes: [{ type: "oauth2", scopes: ["mcp:read"] }],
      _meta: { "openai/profile": true }
    });

    const replay = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        client_id: "https://chatgpt.com/oauth/client.json",
        redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
        resource: "https://grogoni.com/mcp",
        code_verifier: verifier
      }).toString()
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: "invalid_grant" });
    await app.close();
  });

  it("lets any external MCP-capable agent use the app with issued credentials", async () => {
    const app = buildApi();
    const cookie = await createSession(app, "254700000240");
    const shop = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: "External Agent Shop", language: "en" },
      cookie
    );
    await postJson(
      app,
      `/businesses/${shop.business.id}/products`,
      { name: "Agent Flour", unit: "bag", quantity: 8, sellingPrice: 210 },
      cookie
    );
    const conversation = await postJson<{ conversation: { id: string } }>(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: null, title: "External agent inbox" },
      cookie
    );
    const token = await postJson<McpTokenResponse>(
      app,
      "/v1/mcp/tokens",
      {
        name: "Muse Instinct Claude external agent",
        scopes: ["mcp:read", "mcp:act"],
        shopId: shop.business.id
      },
      cookie,
      { origin: "http://localhost:5173" }
    );

    const initialized = await app.inject({
      method: "POST",
      url: `/mcp?shopId=${encodeURIComponent(shop.business.id)}`,
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": "Muse-or-Instinct-or-Claude-compatible-MCP-client"
      },
      payload: JSON.stringify(initializeRequest())
    });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.json().result.serverInfo).toMatchObject({ name: "grogoni" });

    const sessionId = String(initialized.headers["mcp-session-id"]);
    const profile = await mcpPost(
      app,
      token.accessToken,
      toolCall(2, "grogoni.get_profile", {}),
      sessionId
    );
    expect(profile.json().result).toMatchObject({
      isError: false,
      structuredContent: { id: token.token.accountId }
    });

    const listed = await mcpPost(
      app,
      token.accessToken,
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      sessionId
    );
    expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toContain(
      "grogoni.get_inbox"
    );
    expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([
        "grogoni.search_marketplace",
        "grogoni.send_message",
        "grogoni.prepare_checkout",
        "grogoni.confirm_checkout"
      ])
    );

    const inbox = await mcpPost(
      app,
      token.accessToken,
      toolCall(4, "grogoni.get_inbox", { shopId: shop.business.id }),
      sessionId
    );
    expect(inbox.json().result).toMatchObject({
      isError: false,
      structuredContent: {
        shopId: shop.business.id,
        unreadCount: expect.any(Number),
        conversations: expect.any(Array),
        notifications: expect.arrayContaining([
          expect.objectContaining({ status: "unread", title: expect.any(String) })
        ]),
        serverTime: expect.any(String)
      }
    });

    const sent = await mcpPost(
      app,
      token.accessToken,
      toolCall(5, "grogoni.send_message", {
        conversationId: conversation.conversation.id,
        text: "Please reserve two bags for pickup.",
        idempotencyKey: "external-agent-message-1"
      }),
      sessionId
    );
    expect(sent.json().result).toMatchObject({
      isError: false,
      structuredContent: {
        conversationId: conversation.conversation.id,
        content: { type: "text", text: "Please reserve two bags for pickup." }
      }
    });

    const catalogue = await mcpPost(
      app,
      token.accessToken,
      toolCall(6, "grogoni.query_catalogue", {
        shopId: shop.business.id,
        query: "agent flour"
      }),
      sessionId
    );
    expect(catalogue.json().result).toMatchObject({
      isError: false,
      structuredContent: {
        products: [expect.objectContaining({ businessId: shop.business.id, sellingPrice: 210 })]
      }
    });

    const marketplace = await mcpPost(
      app,
      token.accessToken,
      toolCall(7, "grogoni.search_marketplace", { query: "agent flour" }),
      sessionId
    );
    const buyItem = marketplace.json().result.structuredContent.results[0];
    expect(buyItem).toMatchObject({
      title: "Agent Flour",
      price: 210,
      sourceKind: "catalogue"
    });

    const prepared = await mcpPost(
      app,
      token.accessToken,
      toolCall(8, "grogoni.prepare_checkout", {
        items: [{ ...buyItem, quantity: 2 }],
        idempotencyKey: "external-buyer-checkout-1"
      }),
      sessionId
    );
    expect(prepared.json().result).toMatchObject({
      isError: false,
      structuredContent: {
        status: "needs_confirmation",
        confirmationToken: expect.any(String)
      }
    });

    const confirmed = await mcpPost(
      app,
      token.accessToken,
      toolCall(9, "grogoni.confirm_checkout", {
        confirmationToken: prepared.json().result.structuredContent.confirmationToken
      }),
      sessionId
    );
    expect(confirmed.json().result).toMatchObject({
      isError: false,
      structuredContent: {
        handoffs: [expect.objectContaining({ kind: "catalogue", status: "requested" })],
        failures: []
      }
    });
    const repeatedConfirmation = await mcpPost(
      app,
      token.accessToken,
      toolCall(10, "grogoni.confirm_checkout", {
        confirmationToken: prepared.json().result.structuredContent.confirmationToken
      }),
      sessionId
    );
    expect(repeatedConfirmation.json().result).toMatchObject({
      isError: true,
      structuredContent: { code: "mcp_checkout_confirmation_invalid" }
    });
    await app.close();
  });

  it("connects an existing system catalogue to confirmed Grogoni Chat orders", async () => {
    const app = buildApi();
    const ownerCookie = await createSession(app, "254700000239");
    const shop = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: "API Millers", language: "en" },
      ownerCookie
    );
    const token = await postJson<McpTokenResponse>(
      app,
      "/v1/mcp/tokens",
      {
        name: "ERP connection",
        scopes: ["mcp:read", "mcp:act"],
        shopId: shop.business.id
      },
      ownerCookie
    );
    const authorization = `Bearer ${token.accessToken}`;
    const sync = await app.inject({
      method: "PUT",
      url: "/v1/shop-system/catalogue",
      headers: { authorization },
      payload: {
        products: [
          {
            sku: "FLOUR-2KG",
            name: "Maize flour 2kg",
            unit: "bag",
            quantity: 20,
            sellingPrice: 240
          }
        ]
      }
    });
    expect(sync.statusCode).toBe(200);
    expectInteractiveBudget(sync);

    const buyerCookie = await createSession(app, "254700000238");
    const search = await app.inject({
      method: "GET",
      url: "/buy/search?query=maize%20flour",
      headers: { cookie: buyerCookie }
    });
    const result = search.json().results[0];
    expect(result).toMatchObject({ title: "Maize flour 2kg", sourceKind: "catalogue" });

    const checkout = await app.inject({
      method: "POST",
      url: "/buy/checkout",
      headers: { cookie: buyerCookie },
      payload: { items: [{ ...result, quantity: 2 }] }
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json().handoffs[0]).toMatchObject({ kind: "catalogue", status: "requested" });

    const orders = await app.inject({
      method: "GET",
      url: "/v1/shop-system/orders",
      headers: { authorization }
    });
    expectInteractiveBudget(orders);
    expect(orders.json().orders[0]).toMatchObject({
      businessId: shop.business.id,
      status: "requested",
      items: [{ productName: "Maize flour 2kg", quantity: 2 }]
    });

    const accepted = await app.inject({
      method: "PATCH",
      url: `/v1/shop-system/orders/${orders.json().orders[0].id}`,
      headers: { authorization },
      payload: { status: "accepted" }
    });
    expect(accepted.json()).toMatchObject({ status: "accepted" });
    expectInteractiveBudget(accepted);
    await app.close();
  });

  it("authenticates scoped tokens and preserves runtime confirmation gates", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const cookie = await createSession(app, "254700000231");
    await postJson(
      app,
      "/auth/pin/change",
      { currentPin: "1234", pin: "2749", pinConfirmation: "2749" },
      cookie
    );
    const shop = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: "MCP Secure Shop", language: "en" },
      cookie
    );
    const token = await postJson<McpTokenResponse>(
      app,
      "/v1/mcp/tokens",
      {
        name: "Phase 4 integration",
        scopes: ["mcp:read", "mcp:act"],
        shopId: shop.business.id,
        expiresInSeconds: 2_592_000
      },
      cookie,
      { origin: "http://localhost:5173" }
    );

    expect(token.accessToken).toMatch(/^grogoni_mcp_[a-f0-9]{64}$/);
    expect(JSON.stringify(store.snapshot())).not.toContain(token.accessToken);
    expect(store.snapshot().mcpAccessTokens[0]?.tokenHash).toHaveLength(64);

    const shopLinkInitialized = await app.inject({
      method: "POST",
      url: `/mcp?shopId=${encodeURIComponent(shop.business.id)}`,
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      payload: JSON.stringify(initializeRequest())
    });
    expect(shopLinkInitialized.statusCode).toBe(200);

    const mismatchedShopLink = await app.inject({
      method: "POST",
      url: "/mcp?shopId=another-shop",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      payload: JSON.stringify(initializeRequest())
    });
    expect(mismatchedShopLink.statusCode).toBe(403);

    const unauthorized = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: initializeRequest()
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toContain("Bearer");

    const hostileOrigin = await mcpPost(app, token.accessToken, initializeRequest(), undefined, {
      origin: "https://attacker.invalid"
    });
    expect(hostileOrigin.statusCode).toBe(403);

    const initialized = await mcpPost(app, token.accessToken, initializeRequest());
    expect(initialized.statusCode).toBe(200);
    expect(initialized.json().result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } }
    });
    const mcpSessionId = String(initialized.headers["mcp-session-id"]);

    const listed = await mcpPost(
      app,
      token.accessToken,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      mcpSessionId
    );
    expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "grogoni.get_profile",
      "grogoni.list_shops",
      "grogoni.get_sync_changes",
      "grogoni.query_catalogue",
      "grogoni.get_inbox",
      "grogoni.search_marketplace",
      "grogoni.get_secure_channel",
      "grogoni.runtime_status",
      "grogoni.runtime_turn",
      "grogoni.confirm_runtime_action",
      "grogoni.send_message",
      "grogoni.register_secure_endpoint",
      "grogoni.create_secure_channel",
      "grogoni.send_secure_message",
      "grogoni.prepare_checkout",
      "grogoni.confirm_checkout",
      "grogoni.runtime_checkpoint",
      "grogoni.runtime_resume",
      "grogoni.runtime_rollback",
      "grogoni.runtime_merge",
      "grogoni.agent_swap",
      "grogoni.model_swap",
      "grogoni.execution_host_swap"
    ]);

    // product.create is auto-accepted (no confirmation gate), so it can't prove the confirmation
    // gate works over MCP - create it first (completes in this same call), then use
    // product.update (still confirmed) as the confirmation-gate proof below.
    const createdResponse = await mcpPost(
      app,
      token.accessToken,
      toolCall(3, "grogoni.runtime_turn", {
        shopId: shop.business.id,
        message: "add product sugar"
      }),
      mcpSessionId
    );
    const created = createdResponse.json().result.structuredContent;
    expect(created.turn).toMatchObject({
      status: "completed",
      plan: { toolName: "product.create", requiresConfirmation: false }
    });
    expect(store.snapshot().products).toEqual([expect.objectContaining({ name: "Sugar" })]);

    const proposedResponse = await mcpPost(
      app,
      token.accessToken,
      toolCall(4, "grogoni.runtime_turn", {
        shopId: shop.business.id,
        runtimeSessionId: created.session.id,
        message: "update product sugar ksh 200"
      }),
      mcpSessionId
    );
    const proposed = proposedResponse.json().result.structuredContent;
    expect(proposed.turn).toMatchObject({
      status: "needs_confirmation",
      plan: { toolName: "product.update", requiresConfirmation: true, executedAt: null }
    });
    expect(store.snapshot().products[0]?.sellingPrice).not.toBe(200);

    const confirmedResponse = await mcpPost(
      app,
      token.accessToken,
      toolCall(5, "grogoni.confirm_runtime_action", {
        shopId: shop.business.id,
        runtimeSessionId: proposed.session.id,
        confirmationToken: proposed.turn.plan.confirmationToken
      }),
      mcpSessionId
    );
    const confirmed = confirmedResponse.json().result.structuredContent;
    expect(confirmed.turn).toMatchObject({
      status: "completed",
      verification: { confirmationSatisfied: true }
    });
    expect(store.snapshot().products).toEqual([
      expect.objectContaining({ name: "Sugar", sellingPrice: 200 })
    ]);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/mcp/tokens/${token.token.id}`,
      headers: { cookie, origin: "http://localhost:5173" }
    });
    expect(revoked.statusCode).toBe(200);
    const afterRevocation = await mcpPost(
      app,
      token.accessToken,
      { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} },
      mcpSessionId
    );
    expect(afterRevocation.statusCode).toBe(401);
    await app.close();
  });

  it("enforces read-only scopes and shop binding", async () => {
    const app = buildApi();
    const cookie = await createSession(app, "254700000232");
    await postJson(
      app,
      "/auth/pin/change",
      { currentPin: "1234", pin: "8031", pinConfirmation: "8031" },
      cookie
    );
    const first = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: "Bound Shop", language: "en" },
      cookie
    );
    const secondCookie = await createSession(app, "254700000233");
    const second = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: "Other Shop", language: "en" },
      secondCookie
    );
    const product = await postJson<{ id: string }>(
      app,
      `/businesses/${first.business.id}/products`,
      { name: "Fresh Tomatoes", aliases: ["nyanya"], unit: "kg", quantity: 3, sellingPrice: 120 },
      cookie
    );
    const readOnlyToken = await postJson<McpTokenResponse>(
      app,
      "/v1/mcp/tokens",
      { name: "Read only token", scopes: ["mcp:read"], shopId: first.business.id },
      cookie,
      { origin: "http://localhost:5173" }
    );
    const readInitialized = await mcpPost(app, readOnlyToken.accessToken, initializeRequest());
    const readListed = await mcpPost(
      app,
      readOnlyToken.accessToken,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      String(readInitialized.headers["mcp-session-id"])
    );
    expect(readListed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "grogoni.get_profile",
      "grogoni.list_shops",
      "grogoni.get_sync_changes",
      "grogoni.query_catalogue",
      "grogoni.get_inbox",
      "grogoni.search_marketplace",
      "grogoni.get_secure_channel",
      "grogoni.runtime_status"
    ]);
    const readOnlyAction = await mcpPost(
      app,
      readOnlyToken.accessToken,
      toolCall(20, "grogoni.runtime_turn", {
        shopId: first.business.id,
        message: "add product forbidden"
      }),
      String(readInitialized.headers["mcp-session-id"])
    );
    expect(readOnlyAction.json().result).toMatchObject({
      isError: true,
      structuredContent: { code: "mcp_scope_forbidden" }
    });
    const catalogue = await mcpPost(
      app,
      readOnlyToken.accessToken,
      toolCall(3, "grogoni.query_catalogue", {
        shopId: first.business.id,
        query: "nyanya"
      }),
      String(readInitialized.headers["mcp-session-id"])
    );
    expect(catalogue.json().result).toMatchObject({
      isError: false,
      structuredContent: {
        products: [
          {
            productId: product.id,
            businessId: first.business.id,
            sellingPrice: 120,
            availability: "available"
          }
        ]
      }
    });
    const crossBusinessCatalogue = await mcpPost(
      app,
      readOnlyToken.accessToken,
      toolCall(4, "grogoni.query_catalogue", {
        shopId: second.business.id,
        query: "tomatoes"
      }),
      String(readInitialized.headers["mcp-session-id"])
    );
    expect(crossBusinessCatalogue.json().result).toMatchObject({
      isError: true,
      structuredContent: { code: "mcp_shop_forbidden" }
    });
    const token = await postJson<McpTokenResponse>(
      app,
      "/v1/mcp/tokens",
      {
        name: "Shop bound token",
        scopes: ["mcp:read", "mcp:act"],
        shopId: first.business.id
      },
      cookie,
      { origin: "http://localhost:5173" }
    );
    const initialized = await mcpPost(app, token.accessToken, initializeRequest());
    const sessionId = String(initialized.headers["mcp-session-id"]);
    const listed = await mcpPost(
      app,
      token.accessToken,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId
    );
    expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "grogoni.get_profile",
      "grogoni.list_shops",
      "grogoni.get_sync_changes",
      "grogoni.query_catalogue",
      "grogoni.get_inbox",
      "grogoni.search_marketplace",
      "grogoni.get_secure_channel",
      "grogoni.runtime_status",
      "grogoni.runtime_turn",
      "grogoni.confirm_runtime_action",
      "grogoni.send_message",
      "grogoni.register_secure_endpoint",
      "grogoni.create_secure_channel",
      "grogoni.send_secure_message",
      "grogoni.prepare_checkout",
      "grogoni.confirm_checkout",
      "grogoni.runtime_checkpoint",
      "grogoni.runtime_resume",
      "grogoni.runtime_rollback",
      "grogoni.runtime_merge",
      "grogoni.agent_swap",
      "grogoni.model_swap",
      "grogoni.execution_host_swap"
    ]);
    const forbidden = await mcpPost(
      app,
      token.accessToken,
      toolCall(3, "grogoni.runtime_turn", {
        shopId: second.business.id,
        message: "show products"
      }),
      sessionId
    );
    expect(forbidden.json().result).toMatchObject({
      isError: true,
      structuredContent: { code: "mcp_shop_forbidden" }
    });
    await app.close();
  });

  it("lets an account-wide token connect with a shopId it owns", async () => {
    const app = buildApi();
    const cookie = await createSession(app, "254700000234");
    await postJson(
      app,
      "/auth/pin/change",
      { currentPin: "1234", pin: "5170", pinConfirmation: "5170" },
      cookie
    );
    const shop = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: "Account-Wide Shop", language: "en" },
      cookie
    );
    const accountWideToken = await postJson<McpTokenResponse>(
      app,
      "/v1/mcp/tokens",
      { name: "Account-wide token", scopes: ["mcp:read"] },
      cookie,
      { origin: "http://localhost:5173" }
    );
    expect(accountWideToken.token.shopId).toBeNull();

    const shopLinked = await app.inject({
      method: "POST",
      url: `/mcp?shopId=${encodeURIComponent(shop.business.id)}`,
      headers: {
        authorization: `Bearer ${accountWideToken.accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      payload: JSON.stringify(initializeRequest())
    });
    expect(shopLinked.statusCode).toBe(200);

    const otherCookie = await createSession(app, "254700000237");
    const otherShop = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: "Unauthorized Account-Wide Shop", language: "en" },
      otherCookie
    );
    const unauthorizedShopLink = await app.inject({
      method: "POST",
      url: `/mcp?shopId=${encodeURIComponent(otherShop.business.id)}`,
      headers: {
        authorization: `Bearer ${accountWideToken.accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      payload: JSON.stringify(initializeRequest())
    });
    expect(unauthorizedShopLink.statusCode).toBe(403);
    await app.close();
  });

  it("keeps the same credential and its tools valid across browser rotation and logout", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const cookies = await createSession(app, "254700000235");
    await postJson(
      app,
      "/auth/pin/change",
      { currentPin: "1234", pin: "6428", pinConfirmation: "6428" },
      cookies
    );
    const shop = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: "Rotation Independent Shop", language: "en" },
      cookies
    );
    await postJson(
      app,
      `/businesses/${shop.business.id}/products`,
      { name: "Rotation Tea", unit: "box", quantity: 4, sellingPrice: 320 },
      cookies
    );
    const token = await postJson<McpTokenResponse>(
      app,
      "/v1/mcp/tokens",
      {
        name: "Thirty day independent token",
        scopes: ["mcp:read", "mcp:act"],
        shopId: shop.business.id,
        expiresInSeconds: 2_592_000
      },
      cookies,
      { origin: "http://localhost:5173" }
    );
    expect(Date.parse(token.token.expiresAt) - Date.parse(token.token.createdAt)).toBe(
      2_592_000_000
    );
    const originalSession = store
      .snapshot()
      .sessions.find((session) => session.revokedAt === null)!;
    expect(Date.parse(token.token.expiresAt)).toBeGreaterThan(
      Date.parse(originalSession.expiresAt)
    );
    expect(store.authenticateMcpAccessToken({ accessToken: token.accessToken }).tokenId).toBe(
      token.token.id
    );

    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: { cookie: cookies }
    });
    expect(refreshed.statusCode).toBe(200);
    expect(store.getSession(originalSession.id)).toBeNull();
    expect(
      store.snapshot().sessions.find((session) => session.id === originalSession.id)
    ).toMatchObject({ revokedAt: expect.any(String), revocationReason: "rotated" });
    expect(store.authenticateMcpAccessToken({ accessToken: token.accessToken }).tokenId).toBe(
      token.token.id
    );

    const initialized = await app.inject({
      method: "POST",
      url: `/mcp?shopId=${encodeURIComponent(shop.business.id)}`,
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      payload: JSON.stringify(initializeRequest())
    });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.headers["mcp-session-id"]).toEqual(expect.any(String));
    const mcpSessionId = String(initialized.headers["mcp-session-id"]);
    const initializedNotification = await mcpPost(
      app,
      token.accessToken,
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      mcpSessionId
    );
    expect(initializedNotification.statusCode).toBe(202);
    const listed = await mcpPost(
      app,
      token.accessToken,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      mcpSessionId
    );
    expect(listed.statusCode).toBe(200);
    const shops = await mcpPost(
      app,
      token.accessToken,
      toolCall(3, "grogoni.list_shops", {}),
      mcpSessionId
    );
    expect(shops.json().result.structuredContent).toEqual([
      expect.objectContaining({ business: expect.objectContaining({ id: shop.business.id }) })
    ]);
    const catalogue = await mcpPost(
      app,
      token.accessToken,
      toolCall(4, "grogoni.query_catalogue", { shopId: shop.business.id, query: "tea" }),
      mcpSessionId
    );
    expect(catalogue.json().result).toMatchObject({
      isError: false,
      structuredContent: { products: [expect.objectContaining({ sellingPrice: 320 })] }
    });
    const runtime = await mcpPost(
      app,
      token.accessToken,
      toolCall(5, "grogoni.runtime_turn", {
        shopId: shop.business.id,
        message: "add product coffee"
      }),
      mcpSessionId
    );
    expect(runtime.json().result).toMatchObject({
      isError: false,
      structuredContent: {
        turn: { status: "completed", plan: { toolName: "product.create" } }
      }
    });

    const loggedOut = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: extractCookie(refreshed.headers["set-cookie"]) }
    });
    expect(loggedOut.statusCode).toBe(200);
    expect(store.authenticateMcpAccessToken({ accessToken: token.accessToken }).tokenId).toBe(
      token.token.id
    );
    expect((await mcpPost(app, token.accessToken, initializeRequest())).statusCode).toBe(200);
    await app.close();
  });

  it("revalidates persisted actor, account, membership, shop, expiry, and legacy provenance", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const cookie = await createSession(app, "254700000236");
    await postJson(
      app,
      "/auth/pin/change",
      { currentPin: "1234", pin: "9814", pinConfirmation: "9814" },
      cookie
    );
    const shop = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: "Lifecycle Authorization Shop", language: "en" },
      cookie
    );
    const token = await postJson<McpTokenResponse>(
      app,
      "/v1/mcp/tokens",
      { name: "Persisted lifecycle token", scopes: ["mcp:read"], shopId: shop.business.id },
      cookie,
      { origin: "http://localhost:5173" }
    );
    const snapshot = store.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(token.accessToken);
    expect(snapshot.mcpAccessTokens[0]).toMatchObject({
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      createdBySessionId: expect.any(String)
    });

    const persisted = createCp2Store();
    persisted.hydrateSnapshot({ ...snapshot, sessions: [] });
    expect(persisted.authenticateMcpAccessToken({ accessToken: token.accessToken })).toMatchObject({
      tokenId: token.token.id,
      accountId: snapshot.accounts[0]?.id,
      userId: snapshot.users[0]?.id
    });

    const legacyToken = {
      ...snapshot.mcpAccessTokens[0]!,
      sessionId: snapshot.mcpAccessTokens[0]!.createdBySessionId
    } as (typeof snapshot.mcpAccessTokens)[number] & { sessionId: string | null };
    delete (legacyToken as Partial<(typeof snapshot.mcpAccessTokens)[number]>).createdBySessionId;
    const legacy = createCp2Store();
    legacy.hydrateSnapshot({ ...snapshot, sessions: [], mcpAccessTokens: [legacyToken] });
    expect(legacy.authenticateMcpAccessToken({ accessToken: token.accessToken }).tokenId).toBe(
      token.token.id
    );

    expect(() =>
      persisted.authenticateMcpAccessToken({
        accessToken: token.accessToken,
        now: new Date(token.token.expiresAt)
      })
    ).toThrowError(expect.objectContaining({ code: "mcp_token_invalid" }));

    const withoutMembership = createCp2Store();
    withoutMembership.hydrateSnapshot({ ...snapshot, memberships: [] });
    expect(() =>
      withoutMembership.authenticateMcpAccessToken({ accessToken: token.accessToken })
    ).toThrowError(expect.objectContaining({ code: "membership_required" }));

    const withoutShop = createCp2Store();
    withoutShop.hydrateSnapshot({ ...snapshot, businesses: [] });
    expect(() =>
      withoutShop.authenticateMcpAccessToken({ accessToken: token.accessToken })
    ).toThrowError(expect.objectContaining({ code: "business_not_found" }));

    const withoutAccount = createCp2Store();
    withoutAccount.hydrateSnapshot({ ...snapshot, accounts: [], users: [] });
    expect(() =>
      withoutAccount.authenticateMcpAccessToken({ accessToken: token.accessToken })
    ).toThrowError(expect.objectContaining({ code: "mcp_token_invalid" }));

    const suspendedAccount = createCp2Store();
    suspendedAccount.hydrateSnapshot({
      ...snapshot,
      accounts: snapshot.accounts.map((account) => ({ ...account, status: "suspended" as const }))
    });
    expect(() =>
      suspendedAccount.authenticateMcpAccessToken({ accessToken: token.accessToken })
    ).toThrowError(expect.objectContaining({ code: "mcp_token_invalid" }));
    await app.close();
  });
});

function expectInteractiveBudget(response: {
  headers: Record<string, string | string[] | undefined>;
}): void {
  expect(response.headers["x-grogoni-response-budget-class"]).toBe("interactive");
  expect(response.headers["x-grogoni-response-budget-ms"]).toBe("150");
  const timing = String(response.headers["server-timing"]);
  const duration = Number(timing.match(/dur=([\d.]+)/u)?.[1]);
  expect(duration).toBeLessThanOrEqual(150);
}

function initializeRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "grogoni-test", version: "1.0.0" }
    }
  };
}

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

const secureFixturePublicKey = {
  kty: "EC" as const,
  crv: "P-256" as const,
  x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ext: true
};

function encryptedMcpFixture(recipientDeviceIds: string[]) {
  return {
    type: "encrypted",
    attachmentCount: 0,
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "QWdlbnRhbmRtb2RlbHNlY3JldA",
    envelopes: recipientDeviceIds.map((recipientDeviceId) => ({
      version: 1,
      algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM",
      recipientDeviceId,
      ephemeralPublicKey: secureFixturePublicKey,
      salt: "AAAAAAAAAAAAAAAAAAAAAA",
      iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
    }))
  };
}

async function mcpPost(
  app: FastifyInstance,
  token: string,
  payload: unknown,
  sessionId?: string,
  extraHeaders: Record<string, string> = {}
) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      ...extraHeaders
    },
    payload: JSON.stringify(payload)
  });
}

async function createSession(app: FastifyInstance, destination: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin: "1234" })
  });
  expect(response.statusCode).toBe(200);
  return extractCookie(response.headers["set-cookie"]);
}

async function postJson<T = unknown>(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  cookie?: string,
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
      ...extraHeaders
    },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

function extractCookie(header: string | string[] | number | undefined): string {
  const values = Array.isArray(header) ? header : [header];
  expect(values.every((value) => typeof value === "string")).toBe(true);
  return values.map((value) => String(value).split(";")[0] ?? "").join("; ");
}
