import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@grogoni/offline-runtime", () => ({ assertStorage: vi.fn() }));
import { prepareOfflineShell } from "../apps/web/src/offline-shell";

const put = vi.fn();
const network = vi.fn();
beforeEach(() => {
  vi.stubEnv("DEV", false);
  put.mockReset();
  network.mockReset();
  vi.stubGlobal("navigator", {
    serviceWorker: { controller: {} },
    storage: { estimate: async () => ({ quota: 2 ** 30, usage: 0 }) }
  });
  vi.stubGlobal("caches", { open: async () => ({ put }) });
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function manifest(value: unknown = { files: ["assets/app-123.js"], bytes: 12 }) {
  network.mockResolvedValueOnce(new Response(JSON.stringify(value)));
}

describe("offline shell installation", () => {
  it("downloads without account credentials and publishes HTML only after all assets", async () => {
    manifest();
    network.mockResolvedValueOnce(new Response("app"));
    network.mockResolvedValueOnce(
      new Response("<html>shell</html>", {
        headers: { "content-type": "text/html" }
      })
    );
    await prepareOfflineShell(vi.fn());
    expect(put.mock.calls.map(([path]) => path)).toEqual(["/assets/app-123.js", "/"]);
    for (const [, options] of network.mock.calls) expect(options.credentials).toBe("omit");
  });

  it.each(["private", "no-store", 'public, private="field"'])(
    "refuses to persist responses marked %s",
    async (policy) => {
      manifest();
      network.mockResolvedValueOnce(
        new Response("private data", {
          headers: { "cache-control": policy }
        })
      );
      await expect(prepareOfflineShell(vi.fn())).rejects.toThrow("not safe");
      expect(put).not.toHaveBeenCalled();
    }
  );

  it("keeps the previous shell when an asset download fails", async () => {
    manifest({ files: ["assets/a.js", "assets/b.js"], bytes: 20 });
    network.mockResolvedValueOnce(new Response("a"));
    network.mockRejectedValueOnce(new Error("offline"));
    await expect(prepareOfflineShell(vi.fn())).rejects.toThrow("offline");
    expect(put.mock.calls.map(([path]) => path)).toEqual(["/assets/a.js"]);
  });

  it.each([
    null,
    { files: ["assets/a.js"], bytes: -1 },
    { files: ["assets/a.js"], bytes: null },
    { files: ["assets/../auth/session"], bytes: 1 },
    { files: ["assets/a.js", "assets/a.js"], bytes: 1 }
  ])("rejects malformed manifest %j before writing to storage", async (value) => {
    manifest(value);
    await expect(prepareOfflineShell(vi.fn())).rejects.toThrow("Invalid offline");
    expect(put).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(1);
  });
});
