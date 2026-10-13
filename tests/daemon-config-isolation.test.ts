import { afterEach, describe, expect, it } from "vitest";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";

/**
 * A bad DAEMON_* secret must disable only the daemon lanes. Before this, the configuration error
 * escaped domain startup and every domain route on the Edge API answered 503.
 */
describe("daemon configuration errors stay inside the daemon", () => {
  const saved = process.env.DAEMON_USER_MAX_ACTIVE;
  afterEach(() => {
    if (saved === undefined) delete process.env.DAEMON_USER_MAX_ACTIVE;
    else process.env.DAEMON_USER_MAX_ACTIVE = saved;
  });

  it("starts the domain and answers daemon routes with 503 daemon_unavailable", async () => {
    process.env.DAEMON_USER_MAX_ACTIVE = "0";
    const unused = () => Promise.reject(new Error("no database in this test"));
    const domain = await createEdgeDomainRoutes({
      transaction: unused,
      daemon: {
        queue: { query: unused, connect: unused } as never,
        hint: null,
        findUser: async () => ({ userId: "u" })
      }
    });
    expect(domain.inventory.length).toBeGreaterThan(100);
    const response = await domain.daemonRoutes(
      new Request("https://edge.test/v1/daemon/tasks"),
      "/v1/daemon/tasks"
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ code: "daemon_unavailable" });
  });
});
