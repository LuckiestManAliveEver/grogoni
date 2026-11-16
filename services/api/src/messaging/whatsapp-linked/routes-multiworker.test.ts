import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLinkedWorkerCredential } from "@grogoni/shared-types";
import { buildApi } from "../../app.js";
import { createCp2Store } from "../../cp2/store.js";
import { probationAllows } from "../../cp2/recovery-probation-routes.js";
import type { LinkedDriver } from "./connector.js";
import type { LinkedLeaseSql } from "./lease.js";
import { registerLinkedWhatsAppRoutes } from "./routes.js";
import { MemoryLinkedWorkerRegistry } from "./worker-registry.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function base() {
  const root = mkdtempSync(join(tmpdir(), "wa-multi-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return {
    WHATSAPP_LINKED_ENABLED: "true",
    WHATSAPP_LINKED_SESSION_DIR: root,
    WHATSAPP_LINKED_SESSION_KEY: "01".repeat(32)
  } as Record<string, string>;
}
const lease = {
  WHATSAPP_LINKED_LEASE_MODE: "postgres",
  WHATSAPP_LINKED_INTERNAL_URL: "http://10.0.0.5:4000",
  WHATSAPP_LINKED_INTERNAL_TOKEN: "i".repeat(32),
  WHATSAPP_LINKED_WORKER_ID: "worker-test"
};

/** A Postgres stand-in that answers the lease statements and records every one of them. */
function recordingSql() {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  let generation = 0;
  const sql: LinkedLeaseSql = {
    async query(text, values) {
      statements.push({ text, values });
      if (/insert into whatsapp_linked_leases/.test(text))
        return { rows: [{ generation: String(++generation) }] };
      if (/returning 1 as (renewed|published)/.test(text)) return { rows: [{ ok: 1 }] };
      if (/select 1 as held/.test(text)) return { rows: [{ held: 1 }] };
      return { rows: [] };
    }
  };
  return { sql, statements };
}

function driver() {
  const events: Parameters<LinkedDriver["open"]>[0][] = [];
  const logout = vi.fn(async () => undefined);
  return {
    events,
    logout,
    driver: {
      open: vi.fn(async (input) => {
        events.push(input);
        return {
          pairingCode: async () => "CODE1234",
          send: async (_c: string, _t: string, id: string) => id,
          close: vi.fn(),
          logout
        };
      })
    } satisfies LinkedDriver
  };
}

async function owner(
  main: ReturnType<typeof buildApi>,
  store: ReturnType<typeof createCp2Store>,
  phone: string
) {
  const signup = await main.inject({
    method: "POST",
    url: "/auth/pin/signup",
    payload: { method: "phone", contact: phone, pin: "1771" }
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const header = signup.headers["set-cookie"];
  const cookie = (Array.isArray(header) ? header[0]! : header!).split(";")[0]!;
  const created = await main.inject({
    method: "POST",
    url: "/businesses",
    headers: { cookie },
    payload: { name: "Multi worker shop", language: "en" }
  });
  expect(created.statusCode, created.body).toBe(200);
  const businessId = created.json().business.id as string;
  const ownerId = store
    .snapshot()
    .memberships.find((m) => m.businessId === businessId && m.role === "owner")!.userId;
  return { cookie, businessId, ownerId };
}

async function host(
  environment: Record<string, string>,
  options: Parameters<typeof registerLinkedWhatsAppRoutes>[4] = {}
) {
  const store = createCp2Store();
  const main = buildApi({ cp2: { store } });
  cleanups.push(() => main.close());
  const first = await owner(main, store, "254700009881");
  const second = await owner(main, store, "254700009882");
  const mock = driver();
  const app = Fastify();
  registerLinkedWhatsAppRoutes(app, store, environment, mock.driver, {
    transcriber: null,
    ...options
  });
  await app.ready();
  cleanups.push(() => app.close());
  return { app, store, first, second, ...mock };
}

describe("multi-worker startup settings", () => {
  const register = (environment: Record<string, string>, database?: LinkedLeaseSql) =>
    registerLinkedWhatsAppRoutes(Fastify(), createCp2Store(), environment, driver().driver, {
      transcriber: null,
      ...(database ? { database } : {})
    });

  it("refuses every misconfiguration before taking the volume", () => {
    expect(() => register({ ...base(), ...lease })).toThrow("DATABASE_URL");
    expect(() =>
      register({ ...base(), ...lease, WHATSAPP_LINKED_INTERNAL_URL: "" }, recordingSql().sql)
    ).toThrow("INTERNAL_URL");
    expect(() =>
      register({ ...base(), ...lease, WHATSAPP_LINKED_INTERNAL_TOKEN: "x" }, recordingSql().sql)
    ).toThrow("INTERNAL_TOKEN");
    expect(() => register({ ...base(), WHATSAPP_LINKED_LEASE_MODE: "redis" })).toThrow(
      "off or postgres"
    );
    expect(() => register({ ...base(), WHATSAPP_LINKED_SHARED_VOLUME: "true" })).toThrow(
      "requires WHATSAPP_LINKED_LEASE_MODE=postgres"
    );
    expect(() => register({ ...base(), WHATSAPP_LINKED_SHARED_VOLUME: "yes" })).toThrow(
      "true or false"
    );
    expect(() => register({ ...base(), WHATSAPP_LINKED_HUB_LISTEN: "0.0.0.0:7443" })).toThrow(
      "requires TLS"
    );
    expect(() =>
      register({
        ...base(),
        WHATSAPP_LINKED_HUB_LISTEN: "127.0.0.1:0",
        WHATSAPP_LINKED_WORKER_CREDENTIAL_DAYS: "365"
      })
    ).toThrow("CREDENTIAL_DAYS");
  });

  it("refuses a second single-process worker on a volume shared-mode workers use, and vice versa", async () => {
    const environment: Record<string, string> = {
      ...base(),
      ...lease,
      WHATSAPP_LINKED_SHARED_VOLUME: "true"
    };
    const shared = Fastify();
    registerLinkedWhatsAppRoutes(shared, createCp2Store(), environment, driver().driver, {
      transcriber: null,
      database: recordingSql().sql
    });
    cleanups.push(() => shared.close());
    // A second shared-mode worker is welcome: the lease, not the lock, separates sessions.
    const peer = Fastify();
    registerLinkedWhatsAppRoutes(peer, createCp2Store(), environment, driver().driver, {
      transcriber: null,
      database: recordingSql().sql
    });
    cleanups.push(() => peer.close());
    const single = {
      WHATSAPP_LINKED_ENABLED: "true",
      WHATSAPP_LINKED_SESSION_DIR: environment.WHATSAPP_LINKED_SESSION_DIR!,
      WHATSAPP_LINKED_SESSION_KEY: environment.WHATSAPP_LINKED_SESSION_KEY!
    };
    expect(() =>
      registerLinkedWhatsAppRoutes(Fastify(), createCp2Store(), single, driver().driver, {
        transcriber: null
      })
    ).toThrow("owns this session volume");
  });
});

describe("WHATSAPP_LINKED_LEASE_MODE", () => {
  it("off: no lease statement is ever issued", async () => {
    const db = recordingSql();
    const h = await host(base(), { database: db.sql });
    const connect = await h.app.inject({
      method: "POST",
      url: `/businesses/${h.first.businessId}/channels/whatsapp-linked/connect`,
      headers: { cookie: h.first.cookie },
      payload: { consent: true, phone: "254700000000" }
    });
    expect(connect.statusCode, connect.body).toBe(200);
    expect(db.statements).toEqual([]);
  });

  it("postgres: connect takes the lease with this worker's id and internal URL before any socket", async () => {
    const db = recordingSql();
    const h = await host({ ...base(), ...lease }, { database: db.sql });
    const connect = await h.app.inject({
      method: "POST",
      url: `/businesses/${h.first.businessId}/channels/whatsapp-linked/connect`,
      headers: { cookie: h.first.cookie },
      payload: { consent: true, phone: "254700000000" }
    });
    expect(connect.statusCode, connect.body).toBe(200);
    expect(connect.json().state).toBe("PAIRING");
    const acquire = db.statements.find((s) => /insert into whatsapp_linked_leases/.test(s.text));
    expect(acquire?.values).toEqual([
      h.first.businessId,
      "worker-test",
      30_000,
      "http://10.0.0.5:4000"
    ]);
    // The socket opened only after the lease statement.
    expect(h.events).toHaveLength(1);
    // The holder publishes its state for other workers' readiness.
    h.events[0]!.save("auth");
    h.events[0]!.state("open");
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      db.statements.some((s) => /set holder_state/.test(s.text) && s.values[3] === "CONNECTED")
    ).toBe(true);
  });
});

describe("remote worker enrollment routes", () => {
  const hub = { WHATSAPP_LINKED_HUB_LISTEN: "127.0.0.1:0" };

  it("lets only the owner enroll, rotate and revoke; shows the credential once and never its hash", async () => {
    const registry = new MemoryLinkedWorkerRegistry();
    const h = await host({ ...base(), ...hub }, { workerRegistry: registry });
    const path = `/businesses/${h.first.businessId}/channels/whatsapp-linked/workers`;
    const call = (
      method: "GET" | "POST" | "DELETE",
      url: string,
      cookie: string,
      payload?: unknown
    ) => h.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

    expect((await call("POST", path, h.first.cookie, { label: "pc" })).json().code).toBe(
      "whatsapp_worker_consent_required"
    );
    expect(
      (await call("POST", path, h.first.cookie, { consent: true, label: "<script>" })).json().code
    ).toBe("whatsapp_worker_label_invalid");
    // Another business's owner has no authority here.
    expect(
      (await call("POST", path, h.second.cookie, { consent: true, label: "pc" })).statusCode
    ).toBe(403);

    const enrolled = await call("POST", path, h.first.cookie, {
      consent: true,
      label: "Back office PC"
    });
    expect(enrolled.statusCode, enrolled.body).toBe(201);
    expect(enrolled.headers["cache-control"]).toBe("no-store");
    const { worker, credential } = enrolled.json();
    const parsed = parseLinkedWorkerCredential(credential)!;
    expect(parsed.workerId).toBe(worker.id);
    expect(worker).toMatchObject({ status: "active", credentialVersion: 1, attached: false });
    expect(
      (await call("POST", path, h.first.cookie, { consent: true, label: "second" })).statusCode
    ).toBe(409);

    const listed = await call("GET", path, h.first.cookie);
    expect(listed.json().available).toBe(true);
    expect(listed.body).not.toContain(parsed.secret);
    expect(listed.body).not.toMatch(/[0-9a-f]{64}/);

    const rotated = await call("POST", `${path}/${worker.id}/rotate`, h.first.cookie);
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json().credential).not.toBe(credential);
    expect(await registry.authenticate(worker.id, parsed.secret)).toEqual({
      refusal: "credential_invalid"
    });
    expect((await call("POST", `${path}/${worker.id}/rotate`, h.second.cookie)).statusCode).toBe(
      403
    );

    const revoked = await call("DELETE", `${path}/${worker.id}`, h.first.cookie);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().worker.status).toBe("revoked");
    expect(
      (await call("DELETE", `${path}/00000000-0000-4000-8000-000000000000`, h.first.cookie))
        .statusCode
    ).toBe(404);
  });

  it("revoking a worker unlinks the WhatsApp session it carried", async () => {
    const registry = new MemoryLinkedWorkerRegistry();
    const h = await host({ ...base(), ...hub }, { workerRegistry: registry });
    const channel = `/businesses/${h.first.businessId}/channels/whatsapp-linked`;
    // Linked before the worker existed, on the local driver.
    await h.app.inject({
      method: "POST",
      url: `${channel}/connect`,
      headers: { cookie: h.first.cookie },
      payload: { consent: true, phone: "254700000000" }
    });
    h.events[0]!.save("auth");
    h.events[0]!.state("open");
    const enrolled = await h.app.inject({
      method: "POST",
      url: `${channel}/workers`,
      headers: { cookie: h.first.cookie },
      payload: { consent: true, label: "pc" }
    });
    const revoked = await h.app.inject({
      method: "DELETE",
      url: `${channel}/workers/${enrolled.json().worker.id}`,
      headers: { cookie: h.first.cookie }
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(h.logout).toHaveBeenCalledTimes(1);
    const status = await h.app.inject({
      method: "GET",
      url: channel,
      headers: { cookie: h.first.cookie }
    });
    expect(status.json().state).toBe("DISCONNECTED");
  });

  it("answers 503 while remote workers are off, and every write is refused during recovery probation", async () => {
    const h = await host(base());
    const path = `/businesses/${h.first.businessId}/channels/whatsapp-linked/workers`;
    const list = await h.app.inject({
      method: "GET",
      url: path,
      headers: { cookie: h.first.cookie }
    });
    expect(list.json()).toEqual({ available: false, workers: [] });
    const enroll = await h.app.inject({
      method: "POST",
      url: path,
      headers: { cookie: h.first.cookie },
      payload: { consent: true, label: "pc" }
    });
    expect(enroll.statusCode).toBe(503);
    const pattern = "/businesses/:businessId/channels/whatsapp-linked/workers";
    expect(probationAllows("POST", pattern)).toBe(false);
    expect(probationAllows("POST", `${pattern}/:workerId/rotate`)).toBe(false);
    expect(probationAllows("DELETE", `${pattern}/:workerId`)).toBe(false);
    expect(probationAllows("GET", pattern)).toBe(true);
  });
});
