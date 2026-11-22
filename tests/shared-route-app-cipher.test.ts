import { createRequire } from "node:module";
import type { FastifyInstance, FastifyPluginCallback } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCp2Routes } from "../services/api/src/cp2/routes";
import { createCp2Store } from "../services/api/src/cp2/store";
import { registerLinkedAttachmentCipher } from "../services/api/src/messaging/whatsapp-linked/routes";

// The Edge shared route app registers the API once with per-request store proxies that throw
// outside a request. With WHATSAPP_LINKED_SESSION_KEY set, linked-WhatsApp registration used to
// call the store, which broke the shared app on every request. The cipher now goes on each
// request's store instead.
const key = "a".repeat(64);
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const Fastify = requireApi("fastify") as (options: { logger: boolean }) => FastifyInstance;
const websocket = requireApi("@fastify/websocket") as FastifyPluginCallback;

afterEach(() => vi.unstubAllEnvs());

describe("linked WhatsApp attachment cipher on the shared route app", () => {
  it("registers every route without touching a per-request store", async () => {
    vi.stubEnv("WHATSAPP_LINKED_SESSION_KEY", key);
    const touched: string[] = [];
    const outsideRequest = new Proxy(
      {},
      {
        get(_target, property) {
          touched.push(String(property));
          throw new Error("The per-request store was used outside a request.");
        }
      }
    );
    const app = Fastify({ logger: false });
    await app.register(websocket);
    expect(() =>
      registerCp2Routes(app, {
        store: outsideRequest as never,
        attachmentCipherPerRequest: true,
        externalAuthRateLimit: true
      })
    ).not.toThrow();
    await app.ready();
    expect(touched).toEqual([]);
    await app.close();
  });

  it("registers the cipher on a request's own store when a valid key is configured", () => {
    const store = createCp2Store();
    const register = vi.spyOn(store, "registerConversationAttachmentCipher");
    const remove = registerLinkedAttachmentCipher(store, { WHATSAPP_LINKED_SESSION_KEY: key });
    expect(register).toHaveBeenCalledWith("encrypted/whatsapp-linked/", expect.anything());
    expect(typeof remove).toBe("function");
    expect(registerLinkedAttachmentCipher(createCp2Store(), {})).toBeUndefined();
    expect(
      registerLinkedAttachmentCipher(createCp2Store(), { WHATSAPP_LINKED_SESSION_KEY: "short" })
    ).toBeUndefined();
  });
});
