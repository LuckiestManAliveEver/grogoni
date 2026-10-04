// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";

vi.mock("../apps/web/src/offline-ocr", () => ({
  runLocalOcr: async () => ({
    engine: "tesseract",
    engineVersion: "7.0.0",
    modelVersion: "eng",
    profile: "mobile",
    fallbackUsed: false,
    blocks: [],
    fullText: "Supplier: Acme\nTotal: 500",
    averageConfidence: 0.9,
    warnings: []
  })
}));
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// Whole-flow tests (IndexedDB, React, fake network): ~2.5s alone, much longer on a busy machine,
// so each gets a 30s budget; every step waits for the UI state it expects, not a fixed time.
describe("Receipt scan recovery in Suppliers", () => {
  it("shows every persisted scan without suppliers, recovers after remount, and confirms the synced ID online", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    localStorage.setItem(
      "grogoni.auth-bootstrap.v1",
      JSON.stringify({
        account: { id: "account" },
        user: { id: "user" },
        session: { id: "session", expiresAt: "2099-01-01" },
        cachedAt: "2026-09-10"
      })
    );
    const scope = { accountId: "account", storeId: "shop", deviceId: "device" };
    localStorage.setItem("grogoni.offline-runtime.active.v1", JSON.stringify(scope));
    const offline = await import("../apps/web/src/offline-runtime");
    const db = await offline.offlineDatabase();
    await db.transaction(scope, (state) => {
      state.installed = true;
      state.offlineModeActive = true;
    });
    for (const name of ["first.png", "second.png"])
      await offline.routeOfflineRequest("/businesses/shop/receipt-ocr/jobs", "POST", {
        fileName: name,
        contentType: "image/png",
        contentBase64: "Zm9v"
      });
    const { createElement, act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { SupplierSurface } = await import("../apps/web/src/SupplierSurface");
    const { useSuppliersState } = await import("../apps/web/src/hooks/useSuppliersState");
    const refreshes = new Map<string, (businessId: string) => Promise<void>>();
    const setStatusMessage = vi.fn();
    const noOp = () => {};
    function Harness() {
      const state = useSuppliersState({
        businessId: "shop",
        setStatusMessage,
        loadReports: async () => {},
        registerReset: noOp,
        registerRefresh: (key, _views, callback) => {
          refreshes.set(key, callback);
        }
      });
      return createElement(SupplierSurface, {
        suppliers: state.suppliers,
        purchaseReceipts: state.purchaseReceipts,
        receiptOcrJobs: state.receiptOcrJobs,
        form: state.supplierForm,
        onFormChange: noOp,
        onSave: noOp,
        onReset: noOp,
        onEdit: noOp,
        onDelete: noOp,
        onSaveSalesAgent: noOp,
        onDeleteSalesAgent: noOp,
        onSearchContacts: async () => [],
        onLinkSupplierContact: noOp,
        onCreateSupplierFromContact: noOp,
        onLinkSalesAgentContact: noOp,
        onCreateSalesAgentFromContact: noOp,
        onUploadReceipt: state.uploadSupplierReceipt,
        onConfirmReceipt: (job) => {
          void state.confirmSupplierReceipt(job);
        },
        onImport: noOp
      });
    }
    const host = document.createElement("div");
    document.body.append(host);
    let root = createRoot(host);
    // Wait for the UI to reach a state instead of sleeping a fixed time: IndexedDB, the network
    // mock and effects settle much later on a loaded machine.
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!condition() && Date.now() < deadline) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
    };
    const confirmButtons = () =>
      [...host.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Confirm and save"
      );
    try {
      for (let mount = 0; mount < 2; mount++) {
        await act(async () => {
          root.render(createElement(Harness));
        });
        await act(async () => {
          await refreshes.get("receipt-ocr-jobs")!("shop");
        });
        expect(host.querySelector('input[type="file"]')).not.toBeNull();
        expect(host.textContent).toContain("first.png");
        expect(host.textContent).toContain("second.png");
        expect(confirmButtons()).toHaveLength(2);
        expect(confirmButtons().every((button) => button.disabled)).toBe(true);
        expect(network).not.toHaveBeenCalled();
        if (mount === 0) {
          await act(async () => root.unmount());
          root = createRoot(host);
        }
      }
      const job = (await db.read(scope)).rows[0]!.payload;
      let confirmed = false;
      network.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/cloud-job/confirm") && init?.method === "POST") {
          confirmed = true;
          return Response.json({ id: "receipt" });
        }
        if (url.endsWith("/receipt-ocr/jobs"))
          return Response.json([
            {
              ...job,
              id: "cloud-job",
              status: confirmed ? "COMPLETED" : "REVIEW_REQUIRED",
              supplierName: "Acme"
            }
          ]);
        return Response.json([]);
      });
      await act(async () => {
        localStorage.removeItem("grogoni.offline-runtime.active.v1");
        window.dispatchEvent(new Event(offline.offlineModeEvent));
      });
      await until(() => confirmButtons().length === 1 && !confirmButtons()[0]!.disabled);
      expect(confirmButtons()).toHaveLength(1);
      expect(confirmButtons()[0]!.disabled).toBe(false);
      await act(async () => {
        confirmButtons()[0]!.click();
      });
      await until(() => (host.textContent ?? "").includes("COMPLETED"));
      expect(
        network.mock.calls.some(
          ([url, init]) => String(url).endsWith("/cloud-job/confirm") && init.method === "POST"
        )
      ).toBe(true);
      expect(host.textContent).toContain("COMPLETED");
      expect(confirmButtons()[0]!.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      db.close();
    }
  }, 30_000);
});
