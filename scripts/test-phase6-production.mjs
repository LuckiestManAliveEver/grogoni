/** Live Phase 6 acceptance probes. No deployment/config changes. Only disposable fixtures. */
import assert from "node:assert/strict";
import { randomInt, randomUUID, webcrypto as crypto } from "node:crypto";
import { URL } from "node:url";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { encryptDirectMessage, decryptDirectMessage } from "../apps/web/src/e2ee.ts";
import { deleteLiveFixtureAccounts } from "./live-fixture-cleanup.mjs";
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to test production with disposable fixtures.");
const base = process.env.SMOKE_API_URL ?? "https://grogoni.com/api";
const runId = randomUUID();
const dir = `/tmp/phase6-production/${runId}`;
const device = `phase6-production-${runId}`;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Client } = requireApi("pg");
const accountIds = new Set();
const businessIds = new Set();
const steps = [];
const evidence = { runId, base, startedAt: new Date().toISOString() };
let browser;
function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}
async function step(name, action) {
  try {
    const detail = await action();
    steps.push({ name, status: "pass", detail });
    log(`PASS ${name}`);
    return detail;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    steps.push({ name, status: "fail", detail });
    log(`FAIL ${name}: ${detail}`);
    return null;
  }
}
function unverified(name, detail) {
  steps.push({ name, status: "unverified", detail });
}
async function call(cookie, path, method = "GET", body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      cookie,
      origin: "https://grogoni.com",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-grogoni-device-id": device,
      "x-region": "us-east-1"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: globalThis.AbortSignal.timeout(90000)
  });
  const json = await res.json().catch(() => ({}));
  return {
    status: res.status,
    requestId: res.headers.get("x-request-id"),
    path,
    json,
    cookie: res.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ")
  };
}
function ok(res) {
  assert.equal(
    res.status,
    200,
    `${res.path}: HTTP ${res.status} ${res.json.code ?? res.json.message ?? ""}`
  );
  return res.json;
}
async function signup() {
  const phone = `+442079460${String(randomInt(1000)).padStart(3, "0")}`;
  const pin = String(randomInt(1000, 9999));
  const res = await call("", "/auth/pin/signup", "POST", { method: "phone", contact: phone, pin });
  const body = ok(res);
  assert.ok(body.account?.id && res.cookie, "Missing newly created account/session");
  accountIds.add(body.account.id);
  return { cookie: res.cookie, accountId: body.account.id, userId: body.user?.id, phone, pin };
}
async function identity(cookie) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits"
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKey = {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    ext: true
  };
  const id = `phase6-${randomUUID()}`;
  const registered = ok(
    await call(cookie, "/v1/e2ee/devices", "POST", {
      deviceId: id,
      label: "Disposable Phase 6 test device",
      publicKey
    })
  );
  return {
    deviceId: registered.id ?? registered.device?.id ?? id,
    privateKey: pair.privateKey,
    publicKey
  };
}
async function cleanup() {
  if (!accountIds.size) return { accounts: 0 };
  const client = new Client({
    connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
    connectionTimeoutMillis: 15000
  });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
    await deleteLiveFixtureAccounts(client, {
      accountIds: [...accountIds],
      businessIds: [...businessIds]
    });
    await client.query("commit");
    const remaining = await client.query(
      "select count(*)::int as n from accounts where id = any($1::uuid[])",
      [[...accountIds]]
    );
    assert.equal(remaining.rows[0].n, 0);
    return { removedAccounts: accountIds.size, removedBusinesses: businessIds.size };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
await mkdir(dir, { recursive: true });
try {
  const ready = await call("", "/health/ready");
  ok(ready);
  await step("production frontend build identity", async () => {
    const response = await fetch("https://grogoni.com/build-meta.json", {
      signal: globalThis.AbortSignal.timeout(30000)
    });
    assert.ok(response.ok);
    const metadata = await response.json();
    evidence.frontendBuild = metadata;
    return metadata;
  });
  const alice = await signup(),
    bob = await signup(),
    stranger = await signup();
  log("Created three disposable production accounts.");
  const context = ok(await call(alice.cookie, "/v1/session/context"));
  const daemonId = context.conversationId;
  evidence.daemonId = daemonId;
  await step("permanent DAEMON identity is returned and stable", async () => {
    const first = ok(await call(alice.cookie, "/v1/conversations"));
    const second = ok(await call(alice.cookie, "/v1/conversations"));
    const daemon = first.conversations.find((item) => item.id === daemonId);
    assert.equal(daemon?.conversationType, "DAEMON", "No authoritative DAEMON conversationType");
    assert.equal(daemon.isPermanentDaemon, true, "Permanent daemon marker absent");
    assert.ok(second.conversations.some((item) => item.id === daemonId && item.isPermanentDaemon));
    return { conversationId: daemonId };
  });
  const directBody = {
    kind: "personal",
    activeShopId: null,
    recipient: bob.phone,
    title: `Phase6 direct ${runId}`
  };
  const direct = ok(await call(alice.cookie, "/v1/conversations", "POST", directBody));
  const directId = direct.conversation.id;
  evidence.directId = directId;
  await step("DIRECT identity has no fake agent or inference binding", async () => {
    assert.equal(direct.conversation.conversationType, "DIRECT");
    assert.equal(direct.conversation.runtimeBindingId, null);
    assert.ok(!direct.participants.some((p) => p.role === "agent"));
    return { conversationId: directId };
  });
  await step("concurrent direct creation in both directions reuses the same pair", async () => {
    const results = await Promise.all([
      call(alice.cookie, "/v1/conversations", "POST", directBody),
      call(alice.cookie, "/v1/conversations", "POST", directBody),
      call(bob.cookie, "/v1/conversations", "POST", { ...directBody, recipient: alice.phone })
    ]);
    const ids = results.map((res) => ok(res).conversation.id);
    assert.equal(
      new Set([directId, ...ids]).size,
      1,
      `Created ${new Set([directId, ...ids]).size} conversations for one pair`
    );
    return { ids };
  });
  await step("direct plaintext is rejected", async () => {
    const result = await call(alice.cookie, "/v1/messages", "POST", {
      conversationId: directId,
      clientMessageId: `plaintext-${randomUUID()}`,
      content: { type: "text", text: "This must not be stored." }
    });
    assert.equal(result.status, 400);
    assert.equal(result.json.code, "e2ee_required");
    return { code: result.json.code };
  });
  const aliceKey = await identity(alice.cookie),
    bobKey = await identity(bob.cookie);
  const devices = ok(
    await call(alice.cookie, `/v1/conversations/${directId}/encryption-devices`)
  ).devices;
  let aliceMessage;
  await step("A sends an encrypted message; B decrypts and replies; A decrypts", async () => {
    const firstText = `Phase6 hello ${runId}`;
    const content = await encryptDirectMessage({
      conversationId: directId,
      devices,
      message: { text: firstText, attachments: [] }
    });
    aliceMessage = {
      conversationId: directId,
      clientMessageId: `encrypted-${randomUUID()}`,
      idempotencyKey: `phase6-${randomUUID()}`,
      content
    };
    const sent = ok(await call(alice.cookie, "/v1/messages", "POST", aliceMessage));
    const received = ok(await call(bob.cookie, `/v1/conversations/${directId}`));
    const incoming = received.messages.find((m) => m.id === sent.id);
    assert.ok(incoming, "B did not receive A's message");
    assert.equal(
      (
        await decryptDirectMessage({
          conversationId: directId,
          content: incoming.content,
          identity: bobKey
        })
      ).text,
      firstText
    );
    const replyText = `Phase6 reply ${runId}`;
    const reply = ok(
      await call(bob.cookie, "/v1/messages", "POST", {
        conversationId: directId,
        clientMessageId: `reply-${randomUUID()}`,
        replyToMessageId: sent.id,
        content: await encryptDirectMessage({
          conversationId: directId,
          devices,
          message: { text: replyText, attachments: [] }
        })
      })
    );
    const restored = ok(await call(alice.cookie, `/v1/conversations/${directId}`));
    assert.equal(
      (
        await decryptDirectMessage({
          conversationId: directId,
          content: restored.messages.find((m) => m.id === reply.id).content,
          identity: aliceKey
        })
      ).text,
      replyText
    );
    const inbox = ok(await call(alice.cookie, "/v1/conversations"));
    assert.ok(inbox.conversations.some((item) => item.id === directId && item.unreadCount > 0));
    return { messageId: sent.id, replyId: reply.id, unread: true };
  });
  await step("concurrent encrypted message replay stores one message", async () => {
    assert.ok(aliceMessage);
    const results = await Promise.all([
      call(alice.cookie, "/v1/messages", "POST", aliceMessage),
      call(alice.cookie, "/v1/messages", "POST", aliceMessage)
    ]);
    const ids = results.map((res) => ok(res).id);
    assert.equal(new Set(ids).size, 1);
    const restored = ok(await call(bob.cookie, `/v1/conversations/${directId}`));
    assert.equal(
      restored.messages.filter((m) => m.clientMessageId === aliceMessage.clientMessageId).length,
      1
    );
    return { messageId: ids[0] };
  });
  await step(
    "unauthorized account cannot read or write direct or daemon conversations",
    async () => {
      for (const id of [directId, daemonId]) {
        assert.equal((await call(stranger.cookie, `/v1/conversations/${id}`)).status, 404);
        assert.equal(
          (
            await call(stranger.cookie, "/v1/messages", "POST", {
              conversationId: id,
              clientMessageId: `forbidden-${randomUUID()}`,
              content: { type: "text", text: "unauthorized probe" }
            })
          ).status,
          404
        );
      }
      return { readAndWriteDenied: true };
    }
  );
  await step(
    "phonebook selection reopens the direct pair and rejects another owner's node",
    async () => {
      const synced = ok(
        await call(alice.cookie, "/network/sync/contacts", "POST", {
          contacts: [{ name: "Disposable Phase6 Bob", phone: bob.phone }]
        })
      );
      const node = synced.syncedContactNodeIds?.[0];
      assert.ok(node, "No synced contact node ID");
      const selected = ok(
        await call(alice.cookie, "/v1/conversations", "POST", {
          kind: "personal",
          activeShopId: null,
          recipient: `network-node:${node}`
        })
      );
      assert.equal(selected.conversation.id, directId);
      assert.equal(
        (
          await call(stranger.cookie, "/v1/conversations", "POST", {
            kind: "personal",
            activeShopId: null,
            recipient: `network-node:${node}`
          })
        ).status,
        404
      );
      return { nodeResolved: true };
    }
  );
  const createdBusiness = ok(
    await call(bob.cookie, "/businesses", "POST", {
      name: `Phase6 disposable ${runId.slice(0, 8)}`,
      language: "en"
    })
  );
  const shopId = createdBusiness.business.id;
  businessIds.add(shopId);
  evidence.shopId = shopId;
  const business = await step(
    "customer can open the registered business conversation",
    async () => {
      return ok(
        await call(alice.cookie, "/v1/conversations", "POST", {
          kind: "storefront",
          activeShopId: shopId,
          title: `Phase6 business ${runId}`
        })
      );
    }
  );
  const businessId = business?.conversation.id ?? null;
  if (business) {
    evidence.businessConversationId = businessId;
    await step(
      "business conversation creation is idempotent and authoritatively typed",
      async () => {
        assert.equal(business.conversation.conversationType, "BUSINESS");
        const again = ok(
          await call(alice.cookie, "/v1/conversations", "POST", {
            kind: "storefront",
            activeShopId: shopId
          })
        );
        assert.equal(again.conversation.id, businessId);
        return { conversationId: businessId };
      }
    );
    await step(
      "customer message reaches business inbox and owner replies in the same conversation",
      async () => {
        const sent = ok(
          await call(alice.cookie, "/v1/messages", "POST", {
            conversationId: businessId,
            clientMessageId: `customer-${randomUUID()}`,
            content: { type: "text", text: "Are you open? This is a disposable acceptance test." }
          })
        );
        const ownerInbox = ok(await call(bob.cookie, "/v1/conversations"));
        assert.ok(
          ownerInbox.conversations.some((item) => item.id === businessId),
          "Customer conversation missing from owner's inbox"
        );
        const thread = ok(await call(bob.cookie, `/v1/conversations/${businessId}`));
        assert.ok(thread.messages.some((item) => item.id === sent.id));
        const reply = ok(
          await call(bob.cookie, "/v1/messages", "POST", {
            conversationId: businessId,
            clientMessageId: `business-reply-${randomUUID()}`,
            content: { type: "text", text: "Yes, this is the fixture owner's reply." }
          })
        );
        const customer = ok(await call(alice.cookie, `/v1/conversations/${businessId}`));
        assert.ok(customer.messages.some((item) => item.id === reply.id));
        return { messageId: sent.id, replyId: reply.id };
      }
    );
    await step("unrelated account cannot read or write business conversation", async () => {
      assert.equal((await call(stranger.cookie, `/v1/conversations/${businessId}`)).status, 404);
      assert.equal(
        (
          await call(stranger.cookie, "/v1/messages", "POST", {
            conversationId: businessId,
            clientMessageId: `forbidden-business-${randomUUID()}`,
            content: { type: "text", text: "forbidden" }
          })
        ).status,
        404
      );
      return { denied: true };
    });
    await step("agent request cannot substitute a different tenant", async () => {
      const result = await call(alice.cookie, "/v1/messages", "POST", {
        conversationId: businessId,
        clientMessageId: `cross-tenant-${randomUUID()}`,
        content: { type: "text", text: "No tools; routing validation probe." },
        agent: { businessId: randomUUID(), message: "No tools; routing validation probe." }
      });
      assert.equal(result.status, 403);
      assert.equal(result.json.code, "conversation_business_mismatch");
      return { code: result.json.code };
    });
    await step(
      "authorized business runtime responds in the existing customer conversation",
      async () => {
        ok(
          await call(bob.cookie, `/v1/conversations/${businessId}`, "PATCH", { agentEnabled: true })
        );
        const res = ok(
          await call(bob.cookie, "/v1/messages", "POST", {
            conversationId: businessId,
            clientMessageId: `business-agent-${randomUUID()}`,
            content: {
              type: "text",
              text: "Reply with the exact token PHASE6-BUSINESS. Do not call tools."
            },
            agent: {
              businessId: shopId,
              message: "Reply with the exact token PHASE6-BUSINESS. Do not call tools."
            }
          })
        );
        evidence.businessRuntime = {
          processing: res.processing,
          model: res.runtime?.turn?.model,
          replyText: res.agentMessage?.content?.text ?? null
        };
        assert.ok(
          res.agentMessage?.content?.text?.includes("PHASE6-BUSINESS"),
          `No real business agent response: ${JSON.stringify(evidence.businessRuntime)}`
        );
        return { model: res.runtime?.turn?.model?.modelId, messageId: res.agentMessage.id };
      }
    );
    await step("revoked business membership loses inbox, read and write access", async () => {
      const invitation = ok(
        await call(bob.cookie, `/businesses/${shopId}/staff/invitations`, "POST", {
          role: "manager",
          name: "Phase6 staff",
          phone: stranger.phone
        })
      );
      const joined = ok(
        await call(stranger.cookie, `/v1/staff-invitations/${invitation.id}/accept`, "POST", {})
      );
      ok(await call(stranger.cookie, `/v1/conversations/${businessId}`));
      ok(
        await call(
          bob.cookie,
          `/businesses/${shopId}/staff/members/${joined.membership.id}`,
          "DELETE",
          {}
        )
      );
      assert.equal((await call(stranger.cookie, `/v1/conversations/${businessId}`)).status, 404);
      assert.equal(
        (
          await call(stranger.cookie, "/v1/messages", "POST", {
            conversationId: businessId,
            clientMessageId: randomUUID(),
            content: { type: "text", text: "revoked" }
          })
        ).status,
        404
      );
      assert.ok(
        !ok(await call(stranger.cookie, "/v1/conversations")).conversations.some(
          (c) => c.id === businessId
        )
      );
      return { revoked: true };
    });
  } else {
    unverified(
      "business inbox reply, tenant routing and business agent response",
      "Customer conversation creation failed; dependent business workflows could not run."
    );
  }
  let daemonTask;
  await step("daemon task retains its authorized conversation association", async () => {
    ok(
      await call(alice.cookie, "/v1/messages", "POST", {
        conversationId: daemonId,
        clientMessageId: `daemon-user-${runId}`,
        content: { type: "text", text: "Reply with PHASE6-PRODUCTION. Do not call tools." }
      })
    );
    const res = await call(alice.cookie, "/v1/daemon/tasks", "POST", {
      key: `phase6-${runId}`,
      message: "Reply with PHASE6-PRODUCTION. Do not call tools.",
      conversation: {
        id: daemonId,
        clientMessageId: `daemon-user-${runId}`,
        scope: JSON.stringify(["marketplace", null, daemonId]),
        kind: "reply"
      }
    });
    assert.ok([200, 201].includes(res.status), `Task HTTP ${res.status} ${res.json.code}`);
    daemonTask = res.json.task;
    assert.equal(
      daemonTask.payload.conversation?.id,
      daemonId,
      "Server discarded originating conversation"
    );
    return { taskId: daemonTask.id, modelId: daemonTask.payload.modelId };
  });
  await step("real production daemon model responds and task survives reload", async () => {
    assert.ok(daemonTask, "Daemon task was not created");
    const claim = ok(await call(alice.cookie, "/v1/daemon/claims", "POST", {})).claim;
    assert.equal(claim?.task?.id, daemonTask.id);
    const result = ok(
      await call(alice.cookie, `/v1/daemon/claims/${daemonTask.id}/execute`, "POST", {
        leaseToken: claim.leaseToken
      })
    ).task;
    assert.equal(result.status, "completed", result.errorCode);
    assert.ok(result.result?.text?.includes("PHASE6-PRODUCTION"));
    const restored = ok(await call(alice.cookie, `/v1/daemon/tasks/${daemonTask.id}`)).task;
    assert.equal(restored.result.text, result.result.text);
    evidence.realModel = { modelId: result.result.modelId, text: result.result.text };
    return evidence.realModel;
  });
  await step(
    "daemon result is delivered into its originating conversation without browser projection",
    async () => {
      assert.ok(daemonTask);
      const thread = ok(await call(alice.cookie, `/v1/conversations/${daemonId}`));
      assert.ok(
        thread.messages.some(
          (m) => m.author === "agent" && m.content?.text?.includes("PHASE6-PRODUCTION")
        ),
        "Completed task result is absent from conversation history"
      );
      return { delivered: true };
    }
  );
  await step(
    "untrusted caller cannot associate daemon work with another account's conversation",
    async () => {
      const result = await call(stranger.cookie, "/v1/daemon/tasks", "POST", {
        key: `forbidden-${runId}`,
        message: "No tools; ownership validation probe.",
        runAt: new Date(Date.now() + 3600000).toISOString(),
        conversation: {
          id: daemonId,
          clientMessageId: `forbidden-${runId}`,
          scope: "forbidden",
          kind: "reply"
        }
      });
      if ([200, 201].includes(result.status) && result.json.task?.id)
        await call(stranger.cookie, `/v1/daemon/tasks/${result.json.task.id}`, "DELETE");
      assert.ok(
        [403, 404].includes(result.status),
        `Unauthorized association accepted: HTTP ${result.status}`
      );
      return { status: result.status };
    }
  );
  await step("all three conversation identities restore in one inbox", async () => {
    const refreshed = ok(
      await call(alice.cookie, "/auth/pin/login", "POST", {
        method: "phone",
        contact: alice.phone,
        pin: alice.pin
      })
    );
    assert.ok(refreshed.account?.id === alice.accountId);
    const inbox = ok(await call(alice.cookie, "/v1/conversations"));
    for (const [id, type] of [
      [daemonId, "DAEMON"],
      [directId, "DIRECT"],
      [businessId, "BUSINESS"]
    ]) {
      const item = inbox.conversations.find((c) => c.id === id);
      assert.equal(
        item?.conversationType,
        type,
        `${type} not restored with authoritative identity`
      );
    }
    return { types: ["DAEMON", "DIRECT", "BUSINESS"] };
  });
  await step("owned failed-task retry route exists and hides foreign task IDs", async () => {
    const result = await call(
      stranger.cookie,
      `/v1/daemon/tasks/${daemonTask?.id ?? randomUUID()}/retry`,
      "POST",
      {}
    );
    assert.equal(result.status, 404);
    assert.equal(
      result.json.code,
      "task_not_found",
      "No owned retry endpoint (generic route 404 is not sufficient)"
    );
    return { unauthorizedRetryHidden: true };
  });
  await step(
    "failed daemon task stays visible and can be retried through an owned route",
    async () => {
      const created = await call(alice.cookie, "/v1/daemon/tasks", "POST", {
        key: `failure-${runId}`,
        message: "Disposable failure visibility probe. No tools."
      });
      assert.ok([200, 201].includes(created.status));
      const id = created.json.task.id;
      const claim = ok(await call(alice.cookie, "/v1/daemon/claims", "POST", {})).claim;
      assert.equal(claim?.task?.id, id);
      const settled = ok(
        await call(alice.cookie, `/v1/daemon/claims/${id}/settle`, "POST", {
          leaseToken: claim.leaseToken,
          outcome: { errorCode: "PHASE6_TEST_FAILURE", retryable: false }
        })
      ).task;
      assert.equal(settled.status, "failed");
      const visible = ok(await call(alice.cookie, `/v1/daemon/tasks/${id}`)).task;
      assert.equal(visible.errorCode, "PHASE6_TEST_FAILURE");
      const isolatedText = `Direct during daemon failure ${runId}`;
      const sentWhileFailed = ok(
        await call(alice.cookie, "/v1/messages", "POST", {
          conversationId: directId,
          clientMessageId: randomUUID(),
          content: await encryptDirectMessage({
            conversationId: directId,
            devices,
            message: { text: isolatedText, attachments: [] }
          })
        })
      );
      const recipient = ok(await call(bob.cookie, `/v1/conversations/${directId}`));
      const message = recipient.messages.find((m) => m.id === sentWhileFailed.id);
      assert.equal(
        (
          await decryptDirectMessage({
            conversationId: directId,
            content: message.content,
            identity: bobKey
          })
        ).text,
        isolatedText
      );

      evidence.failedTaskVisibility = { status: visible.status, errorCode: visible.errorCode };
      const retry = await call(alice.cookie, `/v1/daemon/tasks/${id}/retry`, "POST", {});
      assert.ok(
        [200, 202].includes(retry.status),
        `Failed task remained visible, but owned retry returned HTTP ${retry.status} ${retry.json.code ?? ""}`
      );
      const retryClaim = ok(await call(alice.cookie, "/v1/daemon/claims", "POST", {})).claim;
      assert.equal(retryClaim?.task?.id, id);
      const completed = ok(
        await call(alice.cookie, `/v1/daemon/claims/${id}/execute`, "POST", {
          leaseToken: retryClaim.leaseToken
        })
      ).task;
      assert.equal(completed.status, "completed", completed.errorCode);
      return { taskId: id, retryStatus: retry.status, completed: true };
    }
  );
  await step("real browser push subscription receives a private message notification", async () => {
    const { chromium, firefox } = await import("@playwright/test");
    const chrome =
      process.env.PHASE6_PUSH_BROWSER === "firefox"
        ? await firefox.launch({
            headless: true,
            firefoxUserPrefs: {
              "dom.push.enabled": true,
              "permissions.default.desktop-notification": 1
            }
          })
        : await chromium.launch({
            channel: "chrome",
            headless: true,
            ignoreDefaultArgs: ["--disable-background-networking"],
            args: ["--enable-features=PushMessaging"]
          });
    try {
      const ctx = await chrome.newContext({ permissions: ["notifications"] });
      const page = await ctx.newPage();
      await page.goto("https://grogoni.com/", {
        waitUntil: "domcontentloaded"
      });
      const config = ok(await call(bob.cookie, "/v1/push/config"));
      assert.equal(config.enabled, true, "Cloud push configuration unavailable");
      const subscription = await page.evaluate(async (publicKey) => {
        await globalThis.navigator.serviceWorker.register("/sw.js");
        const registration = await globalThis.navigator.serviceWorker.ready;
        const normalized = publicKey.replace(/-/g, "+").replace(/_/g, "/");
        const key = Uint8Array.from(
          globalThis.atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4)),
          (c) => c.charCodeAt(0)
        );
        const timeout = new Promise((_, reject) =>
          globalThis.setTimeout(
            () => reject(new Error("Browser push subscription timed out")),
            45000
          )
        );
        return JSON.parse(
          JSON.stringify(
            await Promise.race([
              registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: key
              }),
              timeout
            ])
          )
        );
      }, config.publicKey);
      ok(await call(bob.cookie, "/v1/push/subscriptions", "POST", subscription));
      const sent = ok(
        await call(alice.cookie, "/v1/messages", "POST", {
          conversationId: directId,
          clientMessageId: randomUUID(),
          content: await encryptDirectMessage({
            conversationId: directId,
            devices,
            message: { text: `Push private ${runId}`, attachments: [] }
          })
        })
      );
      await page.waitForFunction(
        async (id) => {
          const reg = await globalThis.navigator.serviceWorker.ready;
          return (await reg.getNotifications({ tag: `grogoni-message-${id}` })).length > 0;
        },
        sent.id,
        { timeout: 45000 }
      );
      const notifications = await page.evaluate(async () =>
        (await (await globalThis.navigator.serviceWorker.ready).getNotifications()).map((n) => ({
          tag: n.tag,
          body: n.body
        }))
      );
      assert.ok(
        notifications.every((n) => !n.body.includes(runId)),
        "Private plaintext leaked into push"
      );
      return { received: true, messageId: sent.id, private: true };
    } finally {
      await chrome.close();
    }
  });
  if (process.env.PHASE6_SKIP_BROWSER !== "true")
    await step("production browser exposes the common conversation list after reload", async () => {
      const { chromium } = await import("@playwright/test");
      browser = await chromium.launch({ headless: true });
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        extraHTTPHeaders: { "x-grogoni-device-id": device }
      });
      await ctx.addCookies(
        alice.cookie.split("; ").map((entry) => {
          const split = entry.indexOf("=");
          return {
            name: entry.slice(0, split),
            value: entry.slice(split + 1),
            domain: "grogoni.com",
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax"
          };
        })
      );
      await ctx.addInitScript(
        ({ device }) => {
          globalThis.localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
          globalThis.localStorage.setItem("grogoni.device-id.v1", device);
        },
        { device }
      );
      const page = await ctx.newPage();
      await page.goto(`https://grogoni.com/marketplace/conversations/${daemonId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });
      const browserInbox = await page.request.get(`${base}/v1/conversations`);
      assert.equal(browserInbox.status(), 200, "Authenticated browser inbox request failed");
      await page.waitForFunction(
        (ids) =>
          ids.every((id) => globalThis.document.querySelector(`[data-conversation-id="${id}"]`)),
        [daemonId, directId, businessId].filter(Boolean),
        { timeout: 60000 }
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        (ids) =>
          ids.every((id) => globalThis.document.querySelector(`[data-conversation-id="${id}"]`)),
        [daemonId, directId, businessId].filter(Boolean),
        { timeout: 60000 }
      );
      const labels = await page.locator(".conversation-item .session-badge").allTextContents();
      await page.screenshot({ path: `${dir}/messenger.png`, fullPage: true });
      assert.ok(
        labels.includes("DIRECT") && labels.includes("BUSINESS") && labels.includes("DAEMON"),
        `Unified labels missing: ${labels.join(", ")}`
      );
      return { labels, screenshot: `${dir}/messenger.png` };
    });
  await step(
    "account model switching preserves daemon history and executes the second model",
    async () => {
      const path = `/v1/conversations/${daemonId}/model`;
      const selection = ok(await call(alice.cookie, path));
      const alternate = selection.models.find((m) => m.id !== selection.selectedModelId);
      assert.ok(alternate, "Second configured model is absent");
      const before = ok(await call(alice.cookie, `/v1/conversations/${daemonId}`));
      ok(await call(alice.cookie, path, "PUT", { modelId: alternate.id }));
      assert.equal(ok(await call(alice.cookie, path)).selectedModelId, alternate.id);
      const after = ok(await call(alice.cookie, `/v1/conversations/${daemonId}`));
      assert.deepEqual(
        after.messages.map((m) => m.id),
        before.messages.map((m) => m.id)
      );
      const created = await call(alice.cookie, "/v1/daemon/tasks", "POST", {
        key: `second-model-${runId}`,
        message: "Reply with PHASE6-SECOND. Do not call tools.",
        conversation: {
          id: daemonId,
          clientMessageId: `second-${runId}`,
          scope: "model-switch",
          kind: "reply"
        }
      });
      assert.ok([200, 201].includes(created.status));
      const id = created.json.task.id;
      assert.equal(created.json.task.payload.modelId, alternate.id);
      const claim = ok(await call(alice.cookie, "/v1/daemon/claims", "POST", {})).claim;
      assert.equal(claim?.task?.id, id);
      const result = ok(
        await call(alice.cookie, `/v1/daemon/claims/${id}/execute`, "POST", {
          leaseToken: claim.leaseToken
        })
      ).task;
      assert.equal(result.status, "completed", result.errorCode);
      assert.ok(result.result.text.includes("PHASE6-SECOND"));
      return {
        firstModel: selection.selectedModelId,
        secondModel: alternate.id,
        historyPreserved: true
      };
    }
  );
} catch (error) {
  steps.push({
    name: "test setup or continuation",
    status: "fail",
    detail: error instanceof Error ? error.message : String(error)
  });
  log(`STOP ${String(error)}`);
} finally {
  await browser?.close().catch(() => {});
  await step("remove and verify all disposable production fixtures", cleanup);
  const report = {
    ...evidence,
    completedAt: new Date().toISOString(),
    passed: steps.every((s) => s.status === "pass"),
    counts: {
      pass: steps.filter((s) => s.status === "pass").length,
      fail: steps.filter((s) => s.status === "fail").length,
      unverified: steps.filter((s) => s.status === "unverified").length
    },
    steps
  };
  await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2));
  log(`RESULT ${JSON.stringify(report.counts)}; evidence: ${dir}/report.json`);
  if (report.counts.fail) process.exitCode = 1;
}
