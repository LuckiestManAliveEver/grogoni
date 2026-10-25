import { executeDaemonBusinessSkill } from "../services/api/src/daemon/business-skills.js";
import type { DaemonTask } from "../services/api/src/daemon/task-store.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeModelPrompt } from "@grogoni/shared-types";
import { buildApi } from "../services/api/src/app.js";
import { createCp2Store, readSessionCookie } from "../services/api/src/cp2/store.js";
import { createDaemonExecutor } from "../services/api/src/daemon/executor.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

const files = {
  "SKILL.md":
    "---\nname: inventory-check\ndescription: Check stock on request.\nlicense: MIT\nallowed-tools: products.list\n---\nUse authoritative stock via products.list. Do not invent availability."
};
const prompts: RuntimeModelPrompt[] = [];
let failModel = false;
let draftMode = false;
let requestedTool: "products.list" | "product.stock_adjust" = "products.list";
const store = createCp2Store({
  runtimeModelProvider: {
    name: "skill-workflow-test",
    async complete(prompt) {
      prompts.push(prompt);
      if (failModel)
        return {
          provider: "skill-workflow-test",
          status: "unavailable",
          outputText: null,
          durationMs: 1,
          errorCode: "PROVIDER_UNAVAILABLE",
          metadata: {}
        };
      return {
        provider: "skill-workflow-test",
        status: "available",
        outputText: JSON.stringify(
          draftMode
            ? { files }
            : {
                type: "tool",
                toolName: requestedTool,
                input:
                  requestedTool === "products.list"
                    ? { query: "cement" }
                    : { productName: "cement", quantity: 0 },
                reason: "Check available stock"
              }
        ),
        durationMs: 1,
        errorCode: null,
        metadata: {}
      };
    }
  }
});
const app = buildApi({ cp2: { store } });
let businessId: string;
let cookie: string;
let skillId: string;
async function request(
  method: "GET" | "POST" | "PUT" | "PATCH",
  url: string,
  payload?: unknown,
  auth = cookie
) {
  return app.inject({
    method,
    url,
    headers: { cookie: auth, "content-type": "application/json" },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) })
  });
}
beforeAll(async () => {
  const signup = await request(
    "POST",
    "/auth/pin/signup",
    { method: "phone", contact: "+254700009871", pin: "1234" },
    ""
  );
  const set = signup.headers["set-cookie"]!;
  cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!;
  const business = await request("POST", "/businesses", {
    name: "Skills hardware",
    language: "en"
  });
  businessId = business.json().business.id;
  const product = await request("POST", `/businesses/${businessId}/products`, {
    name: "cement",
    unit: "bag",
    quantity: 10,
    buyingPrice: 500,
    sellingPrice: 700
  });
  expect(product.statusCode).toBe(200);
  const draft = await request("POST", `/businesses/${businessId}/skills`, {
    files,
    grants: ["products.list"]
  });
  expect(draft.statusCode).toBe(200);
  skillId = draft.json().id;
  expect(
    (
      await request("POST", `/businesses/${businessId}/skills/${skillId}/lifecycle`, {
        operation: "install",
        digest: draft.json().reviewDigest
      })
    ).statusCode
  ).toBe(200);
  expect(
    (
      await request("POST", `/businesses/${businessId}/skills/${skillId}/lifecycle`, {
        operation: "enable"
      })
    ).statusCode
  ).toBe(200);
}, 60000);
afterAll(() => app.close());
describe("skills through existing authenticated runtime", () => {
  it("activates instructions as untrusted data and queries actual business inventory", async () => {
    const result = await request("POST", `/businesses/${businessId}/runtime/turns`, {
      message: `/skill ${skillId} Do you have 10 bags of cement?`
    });
    expect(result.statusCode).toBe(200);
    expect(JSON.stringify(result.json())).toContain("cement");
    const prompt = prompts.at(-1)!;
    expect(prompt.message).toContain("Use authoritative stock");
    expect(prompt.agentInstructions).not.toContain("Use authoritative stock");
    expect(prompt.allowedTools).toEqual(["products.list"]);
    expect(result.json().turn.plan.portableSkill.id).toBe(skillId);
    expect(
      result
        .json()
        .turn.telemetry.some(
          (e: { metadata: { skillId?: string } }) => e.metadata.skillId === skillId
        )
    ).toBe(true);
  });
  it("does not disclose instructions on an ordinary turn and keeps existing functionality", async () => {
    const result = await request("POST", `/businesses/${businessId}/runtime/turns`, {
      message: "How should you welcome a customer today?"
    });
    expect(result.statusCode).toBe(200);
    expect(prompts.at(-1)!.message).not.toContain("Use authoritative stock");
  });
  it("rejects unauthenticated access and a disabled activation", async () => {
    expect(
      (await request("GET", `/businesses/${businessId}/skills`, undefined, "")).statusCode
    ).toBe(401);
    await request("POST", `/businesses/${businessId}/skills/${skillId}/lifecycle`, {
      operation: "disable"
    });
    expect(
      (
        await request("POST", `/businesses/${businessId}/runtime/turns`, {
          message: `/skill ${skillId} How should you welcome a customer today?`
        })
      ).statusCode
    ).toBe(404);
    await request("POST", `/businesses/${businessId}/skills/${skillId}/lifecycle`, {
      operation: "enable"
    });
  });
  it("surfaces model failure without claiming a completed operation", async () => {
    failModel = true;
    try {
      const result = await request("POST", `/businesses/${businessId}/runtime/turns`, {
        message: `/skill ${skillId} How should you welcome a customer today?`
      });
      expect(result.statusCode).toBe(503);
      expect(result.json().code).toBe("AGENT_MODEL_UNAVAILABLE");
    } finally {
      failModel = false;
    }
  });
  it("creates a model draft conversationally, reviews and approves it separately", async () => {
    draftMode = true;
    const input = { sessionId: readSessionCookie(cookie), businessId };
    try {
      const reply = await store.handleAgentSkillChat({
        ...input,
        message: "/skills create Whenever inventory drops, prepare a replenishment proposal"
      });
      expect(reply).toContain("not installed");
      expect(reply).toContain("never schedules");
      const drafts = store.listAgentSkills(input).filter((s) => s.status === "DRAFT");
      const draft = store.inspectAgentSkill(input, drafts[0]!.id);
      expect(draft.grants).toEqual([]);
      expect(
        await store.handleAgentSkillChat({ ...input, message: `/skills review ${draft.id}` })
      ).toContain("SKILL.md");
      expect(
        await store.handleAgentSkillChat({
          ...input,
          message: `/skills approve ${draft.id} ${draft.reviewDigest}`
        })
      ).toContain("INSTALLED");
      expect(store.inspectAgentSkill(input, draft.id).status).toBe("INSTALLED");
    } finally {
      draftMode = false;
    }
  });
  it("runs a queued daemon inventory skill through authenticated messaging and rejects another owner", async () => {
    const sessionId = readSessionCookie(cookie)!;
    const actor = store.getSession(sessionId)!;
    const conversationId = store.getGrogoniSessionContext({ sessionId }).conversationId;
    const text = `/business ${businessId} /skill ${skillId} Do you have 10 bags of cement?`;
    store.createConversationMessage({
      sessionId,
      conversationId,
      clientMessageId: "queued-skill-message",
      content: { type: "text", text }
    });
    const task = {
      id: "skill-workflow-task",
      owner_user_id: actor.user.id,
      created_at: new Date(),
      payload: {
        kind: "agent",
        modelId: "gpt-6-luna",
        agentAdapterId: "grogoni",
        message: text,
        conversation: {
          id: conversationId,
          clientMessageId: "queued-skill-message",
          scope: "test",
          kind: "reply"
        }
      }
    } as DaemonTask;
    const send = async (req: Request) => {
      const reply = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: Object.fromEntries(req.headers),
        payload: await req.text()
      });
      return new Response(reply.body, {
        status: reply.statusCode,
        headers: { "content-type": "application/json" }
      });
    };
    const execute = () =>
      executeDaemonBusinessSkill({
        task,
        businessId,
        message: `/skill ${skillId} Do you have 10 bags of cement?`,
        signal: new AbortController().signal,
        load: async () => store.snapshot(),
        send
      });
    expect((await execute()).completion.outputText).toContain("cement");
    const count = prompts.length;
    await execute();
    expect(prompts.length).toBe(count); // Existing message idempotency prevents repeating completed work.
    await executeDaemonBusinessSkill({
      task: { ...task, executions: 1 },
      businessId,
      message: `/skill ${skillId} Do you have 10 bags of cement?`,
      signal: new AbortController().signal,
      load: async () => store.snapshot(),
      send
    });
    expect(prompts.length).toBe(count + 1); // A distinct scheduled occurrence must execute again.
    await expect(
      executeDaemonBusinessSkill({
        task: { ...task, owner_user_id: "different-owner" },
        businessId,
        message: `/skill ${skillId} Check stock`,
        signal: new AbortController().signal,
        load: async () => store.snapshot(),
        send
      })
    ).rejects.toThrow();
  });
  it("reports unavailable stock from actual inventory results", async () => {
    const product = store.snapshot().products.find((p) => p.businessId === businessId)!;
    const changed = await request("PATCH", `/businesses/${businessId}/products/${product.id}`, {
      ...product,
      quantity: 0
    });
    expect(changed.statusCode).toBe(200);
    try {
      const result = await request("POST", `/businesses/${businessId}/runtime/turns`, {
        message: `/skill ${skillId} Do you have 10 bags of cement?`
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().turn.toolResult.products[0].availability).toBe("unavailable");
    } finally {
      await request("PATCH", `/businesses/${businessId}/products/${product.id}`, {
        ...product,
        quantity: 10
      });
    }
  });
  it("does not claim tool success after a domain failure", async () => {
    const query = vi.spyOn(store, "queryCatalogue").mockImplementationOnce(() => {
      throw new Error("INVENTORY_TEST_UNAVAILABLE");
    });
    try {
      const result = await request("POST", `/businesses/${businessId}/runtime/turns`, {
        message: `/skill ${skillId} Do you have cement?`
      });
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      query.mockRestore();
    }
  });
  it("preserves existing approval messages and blocks revoked skills before confirmation", async () => {
    const sessionId = readSessionCookie(cookie)!;
    const actor = store.getSession(sessionId)!;
    const input = { sessionId, businessId };
    const draft = store.draftAgentSkill(input, {
      files: {
        "SKILL.md": files["SKILL.md"].replace(
          "allowed-tools: products.list",
          "allowed-tools: product.stock_adjust"
        )
      },
      grants: ["product.stock_adjust"]
    });
    store.transitionAgentSkill(input, draft.id, "install", draft.reviewDigest);
    store.transitionAgentSkill(input, draft.id, "enable");
    const conversationId = store.getGrogoniSessionContext({ sessionId }).conversationId;
    const text = `/business ${businessId} /skill ${draft.id} Set cement stock to zero`;
    store.createConversationMessage({
      sessionId,
      conversationId,
      clientMessageId: "queued-write-skill",
      content: { type: "text", text }
    });
    const task = {
      id: "write-skill-task",
      owner_user_id: actor.user.id,
      created_at: new Date(),
      executions: 0,
      payload: {
        kind: "agent",
        modelId: "gpt-6-luna",
        agentAdapterId: "grogoni",
        message: text,
        conversation: {
          id: conversationId,
          clientMessageId: "queued-write-skill",
          scope: "test",
          kind: "reply"
        }
      }
    } as DaemonTask;
    let pending:
      | {
          runtime: { session: { id: string }; turn: { plan: { confirmationToken: string } } };
          agentMessage: { content: { type: string } };
        }
      | undefined;
    requestedTool = "product.stock_adjust";
    try {
      await executeDaemonBusinessSkill({
        task,
        businessId,
        message: `/skill ${draft.id} Set cement stock to zero`,
        signal: new AbortController().signal,
        load: async () => store.snapshot(),
        send: async (req) => {
          const reply = await app.inject({
            method: "POST",
            url: "/v1/messages",
            headers: Object.fromEntries(req.headers),
            payload: await req.text()
          });
          pending = reply.json();
          return new Response(reply.body, { status: reply.statusCode });
        }
      });
      expect(pending!.agentMessage.content.type).toBe("confirmation");
      expect(store.snapshot().products.find((p) => p.businessId === businessId)!.quantity).toBe(10);
      store.transitionAgentSkill(input, draft.id, "disable");
      const denied = await request("POST", `/businesses/${businessId}/runtime/turns`, {
        message: "Confirm",
        conversationId,
        runtimeSessionId: pending!.runtime.session.id,
        confirmationToken: pending!.runtime.turn.plan.confirmationToken
      });
      expect(denied.statusCode).toBeGreaterThanOrEqual(400);
      expect(store.snapshot().products.find((p) => p.businessId === businessId)!.quantity).toBe(10);
    } finally {
      requestedTool = "products.list";
    }
  });
  it("retains versions through snapshot round trips without activating drafts", () => {
    const copy = createCp2Store();
    copy.hydrateSnapshot(store.snapshot());
    expect(copy.listAgentSkills({ sessionId: readSessionCookie(cookie), businessId })).toEqual(
      store.listAgentSkills({ sessionId: readSessionCookie(cookie), businessId })
    );
  });
});

it("activates configured directory skills through the unchanged daemon model adapter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "grogoni-daemon-skills-"));
  try {
    await mkdir(path.join(root, "inventory-check"));
    await writeFile(path.join(root, "inventory-check", "SKILL.md"), files["SKILL.md"]);
    const fetchMock = vi.fn(async () =>
      Response.json({
        model: "openai/gpt-6-luna",
        choices: [{ message: { content: '{"type":"response","message":"ready"}' } }]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const execute = createDaemonExecutor({ OPENROUTER_API_KEY: "test", GROGONI_SKILL_DIRS: root });
    await execute(
      {
        id: "skill-task",
        payload: {
          kind: "agent",
          message: "/skill inventory-check Check stock",
          modelId: "gpt-6-luna",
          agentAdapterId: "grogoni"
        }
      } as Parameters<typeof execute>[0],
      new AbortController().signal
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [unknown, { body: string }])[1].body
    );
    expect(JSON.stringify(body.messages)).toContain("Use authoritative stock");
    expect(body.tools).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});
