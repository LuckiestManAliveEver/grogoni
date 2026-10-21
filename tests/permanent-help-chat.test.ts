import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { runtimeHashtagCapabilities } from "../packages/tool-core/src/parsers/hashtag-runtime";

describe("permanent Help conversations", () => {
  it("creates private durable guides once, includes every tool, and protects their structure", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    app.log.level = "silent";
    try {
      expect((await app.inject({ method: "POST", url: "/v1/help", payload: {} })).statusCode).toBe(
        401
      );
      const signup = await app.inject({
        method: "POST",
        url: "/auth/pin/signup",
        payload: { method: "phone", contact: "+442079460981", pin: "7412" }
      });
      const cookie = String(signup.headers["set-cookie"]).split(";")[0]!;
      const headers = { cookie };
      const help = await app.inject({ method: "POST", url: "/v1/help", headers, payload: {} });
      expect(help.statusCode, help.body).toBe(200);
      const id = help.json().conversationId;
      expect(
        (await app.inject({ method: "POST", url: "/v1/help", headers, payload: {} })).json()
          .conversationId
      ).toBe(id);
      const inbox = (await app.inject({ method: "GET", url: "/v1/conversations", headers })).json()
        .conversations;
      const guides = inbox.filter((item: { helpTopic?: string }) => item.helpTopic);
      expect(guides).toHaveLength(7);
      expect(guides.map((item: { helpTopic: string }) => item.helpTopic)).toEqual([
        "home",
        "buying",
        "selling",
        "receipts",
        "messaging",
        "tools",
        "troubleshooting"
      ]);
      expect(guides.find((item: { id: string }) => item.id === id).title).toBe("Help");
      expect(
        guides.filter(
          (item: { helpParentConversationId?: string }) => item.helpParentConversationId === id
        )
      ).toHaveLength(6);
      const tools = guides.find((item: { helpTopic: string }) => item.helpTopic === "tools");
      const thread = (
        await app.inject({ method: "GET", url: `/v1/conversations/${tools.id}`, headers })
      ).json();
      for (const capability of runtimeHashtagCapabilities)
        expect(
          thread.messages
            .map((message: { content: { text: string } }) => message.content.text)
            .join("\n")
        ).toContain(capability.hashtag);
      expect(thread.messages.length).toBeGreaterThan(0);
      for (const payload of [{ archived: true }, { title: "Changed" }, { pinned: false }]) {
        const response = await app.inject({
          method: "PATCH",
          url: `/v1/conversations/${id}`,
          headers,
          payload
        });
        expect(response.statusCode, response.body).toBe(400);
      }
      expect(
        (await app.inject({ method: "DELETE", url: `/v1/conversations/${id}`, headers })).statusCode
      ).toBe(400);
      const restored = createCp2Store();
      restored.hydrateSnapshot(store.snapshot());
      expect(
        restored.ensureHelpConversations({ sessionId: signup.json().session.id }).conversationId
      ).toBe(id);
      expect(restored.snapshot().conversations.filter((item) => item.helpTopic)).toHaveLength(7);
      const other = await app.inject({
        method: "POST",
        url: "/auth/pin/signup",
        payload: { method: "phone", contact: "+442079460982", pin: "7412" }
      });
      const otherHeaders = { cookie: String(other.headers["set-cookie"]).split(";")[0]! };
      expect(
        (await app.inject({ method: "GET", url: `/v1/conversations/${id}`, headers: otherHeaders }))
          .statusCode
      ).toBe(404);
      expect(
        (
          await app.inject({ method: "POST", url: "/v1/help", headers: otherHeaders, payload: {} })
        ).json().conversationId
      ).not.toBe(id);
    } finally {
      await app.close();
    }
  });
});
