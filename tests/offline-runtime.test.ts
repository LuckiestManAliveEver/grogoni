import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  openLocalDatabase,
  LocalProvider,
  SyncClient,
  installOfflineRuntime,
  pinCurrentRuntime,
  swapPinnedRuntime,
  getActivePin,
  resolveConflict,
  executeProviderCall,
  type LocalDatabase,
  type Scope,
  type RuntimeBinding,
  type Operation,
  type Entity,
  type InstallSnapshot,
  type GrogoniProvider
} from "../packages/offline-runtime/index";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

const scope: Scope = { accountId: "account", storeId: "shop", deviceId: "device" };
const databases: LocalDatabase[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.unstubAllEnvs();
});
async function database() {
  const db = await openLocalDatabase(new IDBFactory());
  databases.push(db);
  return db;
}
async function install(
  db: LocalDatabase,
  target = scope,
  collections: InstallSnapshot["collections"] = {}
) {
  await installOfflineRuntime({
    db,
    scope: target,
    businessDataOnly: true,
    binding: null,
    estimate: async () => ({ quota: 2 ** 30, usage: 0 }),
    snapshot: async () => ({
      accountId: target.accountId,
      storeId: target.storeId,
      cursor: "0",
      collections
    }),
    progress: () => undefined
  });
}
const binding: RuntimeBinding = {
  agentId: "agent-v1",
  agentVersion: "1.0",
  modelId: "model",
  modelVersion: "sha256:model-1",
  artifacts: [{ url: "https://example.test/model", sha256: "a".repeat(64), bytes: 10 }]
};

describe("Offline runtime local transactions and installation", () => {
  it("rolls back both the operation and entity on failure and allocates ordered sequences across concurrent writes", async () => {
    const db = await database();
    await install(db);
    const provider = new LocalProvider(db, scope);
    await expect(
      provider.call("catalogue.update", { id: "missing", body: { name: "Rice" } })
    ).rejects.toThrow("snapshot");
    expect((await db.read(scope)).operations).toHaveLength(0);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        provider.call("catalogue.create", { body: { name: `Product ${index}`, quantity: index } })
      )
    );
    const state = await db.read(scope);
    expect(state.operations.map((op) => op.localSeq)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1)
    );
    expect(state.rows.every((row) => row.dirty && row.cloud_id === null)).toBe(true);
    expect((await db.read({ ...scope, accountId: "another" })).rows).toEqual([]);
  });
  it("blocks low or unknown storage and unsupported AI without activating a partial install", async () => {
    const db = await database();
    const snapshot = vi.fn();
    const input = { db, scope, businessDataOnly: true, binding: null, snapshot, progress: vi.fn() };
    await expect(
      installOfflineRuntime({ ...input, estimate: async () => ({ quota: 100, usage: 0 }) })
    ).rejects.toThrow("not enough space");
    await expect(installOfflineRuntime({ ...input, estimate: async () => ({}) })).rejects.toThrow(
      "could not be checked"
    );
    await expect(
      installOfflineRuntime({
        ...input,
        businessDataOnly: false,
        estimate: async () => ({ quota: 2 ** 30, usage: 0 })
      })
    ).rejects.toThrow("no compatible local AI");
    expect(snapshot).not.toHaveBeenCalled();
    expect((await db.read(scope)).offlineModeActive).toBe(false);
  });
  it("keeps the exact pinned runtime through default changes, reconnects and hostile business pull events", async () => {
    const db = await database();
    await install(db);
    await pinCurrentRuntime(db, scope, async () => binding);
    const changed = { ...binding, modelId: "new-model", modelVersion: "v2" };
    await pinCurrentRuntime(db, scope, async () => changed);
    const infer = vi.fn(async (pin) => pin.modelId);
    const provider = new LocalProvider(db, scope, infer);
    expect(await provider.call("agent.infer", {})).toBe("model");
    const sync = new SyncClient(db, scope, {
      push: vi.fn(),
      pull: async () => ({
        accountId: scope.accountId,
        storeId: scope.storeId,
        fromCursor: "0",
        newCursor: "1",
        hasMore: false,
        changes: [
          {
            id: "remote-pin",
            businessId: scope.storeId,
            sequence: 1,
            collection: "device_runtime_pins" as never,
            entityId: "pin",
            entity: { id: "pin", modelId: "malicious" }
          }
        ]
      })
    });
    await sync.pull();
    expect((await getActivePin(db, scope))?.modelId).toBe("model");
    await swapPinnedRuntime(db, scope, changed, async () => undefined);
    expect(await provider.call("agent.infer", {})).toBe("new-model");
    expect((await getActivePin(db, scope))?.explicitSwap).toBe(true);
  });
  it("requires deliberate offline consent and never retries ambiguous cloud mutations locally", async () => {
    const local: GrogoniProvider = {
      name: "local",
      supports: () => true,
      isAvailable: async () => true,
      call: vi.fn()
    };
    const cloud: GrogoniProvider = {
      name: "cloud",
      supports: () => true,
      isAvailable: async () => true,
      call: async () => {
        throw new TypeError("network failed after commit");
      }
    };
    await expect(
      executeProviderCall("catalogue.create", {}, [cloud, local], {
        online: false,
        offlineModeActive: false,
        localAuthorized: true
      })
    ).rejects.toThrow("unavailable offline");
    await expect(
      executeProviderCall("catalogue.create", {}, [cloud, local], {
        online: true,
        offlineModeActive: false,
        localAuthorized: true
      })
    ).rejects.toThrow("after commit");
    expect(local.call).not.toHaveBeenCalled();
    const db = await database();
    await install(db);
    expect(
      await executeProviderCall("catalogue.list", {}, [new LocalProvider(db, scope)], {
        online: false,
        offlineModeActive: true,
        localAuthorized: true
      })
    ).toEqual([]);
  });
});

describe("Offline runtime API integration", () => {
  it("pushes idempotently, persists receipts across restoration, maps IDs and pulls online changes", async () => {
    const fixture = await serverFixture();
    try {
      const db = await database();
      await install(db, fixture.scope);
      const local = new LocalProvider(db, fixture.scope);
      const created = await local.call<Entity>("catalogue.create", {
        body: { name: "Rice", quantity: 10 }
      });
      await local.call("catalogue.update", {
        id: created.id,
        body: { name: "Brown rice", quantity: 9 }
      });
      const original = structuredClone((await db.read(fixture.scope)).operations[0]!);
      const sync = new SyncClient(db, fixture.scope, fixture.transport);
      await sync.sync();
      expect((await db.read(fixture.scope)).operations.map((op) => op.syncStatus)).toEqual([
        "ACKED",
        "ACKED"
      ]);
      const products = await fixture.request(
        "GET",
        `/businesses/${fixture.scope.storeId}/products`
      );
      expect(products.json()).toMatchObject([{ name: "Brown rice", quantity: 9 }]);
      await fixture.transport.push([original]);
      expect(
        (await fixture.request("GET", `/businesses/${fixture.scope.storeId}/products`)).json()
      ).toHaveLength(1);
      const restored = createCp2Store();
      restored.hydrateSnapshot(fixture.store.snapshot());
      expect(restored.pushOfflineOperation(fixture.sessionId, original).status).toBe("ACKED");
      expect(
        restored.listProducts({ sessionId: fixture.sessionId, businessId: fixture.scope.storeId })
      ).toHaveLength(1);
      const productId = products.json()[0].id;
      await fixture.request("PATCH", `/businesses/${fixture.scope.storeId}/products/${productId}`, {
        name: "Online rice",
        quantity: 9
      });
      await sync.pull();
      expect(await local.call("catalogue.list", {})).toMatchObject([
        { id: productId, name: "Online rice" }
      ]);
    } finally {
      await fixture.app.close();
    }
  });
  it("creates, edits and confirms an invoice offline, decrementing stock only once confirm syncs", async () => {
    const fixture = await serverFixture();
    try {
      await fixture.request("POST", `/businesses/${fixture.scope.storeId}/products`, {
        name: "Rice",
        quantity: 10,
        sellingPrice: 5
      });
      const snapshot = fixture.store.getOfflineRuntimeSnapshot(
        fixture.sessionId,
        fixture.scope.storeId
      );
      const db = await database();
      await install(db, fixture.scope, snapshot.collections);
      const productId = snapshot.collections.products[0]!.id;
      const local = new LocalProvider(db, fixture.scope);
      const invoice = await local.call<Entity>("orders.createInvoice", {
        body: { items: [{ productId, quantity: 2, unitPrice: 5 }] }
      });
      expect(invoice).toMatchObject({ status: "draft", total: 10 });
      await local.call("orders.updateInvoice", {
        id: invoice.id,
        body: { items: [{ productId, quantity: 3, unitPrice: 5 }] }
      });
      await expect(
        local.call("orders.confirmInvoice", { id: invoice.id, body: {} })
      ).resolves.toMatchObject({ status: "confirmed" });
      // The stock decrement is deferred to the real server confirmInvoice call on sync, not
      // applied optimistically here - see the comment in local-provider.ts's orders.confirmInvoice
      // branch for why (a locally-dirty product row with no operation of its own would never be
      // overwritable by a later pull).
      expect(
        (await local.call<Entity[]>("catalogue.list", {})).find((row) => row.id === productId)
      ).toMatchObject({ quantity: 10 });
      const sync = new SyncClient(db, fixture.scope, fixture.transport);
      await sync.sync();
      expect(
        (await db.read(fixture.scope)).operations.every((op) => op.syncStatus === "ACKED")
      ).toBe(true);
      expect(
        (await fixture.request("GET", `/businesses/${fixture.scope.storeId}/invoices`)).json()
      ).toMatchObject([{ status: "confirmed", total: 15 }]);
      expect(
        (await fixture.request("GET", `/businesses/${fixture.scope.storeId}/products`)).json()
      ).toMatchObject([{ quantity: 7 }]);
      expect(
        (await local.call<Entity[]>("catalogue.list", {})).find((row) => row.id === productId)
      ).toMatchObject({ quantity: 7 });
    } finally {
      await fixture.app.close();
    }
  });
  it("blocks editing or re-confirming a locally-confirmed invoice, and surfaces a real two-device double-confirm race as a conflict", async () => {
    const fixture = await serverFixture();
    try {
      await fixture.request("POST", `/businesses/${fixture.scope.storeId}/products`, {
        name: "Rice",
        quantity: 10
      });
      const productId = (
        await fixture.request("GET", `/businesses/${fixture.scope.storeId}/products`)
      ).json()[0].id;
      await fixture.request("POST", `/businesses/${fixture.scope.storeId}/invoices`, {
        items: [{ productId, quantity: 1, unitPrice: 5 }]
      });
      // Both devices install from a snapshot that already contains this same draft invoice
      // (already-synced cloud id, no local create/confirm rebase to reason about) - the setup a
      // shop with two devices sharing one draft invoice would actually have.
      const snapshot = fixture.store.getOfflineRuntimeSnapshot(
        fixture.sessionId,
        fixture.scope.storeId
      );
      const invoiceId = snapshot.collections.invoices[0]!.id;
      const second = { ...fixture.scope, deviceId: "second-device" };
      const firstDb = await database();
      const secondDb = await database();
      await install(firstDb, fixture.scope, snapshot.collections);
      await install(secondDb, second, snapshot.collections);
      const first = new LocalProvider(firstDb, fixture.scope);
      await first.call("orders.confirmInvoice", { id: invoiceId, body: {} });
      await expect(
        first.call("orders.updateInvoice", {
          id: invoiceId,
          body: { items: [{ productId, quantity: 1, unitPrice: 5 }] }
        })
      ).rejects.toThrow("cannot be edited");
      await expect(
        first.call("orders.confirmInvoice", { id: invoiceId, body: {} })
      ).rejects.toThrow("already confirmed");
      // Both devices confirm this same invoice offline before either has synced.
      await new LocalProvider(secondDb, second).call("orders.confirmInvoice", {
        id: invoiceId,
        body: {}
      });
      await new SyncClient(firstDb, fixture.scope, fixture.transport).sync();
      await new SyncClient(secondDb, second, fixture.transportFor(second)).sync();
      const secondState = await secondDb.read(second);
      const confirmOp = secondState.operations.find((op) => op.opType === "orders.confirmInvoice");
      expect(confirmOp?.syncStatus).toBe("CONFLICT");
      expect(secondState.conflicts).toMatchObject([
        { message: expect.stringContaining("confirmed") }
      ]);
    } finally {
      await fixture.app.close();
    }
  });
  it("captures a receipt offline with an on-device OCR engine and syncs it into a full OCR job", async () => {
    const fixture = await serverFixture();
    try {
      const db = await database();
      await install(db, fixture.scope);
      const extraction = {
        engine: "tesseract" as const,
        engineVersion: "7.0.0",
        modelVersion: "eng-4.0.0_best_int",
        profile: "mobile" as const,
        fallbackUsed: false,
        blocks: [
          {
            id: "line-0",
            page: 0,
            text: "Acme Supplies",
            confidence: 0.9,
            boundingBox: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 5 },
              { x: 0, y: 5 }
            ]
          }
        ],
        fullText: "Supplier: Acme Supplies\nRice,2,250,500\nTotal: 500",
        averageConfidence: 0.87,
        warnings: []
      };
      const ocr = vi.fn(async () => extraction);
      const local = new LocalProvider(db, fixture.scope, undefined, ocr);
      await expect(
        new LocalProvider(db, fixture.scope).call("receipts.ocr.create", {
          body: { fileName: "receipt.jpg", contentType: "image/jpeg", contentBase64: "Zm9v" }
        })
      ).rejects.toThrow("not installed");
      await expect(
        local.call("receipts.ocr.create", {
          body: { fileName: "receipt.pdf", contentType: "application/pdf", contentBase64: "Zm9v" }
        })
      ).rejects.toThrow("online connection");
      for (const contentType of [
        "image/heic",
        "image/bmp",
        "text/plain",
        "application/octet-stream"
      ]) {
        await expect(
          local.call("receipts.ocr.create", {
            body: { fileName: "receipt", contentType, contentBase64: "Zm9v" }
          })
        ).rejects.toThrow("online connection");
      }
      await expect(
        local.call("receipts.ocr.create", {
          body: { fileName: "receipt.png", contentType: "image/png", contentBase64: "!!!!" }
        })
      ).rejects.toThrow("invalid");
      await expect(
        local.call("receipts.ocr.create", {
          body: {
            fileName: "receipt.png",
            contentType: "image/png",
            contentBase64: "A".repeat(4 * Math.ceil((10 * 1024 * 1024) / 3) + 4)
          }
        })
      ).rejects.toThrow("10 MB");
      expect((await db.read(fixture.scope)).operations).toHaveLength(0);
      expect(ocr).not.toHaveBeenCalled();
      const captured = await local.call<Entity>("receipts.ocr.create", {
        body: { fileName: "receipt.jpg", contentType: "image/jpeg", contentBase64: "Zm9v" }
      });
      expect(ocr).toHaveBeenCalledTimes(1);
      expect(captured).toMatchObject({ status: "REVIEW_REQUIRED", engine: "tesseract" });
      expect(captured.warnings).toContain(
        "Captured offline. Supplier matching and confirmation need an online connection."
      );
      const sync = new SyncClient(db, fixture.scope, fixture.transport);
      await sync.sync();
      expect((await db.read(fixture.scope)).operations[0]?.syncStatus).toBe("ACKED");
      const jobs = await fixture.request(
        "GET",
        `/businesses/${fixture.scope.storeId}/receipt-ocr/jobs`
      );
      expect(jobs.json()).toMatchObject([
        {
          fullText: "Supplier: Acme Supplies\nRice,2,250,500\nTotal: 500",
          engine: "tesseract",
          averageConfidence: 0.87
        }
      ]);
      const cloudJob = jobs.json()[0];
      expect(cloudJob.id).not.toBe(captured.id);
      expect(await local.call("receipts.ocr.list", {})).toMatchObject([{ id: cloudJob.id }]);
      // Replay the queued operation: delivery retries must not create another job.
      const operation = (await db.read(fixture.scope)).operations[0]!;
      await fixture.transport.push([operation]);
      const repeated = await fixture.request(
        "GET",
        `/businesses/${fixture.scope.storeId}/receipt-ocr/jobs`
      );
      expect(repeated.json()).toHaveLength(1);
      const confirm = () =>
        fixture.request(
          "POST",
          `/businesses/${fixture.scope.storeId}/receipt-ocr/jobs/${cloudJob.id}/confirm`,
          { createSupplier: true }
        );
      const receipt = await confirm();
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json()).toMatchObject({
        supplierName: "Acme Supplies",
        total: 500,
        imageStored: false
      });
      expect(receipt.json().lineItems).toHaveLength(1);
      expect((await confirm()).json().id).toBe(receipt.json().id);
      expect(JSON.stringify(operation)).not.toContain("contentBase64");
    } finally {
      await fixture.app.close();
    }
  });
  it("captures a product photo offline with the same on-device OCR engine, extracting real fields and duplicates against the local catalogue", async () => {
    const fixture = await serverFixture();
    try {
      const existingProduct = await fixture.request(
        "POST",
        `/businesses/${fixture.scope.storeId}/products`,
        { name: "Tomatoes", unit: "crate", quantity: 3, sellingPrice: 140 }
      );
      const snapshot = fixture.store.getOfflineRuntimeSnapshot(
        fixture.sessionId,
        fixture.scope.storeId
      );
      const db = await database();
      await install(db, fixture.scope, snapshot.collections);
      const ocr = vi.fn(async () => ({
        engine: "tesseract" as const,
        engineVersion: "7.0.0",
        modelVersion: "eng-4.0.0_best_int",
        profile: "mobile" as const,
        fallbackUsed: false,
        blocks: [],
        fullText: "Tomatoes\nKSh 150",
        averageConfidence: 0.92,
        warnings: []
      }));
      const local = new LocalProvider(db, fixture.scope, undefined, ocr);
      await expect(
        new LocalProvider(db, fixture.scope).call("productCaptures.ocr.create", {
          body: { fileName: "tomatoes.jpg", contentType: "image/jpeg", contentBase64: "Zm9v" }
        })
      ).rejects.toThrow("not installed");
      for (const contentType of ["application/pdf", "image/heic", "text/plain"]) {
        await expect(
          local.call("productCaptures.ocr.create", {
            body: { fileName: "tomatoes", contentType, contentBase64: "Zm9v" }
          })
        ).rejects.toThrow("online connection");
      }
      await expect(
        local.call("productCaptures.ocr.create", {
          body: { fileName: "tomatoes.png", contentType: "image/png", contentBase64: "!!!!" }
        })
      ).rejects.toThrow("invalid");
      // Unpadded base64 (length % 4 of 2 or 3, not just the already-covered 1) must also be
      // rejected rather than silently truncated by Buffer.from's lenient decoder.
      for (const malformed of ["QUJDRA", "QUJDRQE"]) {
        await expect(
          local.call("productCaptures.ocr.create", {
            body: { fileName: "tomatoes.png", contentType: "image/png", contentBase64: malformed }
          })
        ).rejects.toThrow("invalid");
      }
      await expect(
        local.call("productCaptures.ocr.create", {
          body: {
            fileName: "tomatoes.png",
            contentType: "image/png",
            contentBase64: "A".repeat(4 * Math.ceil((10 * 1024 * 1024) / 3) + 4)
          }
        })
      ).rejects.toThrow("10 MB");
      expect((await db.read(fixture.scope)).operations).toHaveLength(0);
      expect(ocr).not.toHaveBeenCalled();
      const captured = await local.call<Entity>("productCaptures.ocr.create", {
        body: { fileName: "tomatoes.jpg", contentType: "image/jpeg", contentBase64: "Zm9v" }
      });
      expect(ocr).toHaveBeenCalledTimes(1);
      expect(captured).toMatchObject({
        status: "REVIEW_REQUIRED",
        fields: { title: { value: "Tomatoes" }, visiblePrice: { value: 150 } },
        temporaryMediaId: null,
        possibleDuplicateProductIds: [existingProduct.json().id]
      });
      const sync = new SyncClient(db, fixture.scope, fixture.transport);
      await sync.sync();
      expect((await db.read(fixture.scope)).operations[0]?.syncStatus).toBe("ACKED");
      const operation = (await db.read(fixture.scope)).operations[0]!;
      expect(JSON.stringify(operation)).not.toContain("contentBase64");
      const cloudId = (await db.read(fixture.scope)).rows.find(
        (row) => row.collection === "productCaptureJobs"
      )?.cloud_id;
      expect(cloudId).not.toBe(captured.id);
      const cloudJob = await fixture.request(
        "GET",
        `/businesses/${fixture.scope.storeId}/product-captures/${cloudId}`
      );
      expect(cloudJob.json()).toMatchObject({
        status: "REVIEW_REQUIRED",
        fields: { title: { value: "Tomatoes" }, visiblePrice: { value: 150 } },
        possibleDuplicateProductIds: [existingProduct.json().id]
      });
      // No image bytes were ever sent, so no product media record was created for this job.
      expect(fixture.store.snapshot().productMedia).toEqual([]);
      // Replay the queued operation: delivery retries must not create another capture job.
      await fixture.transport.push([operation]);
      const repeated = await fixture.request(
        "GET",
        `/businesses/${fixture.scope.storeId}/product-captures/${cloudId}`
      );
      expect(repeated.json().id).toBe(cloudId);
    } finally {
      await fixture.app.close();
    }
  });
  it("still enforces server-side fileName length limits on a product capture synced from offline, even with no image bytes to gate on", async () => {
    const fixture = await serverFixture();
    try {
      const db = await database();
      await install(db, fixture.scope);
      const ocr = vi.fn(async () => ({
        engine: "tesseract" as const,
        engineVersion: "7.0.0",
        modelVersion: "eng-4.0.0_best_int",
        profile: "mobile" as const,
        fallbackUsed: false,
        blocks: [],
        fullText: "Tomatoes\nKSh 150",
        averageConfidence: 0.9,
        warnings: []
      }));
      const local = new LocalProvider(db, fixture.scope, undefined, ocr);
      await local.call("productCaptures.ocr.create", {
        body: {
          fileName: `${"a".repeat(300)}.jpg`,
          contentType: "image/jpeg",
          contentBase64: "Zm9v"
        }
      });
      const sync = new SyncClient(db, fixture.scope, fixture.transport);
      await sync.sync();
      expect((await db.read(fixture.scope)).operations[0]?.syncStatus).toBe("REJECTED");
    } finally {
      await fixture.app.close();
    }
  });
  it("rejects a tampered offline OCR extraction instead of trusting client-supplied confidence", async () => {
    const fixture = await serverFixture();
    try {
      const db = await database();
      await install(db, fixture.scope);
      const ocr = vi.fn(async () => ({
        engine: "not-a-real-engine",
        engineVersion: "1",
        modelVersion: "1",
        profile: "mobile",
        fallbackUsed: false,
        blocks: [],
        fullText: "hi",
        averageConfidence: 2,
        warnings: []
      }));
      const local = new LocalProvider(db, fixture.scope, undefined, ocr as never);
      await local.call("receipts.ocr.create", {
        body: { fileName: "receipt.jpg", contentType: "image/jpeg", contentBase64: "Zm9v" }
      });
      const sync = new SyncClient(db, fixture.scope, fixture.transport);
      await sync.sync();
      expect((await db.read(fixture.scope)).operations[0]?.syncStatus).toBe("REJECTED");
    } finally {
      await fixture.app.close();
    }
  });
  it("surfaces a two-device stock conflict and supports explicit resolution", async () => {
    const fixture = await serverFixture();
    try {
      await fixture.request("POST", `/businesses/${fixture.scope.storeId}/products`, {
        name: "Rice",
        quantity: 10
      });
      const snapshot = fixture.store.getOfflineRuntimeSnapshot(
        fixture.sessionId,
        fixture.scope.storeId
      );
      const second = { ...fixture.scope, deviceId: "second-device" };
      const firstDb = await database();
      const secondDb = await database();
      await install(firstDb, fixture.scope, snapshot.collections);
      await install(secondDb, second, snapshot.collections);
      const id = snapshot.collections.products[0]!.id;
      await new LocalProvider(firstDb, fixture.scope).call("inventory.adjust", {
        id,
        body: { quantityAfter: 8 }
      });
      await new LocalProvider(secondDb, second).call("inventory.adjust", {
        id,
        body: { quantityAfter: 6 }
      });
      await new SyncClient(firstDb, fixture.scope, fixture.transport).sync();
      const secondSync = new SyncClient(secondDb, second, fixture.transportFor(second));
      await secondSync.sync();
      const state = await secondDb.read(second);
      expect(state.operations[0]?.syncStatus).toBe("CONFLICT");
      expect(state.rows[0]?.payload.quantity).toBe(6);
      await secondSync.resolveManual(state.operations[0]!.id, "server");
      expect((await secondDb.read(second)).rows[0]?.payload.quantity).toBe(8);
    } finally {
      await fixture.app.close();
    }
  });
  it("keeps sync available when enrollment is disabled and rejects other-account writes", async () => {
    const fixture = await serverFixture();
    try {
      vi.stubEnv("OFFLINE_RUNTIME_ENABLED", "false");
      expect(
        (
          await fixture.request(
            "GET",
            `/businesses/${fixture.scope.storeId}/offline-runtime/snapshot`
          )
        ).statusCode
      ).toBe(403);
      expect(
        (await fixture.request("GET", `/sync/pull?storeId=${fixture.scope.storeId}`)).statusCode
      ).toBe(200);
      const db = await database();
      await install(db, fixture.scope);
      await new LocalProvider(db, fixture.scope).call("catalogue.create", {
        body: { name: "Rice" }
      });
      const op = (await db.read(fixture.scope)).operations[0]!;
      const response = await fixture.request("POST", "/sync/push", {
        ops: [{ ...op, accountId: "another-account" }]
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await fixture.app.close();
    }
  });
});

describe("Conservative conflict policies and retry limits", () => {
  const base = { id: "item", name: "Rice", quantity: 10 };
  it("merges disjoint permitted fields and rejects overlapping edits", () => {
    expect(
      resolveConflict({
        policy: "merge",
        base,
        local: { ...base, name: "Brown rice" },
        server: { ...base, quantity: 8 },
        allowedFields: ["name", "quantity"]
      })
    ).toEqual({ resolved: true, entity: { id: "item", name: "Brown rice", quantity: 8 } });
    expect(
      resolveConflict({
        policy: "merge",
        base,
        local: { ...base, quantity: 4 },
        server: { ...base, quantity: 8 },
        allowedFields: ["quantity"]
      }).resolved
    ).toBe(false);
    expect(resolveConflict({ policy: "server-wins", base, local: base, server: null })).toEqual({
      resolved: true,
      entity: null
    });
    expect(resolveConflict({ policy: "manual", base, local: base, server: base }).resolved).toBe(
      false
    );
    expect(
      resolveConflict({
        policy: "last-write-wins",
        base,
        local: base,
        server: null,
        localServerSequence: 1,
        remoteServerSequence: 2
      })
    ).toEqual({ resolved: true, entity: null });
    expect(
      resolveConflict({ policy: "last-write-wins", base, local: base, server: null }).resolved
    ).toBe(false);
  });
  it("retains failed uploads with backoff and dead-letters validation failures after three attempts", async () => {
    const db = await database();
    await install(db);
    await new LocalProvider(db, scope).call("catalogue.create", { body: { name: "Rice" } });
    const push = vi.fn(async (ops: Operation[]) => ({
      results: ops.map((op) => ({
        id: op.id,
        localSeq: op.localSeq,
        status: "REJECTED" as const,
        entity: null,
        serverOpId: op.id,
        message: "Invalid field"
      }))
    }));
    const sync = new SyncClient(db, scope, { push, pull: vi.fn() });
    for (let attempt = 0; attempt < 3; attempt++) {
      await db.transaction(scope, (state) => {
        state.operations[0]!.nextAttemptAt = 0;
      });
      await sync.push();
    }
    expect((await db.read(scope)).operations[0]?.syncStatus).toBe("CONFLICT");
    await sync.push();
    expect(push).toHaveBeenCalledTimes(3);
  });
});

async function serverFixture() {
  const store = createCp2Store();
  const app = buildApi({ cp2: { store } });
  const auth = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    payload: { method: "phone", contact: "254700000997", pin: "1234" }
  });
  expect(auth.statusCode).toBe(200);
  const cookies = auth.headers["set-cookie"];
  const cookie = (Array.isArray(cookies) ? cookies[0]! : cookies!).split(";")[0]!;
  const request = (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
    deviceId = "test-device"
  ) =>
    app.inject({
      method,
      url,
      headers: { cookie, "x-grogoni-device-id": deviceId },
      ...(payload === undefined
        ? {}
        : {
            payload: JSON.stringify(payload),
            headers: { cookie, "x-grogoni-device-id": deviceId, "content-type": "application/json" }
          })
    });
  const created = await request("POST", "/businesses", { name: "Offline shop", language: "en" });
  expect(created.statusCode).toBe(200);
  const target = {
    accountId: auth.json().account.id,
    storeId: created.json().business.id,
    deviceId: "test-device"
  };
  const transportFor = (identity: Scope) => ({
    push: async (ops: Operation[]) => {
      const response = await request("POST", "/sync/push", { ops }, identity.deviceId);
      if (response.statusCode !== 200) throw new Error(response.body);
      return response.json();
    },
    pull: async (cursor: string | null) => {
      const response = await request(
        "GET",
        `/sync/pull?storeId=${identity.storeId}${cursor === null ? "" : `&since=${cursor}`}`
      );
      if (response.statusCode !== 200) throw new Error(response.body);
      return response.json();
    }
  });
  return {
    app,
    store,
    request,
    scope: target,
    sessionId: auth.json().session.id as string,
    transportFor,
    transport: transportFor(target)
  };
}
