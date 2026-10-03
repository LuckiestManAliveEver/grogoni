// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe("Chat API offline adapter", () => {
  it("requires confirmation in Settings before installing and keeps sync explicit", async () => {
    vi.stubEnv("VITE_OFFLINE_RUNTIME_ENABLED", "true");
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: async () => ({ quota: 2 ** 30, usage: 0 }) }
    });
    localStorage.setItem(
      "grogoni.auth-bootstrap.v1",
      JSON.stringify({
        account: { id: "account" },
        user: { id: "user" },
        session: { id: "session", expiresAt: "2030-01-01" },
        cachedAt: "2026-09-10"
      })
    );
    const network = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            accountId: "account",
            storeId: "shop",
            cursor: "0",
            collections: { products: [{ id: "rice", businessId: "shop", name: "Rice" }] }
          }),
          { headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", network);
    const { createElement, act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { OfflineRuntimeSettings } = await import("../apps/web/src/OfflineRuntimeSettings");
    const { offlineDatabase } = await import("../apps/web/src/offline-runtime");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const button = (text: string) =>
      [...document.querySelectorAll("button")].find((entry) => entry.textContent === text)!;
    try {
      await act(async () => {
        root.render(
          createElement(OfflineRuntimeSettings, { accountId: "account", businessId: "shop" })
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      await act(async () => {
        button("Prepare offline storage").click();
      });
      expect(document.body.textContent).toContain("Set up offline mode");
      await act(async () => {
        button("Continue").click();
      });
      expect(document.body.textContent).toContain("Choose a destination");
      await act(async () => {
        button("Continue").click();
      });
      expect(document.body.textContent).toContain("Ready to install");
      expect(network).not.toHaveBeenCalled();
      await act(async () => {
        button("Install").click();
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      expect(host.textContent).toContain("Offline business data is prepared");
      await act(async () => {
        button("Done").click();
      });
      expect(network).toHaveBeenCalledTimes(1);
      expect(String(network.mock.calls[0]?.[0])).toContain("offline-runtime/snapshot");
      // Installing only prepares the snapshot now - going offline is a separate, explicit step
      // (either this standalone toggle, or the header's runtime handoff for an active agent
      // conversation), so sync stays impossible to trigger by accident from Install alone.
      await act(async () => {
        button("Resume saved offline session").click();
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(host.textContent).toContain("Offline mode is active");
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(network).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("Sync and go back online");
      await act(async () => {
        localStorage.removeItem("grogoni.offline-runtime.active.v1");
        window.dispatchEvent(new Event("storage"));
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      await act(async () => {
        button("Resume saved offline session").click();
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(host.textContent).toContain("Offline mode is active");
      expect(network).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      (await offlineDatabase()).close();
    }
  });
  it("routes persisted offline sessions locally after reload, blocks unsupported calls and prevents account crossover", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("crypto", webcrypto);
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    localStorage.setItem(
      "grogoni.auth-bootstrap.v1",
      JSON.stringify({
        account: { id: "account" },
        user: { id: "user" },
        session: { id: "session", expiresAt: "2030-01-01" },
        cachedAt: "2026-09-10"
      })
    );
    localStorage.setItem(
      "grogoni.offline-runtime.active.v1",
      JSON.stringify({ accountId: "account", storeId: "shop", deviceId: "device" })
    );
    const offline = await import("../apps/web/src/offline-runtime");
    const { apiFetch } = await import("../apps/web/src/lib/api");
    const db = await offline.offlineDatabase();
    const scope = offline.currentOfflineScope()!;
    try {
      await db.transaction(scope, (state) => {
        state.installed = true;
        state.offlineModeActive = true;
      });
      await apiFetch("/businesses/shop/products", {
        method: "POST",
        body: { name: "Rice", quantity: 3 }
      });
      expect(await apiFetch("/businesses/shop/products")).toMatchObject([
        { name: "Rice", quantity: 3 }
      ]);
      await expect(apiFetch("/businesses/other-shop/products")).rejects.toThrow(
        "unavailable offline"
      );
      await expect(apiFetch("/auth/bootstrap")).rejects.toThrow("unavailable offline");
      await expect(
        apiFetch("/businesses/shop/payments", { method: "POST", body: {} })
      ).rejects.toThrow("unavailable offline");
      expect(network).not.toHaveBeenCalled();
      localStorage.setItem(
        "grogoni.auth-bootstrap.v1",
        JSON.stringify({
          account: { id: "other-account" },
          user: { id: "other" },
          session: { id: "session", expiresAt: "2030-01-01" },
          cachedAt: "2026-09-10"
        })
      );
      expect(offline.currentOfflineScope()).toBeNull();
      await expect(
        offline.routeOfflineRequest("/businesses/shop/products", "GET", undefined)
      ).rejects.toThrow("no longer signed in");
    } finally {
      db.close();
    }
  });
});
