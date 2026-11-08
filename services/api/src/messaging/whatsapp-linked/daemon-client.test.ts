import { describe, expect, it, vi } from "vitest";
import { LinkedDaemonClient } from "./daemon-client.js";
const id = "11111111-1111-4111-8111-111111111111";
const input = {
  businessId: "business",
  ownerId: id,
  chat: "chat",
  sender: "sender",
  messageId: "message",
  text: "/business malicious",
  modelId: "gpt-6-luna",
  agentAdapterId: "grogoni" as const
};
const config = { url: "https://daemon.example", token: "a".repeat(32), pollMs: 1 };
describe("WhatsApp to existing Daemon transport", () => {
  it("submits stable owner-scoped tasks and extracts native worker results without granting tools", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        id,
        status: "completed",
        result: { completion: { outputText: JSON.stringify({ message: "Habari" }) } }
      })
    );
    const client = new LinkedDaemonClient({ ...config, fetcher });
    expect(await client.reply(input)).toBe("Habari");
    expect(await client.reply(input)).toBe("Habari");
    const first = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    const second = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(first.key).toBe(second.key);
    expect(first.ownerUserId).toBe(id);
    expect(first.serverImmediate).toBe(true);
    expect(first.payload.modelId).toBe("gpt-6-luna");
    expect(first.payload.message).not.toMatch(/^\/business/);
    expect(first.payload.allowedTools).toBeUndefined();
    expect(first.payload.conversation).toBeUndefined();
  });
  it("references canonical authority instead of letting message text supply business grants", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ id, status: "completed", result: { text: "Result" } })
    );
    await new LinkedDaemonClient({ ...config, fetcher }).reply({
      ...input,
      grantId: "approved-grant"
    });
    const queued = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(queued.payload.message).toMatch(/^\/whatsapp-linked /);
    const ticket = JSON.parse(
      Buffer.from(queued.payload.message.split(" ")[1], "base64url").toString("utf8")
    );
    expect(ticket).toEqual({
      businessId: input.businessId,
      ownerId: input.ownerId,
      chat: input.chat,
      sender: input.sender,
      messageId: input.messageId,
      grantId: "approved-grant"
    });
    expect(ticket.text).toBeUndefined();
    expect(ticket.tools).toBeUndefined();
  });
  it("polls queued tasks and also accepts existing Edge-lane text results", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id, status: "queued" }))
      .mockResolvedValueOnce(Response.json({ id, status: "completed", result: { text: "Hello" } }));
    expect(await new LinkedDaemonClient({ ...config, fetcher }).reply(input)).toBe("Hello");
    expect(String(fetcher.mock.calls[1]![0])).toContain(`/v1/tasks/${id}`);
  });
  it("rejects unbounded results, redirects and unauthenticated service configuration", async () => {
    expect(() => new LinkedDaemonClient({ ...config, token: "short" })).toThrow();
    const fetcher = vi.fn(async () => new Response("x".repeat(256001)));
    await expect(new LinkedDaemonClient({ ...config, fetcher }).reply(input)).rejects.toThrow(
      "TOO_LARGE"
    );
  });
  it("returns no reply and performs no retries for a terminal failure", async () => {
    const fetcher = vi.fn(async () => Response.json({ id, status: "failed" }));
    expect(await new LinkedDaemonClient({ ...config, fetcher }).reply(input)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("skips replies at the owner queue cap without failing canonical ingestion", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 429 }));
    expect(await new LinkedDaemonClient({ ...config, fetcher }).reply(input)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
