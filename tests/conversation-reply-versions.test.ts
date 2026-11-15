import { describe, expect, it } from "vitest";
import type {
  ConversationMessageSummary,
  ModelExecutionTarget
} from "../packages/shared-types/src";
import {
  appendReplyVersion,
  isReplyVersionId,
  maxReplyVersions,
  replyRegenerationBlock,
  replyVersionsOf,
  selectReplyVersion,
  strongerAgentTurnEffect,
  type ReplyVersionSubject
} from "../packages/shared-types/src/reply-versions";
import { buildApi } from "../services/api/src/app";
import {
  assertRegenerationInputs,
  regenerationAllowsTool
} from "../services/api/src/cp2/domains/agent-runtime/regeneration";
import { runtimeToolRegistry } from "../packages/tool-core/src";
import type { ModelRuntimeAdapter } from "../services/api/src/inference/model-runtime";
import { createLocalDefaultCp2Store as createCp2Store } from "./fixtures/local-default-store";

/**
 * Reply versions (docs/architecture/conversation-reply-versions.md): regenerating an agent reply
 * appends an answer to the same message and can never repeat, start or queue a business action.
 * The server tests drive the real API routes and runtime with a scripted model.
 */

const modelId = "qwen2.5-0.5b-android";
const answer = (message: string) => JSON.stringify({ type: "response", message });
const createProduct = (name: string) =>
  JSON.stringify({
    type: "tool",
    toolName: "product.create",
    input: { name, unit: "unit", quantity: 4 },
    reason: "The merchant asked to add a product."
  });
const proposeTool = (toolName: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "tool", toolName, input, reason: "Proposed by the scripted model." });
const listProducts = JSON.stringify({ type: "tool", toolName: "products.list", input: {} });

describe("reply version rules (pure)", () => {
  const reply: ReplyVersionSubject = {
    author: "agent",
    replyToMessageId: "question-1",
    createdAt: "2026-11-13T08:00:00.000Z",
    content: { type: "text", text: "First answer." },
    agentTurnEffect: "none"
  };

  it("allows only a plain-text agent reply whose turn is known to have changed nothing", () => {
    expect(replyRegenerationBlock(reply)).toBeNull();
    expect(replyRegenerationBlock({ ...reply, agentTurnEffect: "read" })).toBeNull();
    expect(replyRegenerationBlock({ ...reply, author: "user" })).toBe("not_agent_reply");
    expect(replyRegenerationBlock({ ...reply, replyToMessageId: null })).toBe("not_agent_reply");
    expect(replyRegenerationBlock({ ...reply, deletedAt: "2026-11-13T09:00:00.000Z" })).toBe(
      "deleted"
    );
    expect(replyRegenerationBlock({ ...reply, content: { type: "confirmation" } })).toBe(
      "not_text"
    );
    expect(
      replyRegenerationBlock({
        ...reply,
        content: { type: "text", text: "Here is the file.", attachments: [{ id: "a" }] }
      })
    ).toBe("has_attachments");
    expect(
      replyRegenerationBlock({
        ...reply,
        content: { type: "text", text: "Task started.", businessTask: { taskId: "t" } }
      })
    ).toBe("business_task");
    expect(replyRegenerationBlock({ ...reply, agentTurnEffect: "action" })).toBe("turn_acted");
  });

  it("fails closed for a reply written before the turn effect was recorded", () => {
    const legacy: ReplyVersionSubject = { ...reply };
    delete legacy.agentTurnEffect;
    expect(replyRegenerationBlock(legacy)).toBe("turn_effect_unknown");
  });

  it("treats a never-regenerated reply as one original version and appends without rewriting", () => {
    const original = replyVersionsOf(reply);
    expect(original).toEqual({
      selected: 0,
      versions: [{ id: "original", text: "First answer.", createdAt: reply.createdAt }]
    });
    const second = appendReplyVersion(original, {
      id: "version-0002",
      text: "Second answer.",
      createdAt: "2026-11-13T08:01:00.000Z"
    });
    expect(second.selected).toBe(1);
    expect(second.versions[0]).toBe(original.versions[0]);
    expect(original.versions).toHaveLength(1);
    expect(selectReplyVersion(second, 0)).toEqual({ selected: 0, versions: second.versions });
    for (const index of [-1, 2, 0.5, Number.NaN])
      expect(selectReplyVersion(second, index)).toBeNull();
  });

  it("stops at the version limit and repairs an out-of-range stored selection", () => {
    let versions = replyVersionsOf(reply);
    while (versions.versions.length < maxReplyVersions)
      versions = appendReplyVersion(versions, {
        id: `version-000${versions.versions.length}`,
        text: `Answer ${versions.versions.length}.`,
        createdAt: reply.createdAt
      });
    expect(replyRegenerationBlock({ ...reply, replyVersions: versions })).toBe("version_limit");
    expect(
      replyVersionsOf({ ...reply, replyVersions: { ...versions, selected: 99 } }).selected
    ).toBe(maxReplyVersions - 1);
  });

  it("keeps the strongest effect and accepts only safe version ids", () => {
    expect(strongerAgentTurnEffect("none", "read")).toBe("read");
    expect(strongerAgentTurnEffect("action", "none")).toBe("action");
    expect(isReplyVersionId("3f6c1c0e-6f0e-4d2a-9a57-0c7a4b2f9d11")).toBe(true);
    for (const bad of ["original", "short", "has space 123", "a".repeat(65), 12345678, null])
      expect(isReplyVersionId(bad)).toBe(false);
  });
});

describe("regenerated turn guard (pure)", () => {
  it("allows only low-risk read-only tools outside the computer runtime", () => {
    const allowed = Object.values(runtimeToolRegistry)
      .filter((definition) => regenerationAllowsTool(definition))
      .map((definition) => definition.name);
    expect(allowed).toContain("products.list");
    expect(allowed).toContain("unknown.clarify");
    for (const name of allowed) {
      expect(runtimeToolRegistry[name].readOnly).toBe(true);
      expect(runtimeToolRegistry[name].requiresConfirmation).toBe(false);
      expect(name.startsWith("computer.")).toBe(false);
    }
    for (const name of [
      "product.create",
      "product.delete",
      "messaging.send",
      "sale.record"
    ] as const)
      expect(regenerationAllowsTool(runtimeToolRegistry[name])).toBe(false);
    for (const name of ["computer.navigate", "computer.observe", "computer.scroll"] as const)
      expect(regenerationAllowsTool(runtimeToolRegistry[name])).toBe(false);
  });

  it("refuses every input that exists only to act", () => {
    expect(() => assertRegenerationInputs({ regeneration: true })).not.toThrow();
    expect(() => assertRegenerationInputs({ confirmationToken: "token" })).not.toThrow();
    for (const extra of [
      { confirmationToken: "token" },
      { plannedStep: {} },
      { portableSkill: {} },
      { channelDelegation: {} }
    ])
      expect(() => assertRegenerationInputs({ regeneration: true, ...extra })).toThrow(
        /change business records/u
      );
  });
});

describe("regenerating an agent reply (API)", () => {
  it("appends a version to the same message, keeps the first answer, and replays a repeated id", async () => {
    const t = await setup([answer("First answer."), answer("Second answer.")]);
    const first = await t.ask("ask-version-0001", "Tell me about weekend opening hours.");
    expect(first.agentMessage).toMatchObject({
      content: { type: "text", text: "First answer." },
      agentTurnEffect: "none"
    });

    const regenerated = await t.regenerate(first.agentMessage.id, "version-aaaa-0001");
    expect(regenerated.statusCode).toBe(200);
    const body = regenerated.json<ConversationMessageSummary>();
    expect(body.id).toBe(first.agentMessage.id);
    expect(body.createdAt).toBe(first.agentMessage.createdAt);
    expect(body.editedAt).toBeNull();
    expect(body.content).toMatchObject({ type: "text", text: "Second answer." });
    expect(body.replyVersions).toMatchObject({
      selected: 1,
      versions: [
        { id: "original", text: "First answer." },
        { id: "version-aaaa-0001", text: "Second answer." }
      ]
    });

    // A retry of the same request (its answer was lost) writes nothing and calls no model.
    const callsBefore = t.model.calls;
    const replayed = await t.regenerate(first.agentMessage.id, "version-aaaa-0001");
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json<ConversationMessageSummary>().replyVersions?.versions).toHaveLength(2);
    expect(t.model.calls).toBe(callsBefore);

    // The thread is still one question and one reply, for every client old or new.
    const thread = await t.thread();
    expect(thread.map((message) => message.content)).toMatchObject([
      { text: "Tell me about weekend opening hours." },
      { text: "Second answer." }
    ]);
    expect(t.audit("message.regenerated")).toHaveLength(1);
    expect(t.audit("message.regenerated")[0]?.payload).toMatchObject({
      versionId: "version-aaaa-0001",
      versionCount: 2,
      effect: "none"
    });
    await t.close();
  });

  it("does not show the model its own earlier answer as history", async () => {
    const t = await setup([answer("First answer."), answer("Second answer.")]);
    const first = await t.ask("ask-history-0001", "What should I stock for the rains?");
    await t.regenerate(first.agentMessage.id, "version-hist-0001");
    const prompt = JSON.stringify(t.model.prompts.at(-1));
    expect(prompt).toContain("What should I stock for the rains?");
    expect(prompt).not.toContain("First answer.");
    await t.close();
  });

  it("refuses a version that would change business records, and writes nothing", async () => {
    const t = await setup([answer("We can add that later."), createProduct("Sugar 2kg")]);
    const first = await t.ask("ask-action-0001", "Should I start selling sugar?");
    const productsBefore = t.products().length;

    const refused = await t.regenerate(first.agentMessage.id, "version-act-00001");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "regeneration_would_act", retryable: false });
    expect(t.products()).toHaveLength(productsBefore);
    const reply = (await t.thread())[1]!;
    expect(reply.content).toMatchObject({ text: "We can add that later." });
    expect(reply.replyVersions).toBeUndefined();
    expect(t.audit("message.regenerated")).toHaveLength(0);
    await t.close();
  });

  it("never regenerates a reply whose own turn acted, so the action cannot run twice", async () => {
    const t = await setup([createProduct("Maize flour 2kg"), createProduct("Maize flour 2kg")]);
    const first = await t.ask("ask-acted-00001", "Please put maize flour in my catalogue.");
    expect(first.agentMessage.agentTurnEffect).toBe("action");
    const productsAfterFirst = t.products().length;
    expect(productsAfterFirst).toBeGreaterThan(0);
    const callsBefore = t.model.calls;

    const refused = await t.regenerate(first.agentMessage.id, "version-twice-001");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "reply_not_regenerable",
      details: { reason: "turn_acted" }
    });
    expect(t.model.calls).toBe(callsBefore);
    expect(t.products()).toHaveLength(productsAfterFirst);
    await t.close();
  });

  it("refuses to regenerate the answer to a # command for a tool that changes records", async () => {
    const t = await setup([answer("Never used.")]);
    // Missing its unit, so the first run only explained what is needed: nothing ran.
    const first = await t.ask("ask-hashtag-0001", '#product.create {"name":"Rice 1kg"}');
    expect(first.agentMessage.agentTurnEffect).toBe("none");
    const refused = await t.regenerate(first.agentMessage.id, "version-hash-0001");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "regeneration_would_act" });
    expect(t.products()).toHaveLength(0);
    expect((await t.thread())[1]?.replyVersions).toBeUndefined();
    await t.close();
  });

  it("stores no turn and no approval when the new version proposes an approval-gated tool", async () => {
    const t = await setup([
      answer("Nothing to remove yet."),
      proposeTool("product.delete", { productName: "Sugar 2kg" })
    ]);
    const first = await t.ask("ask-gated-00001", "Is anything in my catalogue out of date?");
    const turnsBefore = t.audit("runtime.turn_recorded").length;
    const refused = await t.regenerate(first.agentMessage.id, "version-gate-0001");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "regeneration_would_act" });
    expect(t.audit("runtime.turn_recorded")).toHaveLength(turnsBefore);
    expect(JSON.stringify(t.snapshot())).not.toContain("needs_confirmation");
    await t.close();
  });

  it("refuses a version that would drive the computer runtime, though it is registered read-only", async () => {
    const t = await setup([
      answer("Ask me anything."),
      proposeTool("computer.navigate", { sessionId: "session-1", url: "https://example.com/" })
    ]);
    const first = await t.ask("ask-computer-001", "Good afternoon, how are things?");
    const refused = await t.regenerate(first.agentMessage.id, "version-comp-0001");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "regeneration_would_act" });
    await t.close();
  });

  it("marks a reply that is waiting for approval as acted, and never regenerates it", async () => {
    const t = await setup([
      createProduct("Sugar 2kg"),
      proposeTool("product.delete", { productName: "Sugar 2kg" })
    ]);
    await t.ask("ask-pending-0001", "Please put sugar in my catalogue.");
    const pending = await t.ask("ask-pending-0002", "Actually, take sugar out again.");
    expect(pending.agentMessage).toMatchObject({
      content: { type: "confirmation" },
      agentTurnEffect: "action"
    });
    const refused = await t.regenerate(pending.agentMessage.id, "version-pend-0001");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "reply_not_regenerable" });
    await t.close();
  });

  it("refuses when the question was edited into a command, zero-width prefix included", async () => {
    const t = await setup([answer("First answer."), answer("Never used.")]);
    const first = await t.ask("ask-command-0001", "What sells best on Mondays?");
    for (const text of ["/skills list", "  /skill demo run", "\u200B/skills"]) {
      expect((await t.editQuestion(first.id, text)).statusCode).toBe(200);
      const refused = await t.regenerate(first.agentMessage.id, "version-cmd-00001");
      expect(refused.json()).toMatchObject({
        code: "reply_not_regenerable",
        details: { reason: "question_is_command" }
      });
    }
    expect(t.model.calls).toBe(1);
    await t.close();
  });

  it("does not file an answer under a question that was edited while the model was answering", async () => {
    const t = await setup([answer("Weekends: open 9 to 5."), answer("Weekends: open 9 to 5.")]);
    const first = await t.ask("ask-inflight-001", "What are the weekend opening hours?");
    let edited: Promise<{ statusCode: number }> | null = null;
    t.model.onCall = async () => {
      edited ??= t.editQuestion(first.id, "How much do I owe my flour supplier?");
      await edited;
    };
    const refused = await t.regenerate(first.agentMessage.id, "version-edit-0001");
    expect(edited).not.toBeNull();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "reply_not_regenerable",
      details: { reason: "question_changed" }
    });
    expect((await t.thread())[1]?.replyVersions).toBeUndefined();
    await t.close();
  });

  it("refuses even a low-risk computer tool", async () => {
    const t = await setup([
      answer("Ask me anything."),
      proposeTool("computer.observe", { sessionId: "session-1" })
    ]);
    const first = await t.ask("ask-observe-0001", "Good evening, anything new?");
    const refused = await t.regenerate(first.agentMessage.id, "version-obsv-0001");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "regeneration_would_act" });
    await t.close();
  });

  it("does not file an answer under a question that was deleted while the model was answering", async () => {
    const t = await setup([answer("First answer."), answer("Second answer.")]);
    const first = await t.ask("ask-deleted-0001", "What are the weekend opening hours?");
    let deleted: Promise<{ statusCode: number }> | null = null;
    t.model.onCall = async () => {
      deleted ??= t.app.inject({
        method: "PATCH",
        url: `/v1/conversations/${t.conversationId}/messages/${first.id}`,
        headers: jsonHeaders(t.cookie),
        payload: JSON.stringify({ deleted: true })
      });
      expect((await deleted).statusCode).toBe(200);
    };
    const refused = await t.regenerate(first.agentMessage.id, "version-gone-0001");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "reply_not_regenerable",
      details: { reason: "question_deleted" }
    });
    const reply = (await t.thread()).find((message) => message.id === first.agentMessage.id)!;
    expect(reply.content).toMatchObject({ text: "First answer." });
    expect(reply.replyVersions).toBeUndefined();
    await t.close();
  });

  it("answers a second regenerate with 409 while the first is in flight, and keeps one new version", async () => {
    const t = await setup([answer("Answer 1."), answer("Answer 2."), answer("Answer 3.")]);
    const first = await t.ask("ask-inflight-002", "Give me a slogan for the shop.");
    let twin: Awaited<ReturnType<typeof t.regenerate>> | null = null;
    let other: Awaited<ReturnType<typeof t.regenerate>> | null = null;
    t.model.onCall = async () => {
      if (twin !== null) return;
      twin = await t.regenerate(first.agentMessage.id, "version-race-0001");
      other = await t.regenerate(first.agentMessage.id, "version-race-0002");
    };
    const winner = await t.regenerate(first.agentMessage.id, "version-race-0001");
    expect(winner.statusCode).toBe(200);
    expect(twin!.statusCode).toBe(409);
    expect(other!.statusCode).toBe(409);
    expect(t.model.calls).toBe(2);
    const versions = (await t.thread())[1]?.replyVersions?.versions.map((version) => version.id);
    expect(versions).toEqual(["original", "version-race-0001"]);
    await t.close();
  });

  it("lets only the person who asked regenerate or switch, in a thread shared with staff and a customer", async () => {
    const t = await setup([
      answer("Owner answer one."),
      answer("Owner answer two."),
      answer("Never.")
    ]);
    const signUp = async (contact: string) => {
      const signup = await t.post(
        "/auth/pin/signup",
        { method: "phone", contact, pin: "3927" },
        ""
      );
      const header = signup.headers["set-cookie"];
      return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
    };
    const invitation = await t.post(`/businesses/${t.businessId}/staff/invitations`, {
      phone: "+254700077055",
      role: "manager",
      name: "Staff"
    });
    const staff = await signUp("+254700077055");
    expect(
      (
        await t.post(
          `/v1/staff-invitations/${invitation.json<{ id: string }>().id}/accept`,
          {},
          staff
        )
      ).statusCode
    ).toBe(200);
    const customer = await signUp("+254700077066");
    const opened = await t.post(
      "/v1/conversations",
      { kind: "storefront", activeShopId: t.businessId },
      customer
    );
    const shared = opened.json<{ conversation: { id: string } }>().conversation.id;
    const setAgent = (agentEnabled: boolean) =>
      t.app.inject({
        method: "PATCH",
        url: `/v1/conversations/${shared}`,
        headers: jsonHeaders(t.cookie),
        payload: JSON.stringify({ agentEnabled })
      });
    expect((await setAgent(true)).statusCode).toBe(200);
    const asked = await t.post("/v1/messages", {
      conversationId: shared,
      clientMessageId: "ask-shared-0001",
      content: { type: "text", text: "What should we tell this customer?" },
      clientTimestamp: new Date().toISOString(),
      agent: { businessId: t.businessId, message: "What should we tell this customer?" }
    });
    const reply = asked.json<{ agentMessage: ConversationMessageSummary }>().agentMessage;
    const regenerate = (cookie: string, versionId: string) =>
      t.post(
        `/v1/conversations/${shared}/messages/${reply.id}/regenerate`,
        { businessId: t.businessId, versionId },
        cookie
      );
    const select = (cookie: string, index: number) =>
      t.app.inject({
        method: "PUT",
        url: `/v1/conversations/${shared}/messages/${reply.id}/reply-version`,
        headers: jsonHeaders(cookie),
        payload: JSON.stringify({ index })
      });

    const callsBefore = t.model.calls;
    expect((await regenerate(staff, "version-staff-001")).json()).toMatchObject({
      code: "reply_regeneration_forbidden"
    });
    expect((await regenerate(customer, "version-cust-0001")).statusCode).toBe(403);
    expect(t.model.calls).toBe(callsBefore);

    expect((await regenerate(t.cookie, "version-owner-001")).statusCode).toBe(200);
    for (const cookie of [staff, customer]) {
      const refused = await select(cookie, 0);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "reply_version_forbidden" });
    }
    expect((await select(t.cookie, 0)).json<ConversationMessageSummary>().content).toMatchObject({
      text: "Owner answer one."
    });

    expect((await setAgent(false)).statusCode).toBe(200);
    const disabled = await regenerate(t.cookie, "version-owner-002");
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ code: "business_agent_disabled" });
    await t.close();
  });

  it("allows a read-only tool and records that the reply read business data", async () => {
    const t = await setup([answer("Ask me anything."), listProducts]);
    const first = await t.ask("ask-read-000001", "Good morning, what can you help with?");
    const regenerated = await t.regenerate(first.agentMessage.id, "version-read-0001");
    expect(regenerated.statusCode).toBe(200);
    expect(regenerated.json<ConversationMessageSummary>()).toMatchObject({
      agentTurnEffect: "read",
      replyVersions: { selected: 1 }
    });
    await t.close();
  });

  it("fails closed for agent messages the runtime did not write and for command questions", async () => {
    const t = await setup([answer("First answer."), answer("Never used.")]);
    const first = await t.ask("ask-legacy-0001", "How are sales looking?");
    // A client-posted agent message carries no turn effect, and a request body cannot set one.
    const posted = await t.post("/v1/messages", {
      conversationId: t.conversationId,
      clientMessageId: "client-agent-0001",
      author: "agent",
      replyToMessageId: first.id,
      agentTurnEffect: "none",
      content: { type: "text", text: "Written on the device." }
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json<ConversationMessageSummary>().agentTurnEffect).toBeUndefined();
    const refused = await t.regenerate(posted.json<{ id: string }>().id, "version-legacy-01");
    expect(refused.json()).toMatchObject({
      code: "reply_not_regenerable",
      details: { reason: "turn_effect_unknown" }
    });

    const badId = await t.regenerate(first.agentMessage.id, "original");
    expect(badId.statusCode).toBe(400);
    expect(badId.json()).toMatchObject({ code: "reply_version_id_invalid" });
    await t.close();
  });

  it("refuses another account, another business, and a question the caller did not ask", async () => {
    const t = await setup([answer("First answer."), answer("Never used.")]);
    const first = await t.ask("ask-tenant-0001", "What are my best sellers?");
    const stranger = await createOwnerBusiness(t.app, "+254700077002", "Other Shop");
    const callsBefore = t.model.calls;

    const crossAccount = await t.regenerate(first.agentMessage.id, "version-cross-001", {
      cookie: stranger.cookie,
      businessId: stranger.businessId
    });
    expect(crossAccount.statusCode).toBe(404);
    const crossBusiness = await t.regenerate(first.agentMessage.id, "version-cross-002", {
      businessId: stranger.businessId
    });
    expect([403, 404]).toContain(crossBusiness.statusCode);
    const select = await t.app.inject({
      method: "PUT",
      url: `/v1/conversations/${t.conversationId}/messages/${first.agentMessage.id}/reply-version`,
      headers: jsonHeaders(stranger.cookie),
      payload: JSON.stringify({ index: 0 })
    });
    expect(select.statusCode).toBe(404);
    expect(t.model.calls).toBe(callsBefore);
    expect((await t.thread())[1]?.replyVersions).toBeUndefined();
    await t.close();
  });

  it("switches the shown version without touching any other message, and keeps at most five", async () => {
    const t = await setup([
      answer("Answer 1."),
      answer("Answer 2."),
      answer("Answer 3."),
      answer("Answer 4."),
      answer("Answer 5."),
      answer("Answer 6.")
    ]);
    const first = await t.ask("ask-switch-0001", "Give me a slogan for the shop.");
    for (let index = 2; index <= maxReplyVersions; index += 1)
      expect((await t.regenerate(first.agentMessage.id, `version-sw-000${index}`)).statusCode).toBe(
        200
      );
    const full = await t.regenerate(first.agentMessage.id, "version-sw-0006");
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ code: "reply_version_limit" });

    const select = (index: unknown) =>
      t.app.inject({
        method: "PUT",
        url: `/v1/conversations/${t.conversationId}/messages/${first.agentMessage.id}/reply-version`,
        headers: jsonHeaders(t.cookie),
        payload: JSON.stringify({ index })
      });
    const shown = await select(0);
    expect(shown.statusCode).toBe(200);
    expect(shown.json<ConversationMessageSummary>()).toMatchObject({
      content: { text: "Answer 1." },
      replyVersions: { selected: 0 }
    });
    expect(shown.json<ConversationMessageSummary>().replyVersions?.versions).toHaveLength(5);
    for (const bad of [5, -1, 1.5, "1"]) expect((await select(bad)).statusCode).toBe(400);

    // The next turn's history carries the selected answer only.
    await t.ask("ask-switch-0002", "Thanks, and a second slogan?");
    const prompt = JSON.stringify(t.model.prompts.at(-1));
    expect(prompt).toContain("Answer 1.");
    expect(prompt).not.toContain("Answer 5.");
    expect(await t.thread()).toHaveLength(4);
    expect(t.audit("message.version_selected")).toHaveLength(1);
    await t.close();
  });
});

async function setup(script: string[]) {
  const model = {
    calls: 0,
    prompts: [] as unknown[],
    /** Runs while a model call is in flight, before it answers. */
    onCall: null as null | (() => Promise<void>)
  };
  const adapter: ModelRuntimeAdapter = {
    ...healthyAdapter(modelId),
    async generate({ prompt }) {
      model.prompts.push(prompt);
      const text = script[Math.min(model.calls, script.length - 1)]!;
      model.calls += 1;
      await model.onCall?.();
      return { text, modelId, provider: "test", executionTarget: "backend", latencyMs: 3 };
    }
  };
  const store = createCp2Store({
    modelRuntimeAdapterResolver: ({ modelId: requested }) =>
      requested === modelId ? adapter : undefined
  });
  const app = buildApi({ cp2: { store } });
  const owner = await createOwnerBusiness(app, "+254700077001", "Versions Shop");
  const activation = await app.inject({
    method: "POST",
    url: `/api/agents/${owner.businessId}/models/${modelId}/activate`,
    headers: jsonHeaders(owner.cookie),
    payload: JSON.stringify({
      shopId: owner.businessId,
      executionTarget: "backend" as ModelExecutionTarget,
      executionMode: "LOCAL_FIRST",
      costResponsibility: "merchant",
      permissions: { allowRemoteShopDevice: false }
    })
  });
  expect(activation.statusCode).toBe(200);
  const inbox = await app.inject({
    method: "GET",
    url: "/v1/conversations",
    headers: { cookie: owner.cookie }
  });
  const conversationId = inbox.json<{ conversations: Array<{ id: string }> }>().conversations[0]!
    .id;
  // Activation's own health check must not consume the script.
  model.calls = 0;
  model.prompts.length = 0;
  const post = (url: string, payload: unknown, cookie = owner.cookie) =>
    app.inject({
      method: "POST",
      url,
      headers: jsonHeaders(cookie),
      payload: JSON.stringify(payload)
    });
  return {
    app,
    model,
    conversationId,
    cookie: owner.cookie,
    businessId: owner.businessId,
    post,
    async ask(clientMessageId: string, text: string) {
      const response = await post("/v1/messages", {
        conversationId,
        clientMessageId,
        content: { type: "text", text },
        clientTimestamp: new Date().toISOString(),
        agent: { businessId: owner.businessId, message: text }
      });
      expect(response.statusCode).toBe(200);
      return response.json<
        ConversationMessageSummary & { agentMessage: ConversationMessageSummary }
      >();
    },
    regenerate: (
      messageId: string,
      versionId: string,
      as: { cookie?: string; businessId?: string } = {}
    ) =>
      post(
        `/v1/conversations/${conversationId}/messages/${messageId}/regenerate`,
        { businessId: as.businessId ?? owner.businessId, versionId },
        as.cookie ?? owner.cookie
      ),
    async thread() {
      const response = await app.inject({
        method: "GET",
        url: `/v1/conversations/${conversationId}`,
        headers: { cookie: owner.cookie }
      });
      return response.json<{ messages: ConversationMessageSummary[] }>().messages;
    },
    editQuestion: (messageId: string, text: string) =>
      app.inject({
        method: "PATCH",
        url: `/v1/conversations/${conversationId}/messages/${messageId}`,
        headers: jsonHeaders(owner.cookie),
        payload: JSON.stringify({ text })
      }),
    snapshot: () => store.snapshot(),
    products: () =>
      store.snapshot().products.filter((product) => product.businessId === owner.businessId),
    audit: (type: string) => store.snapshot().auditEvents.filter((event) => event.type === type),
    close: () => app.close()
  };
}

function healthyAdapter(id: string): ModelRuntimeAdapter {
  return {
    provider: "test",
    executionTarget: "backend",
    async canRun() {
      return { available: true, errorCode: null, message: null };
    },
    async healthCheck() {
      return {
        available: true,
        modelId: id,
        provider: "test",
        executionTarget: "backend",
        latencyMs: 4,
        responsePreview: "GROGONI_MODEL_OK",
        errorCode: null,
        message: null,
        retryable: false
      };
    },
    async generate() {
      return {
        text: answer("unused"),
        modelId: id,
        provider: "test",
        executionTarget: "backend",
        latencyMs: 1
      };
    }
  };
}

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  contact: string,
  name: string
) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact, pin: "3927" })
  });
  expect(signup.statusCode).toBe(200);
  const header = signup.headers["set-cookie"];
  const cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: jsonHeaders(cookie),
    payload: JSON.stringify({ name, language: "en" })
  });
  expect(business.statusCode).toBe(200);
  return { businessId: business.json<{ business: { id: string } }>().business.id, cookie };
}

function jsonHeaders(cookie?: string) {
  return { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) };
}
