import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { BusinessRole } from "@grogoni/shared-types";
import { buildApi } from "../../app.js";
import { createCp2Store } from "../../cp2/store.js";
import { registerLinkedWhatsAppRoutes } from "./routes.js";
import { registerLinkedWhatsAppDeviceRoutes } from "./device-worker-routes.js";
import type { LinkedDriver } from "./connector.js";

/**
 * Every WhatsApp Linked Devices route belongs to the business owner alone. A member of the same
 * business with any other role holds `business:read`, so only the routes' owner-role checks stand
 * between them and the owner's WhatsApp account. Each route is also called by the owner, so a 403
 * here can only come from the role check.
 */
const chat = "254711111111@s.whatsapp.net";
const worker = "6f1c1a52-3d0e-4b8f-9a4e-2f1b3c4d5e6f";

type Host = "linked" | "main" | "device";
const routes: Array<{
  group: string;
  host: Host;
  method: "GET" | "POST" | "DELETE";
  path: string;
  payload?: Record<string, unknown>;
}> = [
  { group: "connection", host: "linked", method: "GET", path: "" },
  {
    group: "connection",
    host: "linked",
    method: "POST",
    path: "/connect",
    payload: { phone: "254700000000", consent: true }
  },
  { group: "connection", host: "linked", method: "DELETE", path: "" },
  {
    group: "scopes",
    host: "linked",
    method: "POST",
    path: "/scopes",
    payload: { chat, approved: true }
  },
  {
    group: "scopes",
    host: "linked",
    method: "POST",
    path: "/scopes",
    payload: { chat, approved: false }
  },
  { group: "tools", host: "linked", method: "GET", path: "/tools" },
  {
    group: "tools",
    host: "linked",
    method: "POST",
    path: "/tools",
    payload: { chat, consent: true, tools: ["products.list"] }
  },
  { group: "groups", host: "linked", method: "GET", path: "/groups" },
  { group: "workers", host: "linked", method: "GET", path: "/workers" },
  {
    group: "workers",
    host: "linked",
    method: "POST",
    path: "/workers",
    payload: { name: "Shop PC" }
  },
  { group: "workers", host: "linked", method: "POST", path: `/workers/${worker}/rotate` },
  { group: "workers", host: "linked", method: "DELETE", path: `/workers/${worker}` },
  { group: "account", host: "main", method: "GET", path: "/account" },
  { group: "account", host: "main", method: "POST", path: "/account/owner-change/acknowledge" },
  {
    group: "chats",
    host: "main",
    method: "POST",
    path: "/chats/customer",
    payload: { chat, customerId: null }
  },
  {
    group: "chats",
    host: "main",
    method: "POST",
    path: "/chats/read-receipts",
    payload: { chat, enabled: true }
  },
  {
    group: "device",
    host: "device",
    method: "POST",
    path: "/device/scopes",
    payload: { chat, approved: true }
  },
  { group: "device", host: "device", method: "GET", path: "/device/status" },
  {
    group: "device",
    host: "device",
    method: "POST",
    path: "/device/state",
    payload: { state: "CONNECTED" }
  },
  { group: "device", host: "device", method: "POST", path: "/device/outbox/pull", payload: {} },
  {
    group: "device",
    host: "device",
    method: "POST",
    path: "/device/outbox/ack",
    payload: { acks: [] }
  },
  {
    group: "device",
    host: "device",
    method: "POST",
    path: "/device/ingress",
    payload: {
      message: {
        id: "m1",
        chat,
        sender: chat,
        text: "Habari",
        timestamp: new Date().toISOString()
      }
    }
  }
];

/** Each route module's own refusal, distinct from the store's "Connection owner ..." check. */
const routeRefusal: Record<string, string> = {
  connection: "Only the business owner can manage this WhatsApp connection.",
  scopes: "Only the business owner can manage this WhatsApp connection.",
  tools: "Only the business owner can manage this WhatsApp connection.",
  groups: "Only the business owner can manage this WhatsApp connection.",
  account: "Only the business owner can manage this WhatsApp connection.",
  chats: "Only the business owner can manage this WhatsApp connection.",
  workers: "Only the business owner can manage WhatsApp workers.",
  device: "Only the business owner can link WhatsApp on a phone."
};

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "wa-staff-"));
  const store = createCp2Store();
  const main = buildApi({ cp2: { store } });
  const open = vi.fn<LinkedDriver["open"]>(async (input) => {
    void input;
    return {
      pairingCode: async () => "CODE1234",
      groups: async () => [],
      send: async (_chat: string, _text: string, id: string) => id,
      close: vi.fn(),
      logout: async () => undefined
    };
  });
  const linked = Fastify();
  registerLinkedWhatsAppRoutes(
    linked,
    store,
    {
      WHATSAPP_LINKED_ENABLED: "true",
      WHATSAPP_LINKED_SESSION_DIR: root,
      WHATSAPP_LINKED_SESSION_KEY: "01".repeat(32)
    },
    { open },
    { transcriber: null }
  );
  const device = Fastify();
  registerLinkedWhatsAppDeviceRoutes(device, store, {
    WHATSAPP_LINKED_DEVICE_WORKER_ENABLED: "true"
  });
  await Promise.all([linked.ready(), device.ready()]);
  const signUp = async (phone: string) => {
    const signup = await main.inject({
      method: "POST",
      url: "/auth/pin/signup",
      payload: { method: "phone", contact: phone, pin: "1771" }
    });
    expect(signup.statusCode, signup.body).toBe(200);
    const header = signup.headers["set-cookie"];
    return (Array.isArray(header) ? header[0]! : header!).split(";")[0]!;
  };
  const ownerCookie = await signUp("254700009901");
  const created = await main.inject({
    method: "POST",
    url: "/businesses",
    headers: { cookie: ownerCookie },
    payload: { name: "Staff access shop", language: "en" }
  });
  expect(created.statusCode, created.body).toBe(200);
  const businessId = created.json().business.id as string;
  const member = async (role: Exclude<BusinessRole, "owner">, phone: string) => {
    const invited = await main.inject({
      method: "POST",
      url: `/businesses/${businessId}/staff/invitations`,
      headers: { cookie: ownerCookie },
      payload: { phone: `+${phone}`, role, name: `Staff ${role}` }
    });
    expect(invited.statusCode, invited.body).toBe(200);
    const cookie = await signUp(phone);
    const accepted = await main.inject({
      method: "POST",
      url: `/v1/staff-invitations/${invited.json().id}/accept`,
      headers: { cookie }
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(
      store
        .snapshot()
        .memberships.some((entry) => entry.businessId === businessId && entry.role === role)
    ).toBe(true);
    return cookie;
  };
  const hosts: Record<Host, FastifyInstance> = { linked, main, device };
  const call = (route: (typeof routes)[number], cookie: string) =>
    hosts[route.host].inject({
      method: route.method,
      url: `/businesses/${businessId}/channels/whatsapp-linked${route.path}`,
      headers: { cookie },
      ...(route.payload ? { payload: route.payload } : {})
    });
  const close = async () => {
    await Promise.all([linked.close(), device.close(), main.close()]);
    rmSync(root, { recursive: true, force: true });
  };
  return { store, ownerCookie, member, call, open, close };
}

describe("WhatsApp Linked Devices routes refuse non-owner staff", { timeout: 60_000 }, () => {
  it("answers 403 to a manager and to sales, cashier, view-only and driver staff on every route group", async () => {
    const f = await setup();
    try {
      const staff = {
        manager: await f.member("manager", "254700009902"),
        sales_agent: await f.member("sales_agent", "254700009903"),
        cashier: await f.member("cashier", "254700009904"),
        view_only: await f.member("view_only", "254700009905"),
        driver: await f.member("driver", "254700009906")
      };
      const groups = new Set<string>();
      for (const route of routes) {
        for (const [role, cookie] of Object.entries(staff)) {
          const response = await f.call(route, cookie);
          expect(
            response.statusCode,
            `${role} ${route.method} ${route.path || "/"}: ${response.body}`
          ).toBe(403);
          // The route's own role gate refused them, before any store or connector call. (The
          // store re-checks the owner too; this pins the first line of defence.)
          expect(response.json()).toEqual({
            code: "permission_denied",
            message: routeRefusal[route.group]
          });
        }
        groups.add(route.group);
      }
      expect([...groups].sort()).toEqual(
        ["account", "chats", "connection", "device", "groups", "scopes", "tools", "workers"].sort()
      );
      // Staff never reached WhatsApp: no socket was opened on their behalf.
      expect(f.open).not.toHaveBeenCalled();
      // The same routes are not role-blocked for the owner (whatever else they answer, such as a missing consent).
      for (const route of routes) {
        const response = await f.call(route, f.ownerCookie);
        const code = response.body ? (JSON.parse(response.body) as { code?: string }).code : "";
        expect(code, `owner ${route.method} ${route.path}: ${response.body}`).not.toBe(
          "permission_denied"
        );
      }
    } finally {
      await f.close();
    }
  });
});
