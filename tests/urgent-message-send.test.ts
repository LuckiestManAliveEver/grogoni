// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../apps/web/src/lib/api";

// Measured live (2026-11-19): a sent message waited ~11 s in the one-at-a-time cloud queue behind
// startup and refresh reads before its POST left the browser. A send is marked urgent and bypasses
// that queue; everything else keeps waiting its turn.
describe("urgent message sends", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("leaves at once while a slow background read holds the queue; other mutations still wait", async () => {
    let releaseRead!: () => void;
    const started: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        started.push(`${init?.method ?? "GET"} ${path}`);
        const body = () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        return path.endsWith("/products")
          ? new Promise<Response>((resolve) => {
              releaseRead = () => resolve(body());
            })
          : Promise.resolve(body());
      })
    );
    const flush = async () => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    };

    const read = apiFetch("/businesses/shop-1/products");
    await flush();
    expect(started).toEqual(["GET /businesses/shop-1/products"]);

    const typing = apiFetch("/v1/conversations/c1/typing", { method: "POST", body: {} });
    const lookup = apiFetch("/v1/conversations/c1", { priority: true, urgent: true });
    const send = apiFetch("/v1/messages", { method: "POST", body: { text: "hi" }, urgent: true });
    await flush();
    // The send's conversation lookup and POST are on the network; the typing mutation is queued.
    expect(started).toEqual([
      "GET /businesses/shop-1/products",
      "GET /v1/conversations/c1",
      "POST /v1/messages"
    ]);
    await expect(send).resolves.toEqual({ ok: true });
    await expect(lookup).resolves.toEqual({ ok: true });

    releaseRead();
    await read;
    await typing;
    expect(started.at(-1)).toBe("POST /v1/conversations/c1/typing");
  });
});
