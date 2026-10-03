import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ocrAssetFiles, ocrManifestVersion } from "../apps/web/src/offline-ocr-assets";

const mocks = vi.hoisted(() => ({ createWorker: vi.fn(), recognize: vi.fn(), terminate: vi.fn() }));
vi.mock("../apps/web/node_modules/tesseract.js", () => ({
  createWorker: mocks.createWorker,
  OEM: { LSTM_ONLY: 1 }
}));
let stored: Map<string, Response>;
let network: ReturnType<typeof vi.fn>;
const bytes = new TextEncoder().encode("verified OCR bytes");
const manifest = {
  version: ocrManifestVersion,
  artifacts: ocrAssetFiles.map((file) => ({
    url: `/tesseract/${file}`,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  }))
};
const input = { fileName: "receipt.png", contentType: "image/png", contentBase64: "Zm9v" };
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("caches", {
    open: async () => ({
      match: async (key: string) => stored.get(key)?.clone(),
      put: async (key: string, value: Response) => {
        stored.set(key, value);
      },
      delete: async (key: string) => stored.delete(key)
    })
  });
  vi.stubGlobal("navigator", {
    serviceWorker: { controller: {} },
    storage: { estimate: async () => ({ quota: 2 ** 30, usage: 0 }) }
  });
  vi.stubGlobal("location", { origin: "https://grogoni.test" });
  network = vi.fn(async (url: string) =>
    url.endsWith("manifest.json") ? Response.json(manifest) : new Response(bytes)
  );
  vi.stubGlobal("fetch", network);
  mocks.recognize.mockResolvedValue({
    data: { text: "ACME\nTOTAL 500", confidence: 90, blocks: [] }
  });
  mocks.createWorker.mockResolvedValue({ recognize: mocks.recognize, terminate: mocks.terminate });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.resetModules();
});

describe("Offline OCR installation and worker", () => {
  it("installs verified executable assets and checks readiness without network activity", async () => {
    const ocr = await import("../apps/web/src/offline-ocr");
    expect(await ocr.isOcrEngineCached()).toBe(false);
    expect(network).not.toHaveBeenCalled();
    await ocr.ensureOcrEngineCached(vi.fn());
    expect(network).toHaveBeenCalledTimes(6);
    network.mockClear();
    expect(await ocr.isOcrEngineCached()).toBe(true);
    expect(stored.get("/tesseract/worker.min.js")?.headers.get("content-type")).toBe(
      "application/javascript"
    );
    expect(await ocr.runLocalOcr(input)).toMatchObject({
      fullText: "ACME\nTOTAL 500",
      averageConfidence: 0.9
    });
    expect(network).not.toHaveBeenCalled();
    expect(mocks.createWorker).toHaveBeenCalledWith(
      "eng",
      1,
      expect.objectContaining({
        workerBlobURL: false,
        cacheMethod: "none",
        workerPath: "https://grogoni.test/tesseract/worker.min.js"
      })
    );
  });
  it.each([
    { ...manifest, artifacts: [] },
    { ...manifest, version: "old" },
    { ...manifest, artifacts: manifest.artifacts.slice(1) },
    {
      ...manifest,
      artifacts: manifest.artifacts.map((item, i) =>
        i ? item : { ...item, url: "https://third-party.test/worker.js" }
      )
    },
    {
      ...manifest,
      artifacts: manifest.artifacts.map((item, i) => (i ? item : { ...item, bytes: -1 }))
    }
  ])("rejects an incomplete, outdated or malformed manifest", async (invalid) => {
    const ocr = await import("../apps/web/src/offline-ocr");
    network.mockResolvedValue(Response.json(invalid));
    await expect(ocr.ensureOcrEngineCached(vi.fn())).rejects.toThrow("manifest");
    expect(stored.size).toBe(0);
  });
  it("does not mark interrupted or corrupt installations ready, and allows retry", async () => {
    const ocr = await import("../apps/web/src/offline-ocr");
    network
      .mockImplementationOnce(async () => Response.json(manifest))
      .mockImplementationOnce(async () => new Response("bad"));
    await expect(ocr.ensureOcrEngineCached(vi.fn())).rejects.toThrow("integrity");
    expect(await ocr.isOcrEngineCached()).toBe(false);
    await ocr.ensureOcrEngineCached(vi.fn());
    expect(await ocr.isOcrEngineCached()).toBe(true);
    stored.set(
      "/tesseract/worker.min.js",
      new Response("corrupt", { headers: { "content-type": "application/javascript" } })
    );
    network.mockClear();
    expect(await ocr.isOcrEngineCached()).toBe(false);
    await expect(ocr.runLocalOcr(input)).rejects.toThrow("not installed");
    expect(network).not.toHaveBeenCalled();
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });
  it("requires a controlling service worker and enough storage before downloading assets", async () => {
    const ocr = await import("../apps/web/src/offline-ocr");
    vi.stubGlobal("navigator", { serviceWorker: { controller: null } });
    await expect(ocr.ensureOcrEngineCached(vi.fn())).rejects.toThrow("Reload");
    expect(network).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", {
      serviceWorker: { controller: {} },
      storage: { estimate: async () => ({ quota: 100, usage: 0 }) }
    });
    await expect(ocr.ensureOcrEngineCached(vi.fn())).rejects.toThrow("not enough space");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("recovers when language initialization reports an error without settling createWorker", async () => {
    const ocr = await import("../apps/web/src/offline-ocr");
    await ocr.ensureOcrEngineCached(vi.fn());
    mocks.createWorker.mockImplementationOnce((_lang, _mode, options) => {
      queueMicrotask(() => options.errorHandler("language initialization failed"));
      return new Promise(() => {});
    });
    await expect(ocr.runLocalOcr(input)).rejects.toThrow("language initialization failed");
    await expect(ocr.runLocalOcr(input)).resolves.toMatchObject({ fullText: "ACME\nTOTAL 500" });
  });
  it("serializes scans and replaces a worker after a recognition failure", async () => {
    const ocr = await import("../apps/web/src/offline-ocr");
    await ocr.ensureOcrEngineCached(vi.fn());
    let release!: (result: unknown) => void;
    mocks.recognize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const first = ocr.runLocalOcr(input);
    const second = ocr.runLocalOcr(input);
    await vi.waitFor(() => expect(mocks.recognize).toHaveBeenCalledTimes(1));
    release({ data: { text: "FIRST", confidence: 100, blocks: [] } });
    await Promise.all([first, second]);
    mocks.recognize.mockRejectedValueOnce("bad image");
    await expect(ocr.runLocalOcr(input)).rejects.toThrow("bad image");
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
    await expect(ocr.runLocalOcr(input)).resolves.toMatchObject({ fullText: "ACME\nTOTAL 500" });
    expect(mocks.createWorker).toHaveBeenCalledTimes(2);
  });
});
