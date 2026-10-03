import { createWorker, OEM, type Worker } from "tesseract.js";
import {
  cacheArtifactsByUrl,
  assertStorage,
  type Artifact,
  type ReceiptOcrExtraction
} from "@grogoni/offline-runtime";

import {
  ocrAssetFiles,
  ocrEngineVersion as engineVersion,
  ocrModelVersion as modelVersion,
  ocrManifestVersion
} from "./offline-ocr-assets";

/**
 * On-device OCR, shared by receipt scanning and camera product capture
 * (packages/offline-runtime's LocalProvider calls into this as its injected `ocr` callback for
 * both `receipts.ocr.create` and `productCaptures.ocr.create`, the same pattern apps/web already
 * uses to inject agent/model inference). Runs entirely in-browser via tesseract.js/WASM so a photo
 * can be scanned with no connection at all; everything the server alone can do (receipt
 * supplier/sales-agent matching, the authoritative re-parse of a captured product's fields) still
 * happens once the capture syncs, matching what apps/web/src/OfflineRuntimeSettings.tsx discloses.
 */
const cacheName = "grogoni-ocr-engine-v1";
const enginePath = "/tesseract";
const manifestUrl = `${enginePath}/manifest.json`;

let workerPromise: Promise<Worker> | null = null;
let scanQueue: Promise<unknown> = Promise.resolve();
let installation: Promise<void> | null = null;

function parseManifest(value: unknown): Artifact[] {
  const manifest = value as { version?: unknown; artifacts?: unknown } | null;
  const artifacts = manifest?.artifacts;
  if (
    manifest?.version !== ocrManifestVersion ||
    !Array.isArray(artifacts) ||
    artifacts.length !== ocrAssetFiles.length ||
    ocrAssetFiles.some(
      (file) => artifacts.filter((item) => item?.url === `${enginePath}/${file}`).length !== 1
    ) ||
    artifacts.some(
      (item) =>
        !Number.isSafeInteger(item.bytes) ||
        item.bytes <= 0 ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/i.test(item.sha256)
    )
  )
    throw new Error(
      "Invalid or outdated offline receipt scanner manifest. Enable scanning again from Settings."
    );
  return artifacts as Artifact[];
}
function requireServiceWorker(): void {
  if (!navigator.serviceWorker?.controller)
    throw new Error("Reload Grogoni once to activate offline support, then try again.");
}

/** Reads the manifest already saved locally by ensureOcrEngineCached - never touches the network,
 * so checking whether offline OCR is ready never counts as the "silent network activity" that
 * explicit offline mode must avoid. */
async function readCachedManifest(): Promise<Artifact[] | null> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(manifestUrl);
  if (!cached) return null;
  return parseManifest(await cached.json());
}

export function ensureOcrEngineCached(
  progress: (done: number, total: number) => void
): Promise<void> {
  installation ??= installEngine(progress).finally(() => {
    installation = null;
  });
  return installation;
}
async function installEngine(progress: (done: number, total: number) => void): Promise<void> {
  requireServiceWorker();
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) throw new Error("The offline receipt scanner manifest is unavailable.");
  const bytes = await response.arrayBuffer();
  const artifacts = parseManifest(JSON.parse(new TextDecoder().decode(bytes)));
  assertStorage(
    await navigator.storage.estimate(),
    artifacts.reduce((sum, item) => sum + item.bytes, 0) * 2
  );
  const cache = await caches.open(cacheName);
  // An interrupted upgrade must never appear ready with a partially replaced engine.
  await cache.delete(manifestUrl);
  await cacheArtifactsByUrl(artifacts, cache, progress, (url, init) =>
    fetch(url, { ...init, cache: "no-store" })
  );
  await cache.put(
    manifestUrl,
    new Response(bytes, { headers: { "content-type": "application/json" } })
  );
}

export async function isOcrEngineCached(): Promise<boolean> {
  try {
    requireServiceWorker();
    const artifacts = await readCachedManifest();
    if (!artifacts) return false;
    const cache = await caches.open(cacheName);
    for (const artifact of artifacts) {
      const response = await cache.match(artifact.url);
      if (!response) return false;
      if (
        artifact.url.endsWith(".js") &&
        !response.headers.get("content-type")?.includes("javascript")
      )
        return false;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== artifact.bytes) return false;
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (hash !== artifact.sha256.toLowerCase()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function getOcrWorker(): Promise<Worker> {
  workerPromise ??= new Promise<Worker>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(error instanceof Error ? error.message : String(error)));
    };
    const timer = setTimeout(
      () => fail("The receipt scanner took too long to start. Try again."),
      60_000
    );
    void createWorker("eng", OEM.LSTM_ONLY, {
      workerPath: new URL(`${enginePath}/worker.min.js`, location.origin).href,
      corePath: new URL(`${enginePath}/`, location.origin).href,
      langPath: new URL(`${enginePath}/lang/`, location.origin).href,
      workerBlobURL: false,
      // Tesseract reports language-initialization failures here even when its
      // createWorker promise remains pending. Reject so the UI can recover.
      errorHandler: fail,
      gzip: true,
      cacheMethod: "none"
    }).then((worker) => {
      if (settled) {
        void worker.terminate();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(worker);
    }, fail);
  }).catch((error: unknown) => {
    workerPromise = null;
    throw error;
  });
  return workerPromise;
}

type OcrInput = {
  fileName: string;
  contentType: string;
  contentBase64: string;
};
export function runLocalOcr(input: OcrInput): Promise<ReceiptOcrExtraction> {
  // Tesseract shares mutable engine state; overlapping scans must run in order.
  const result = scanQueue.then(() => recognizeReceipt(input));
  scanQueue = result.catch(() => undefined);
  return result;
}
async function recognizeReceipt(input: OcrInput): Promise<ReceiptOcrExtraction> {
  if (!(await isOcrEngineCached()))
    throw new Error(
      "The on-device scanner is not installed on this device. Enable it from Settings."
    );
  const worker = await getOcrWorker();
  let result: Awaited<ReturnType<Worker["recognize"]>>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      worker.recognize(
        `data:${input.contentType};base64,${input.contentBase64}`,
        { rotateAuto: true },
        { text: true, blocks: true }
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Reading this photo took too long. Try a smaller, clearer photo.")),
          60_000
        );
      })
    ]);
  } catch (error) {
    workerPromise = null;
    await worker.terminate();
    throw new Error(
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Could not read this photo. Try a clearer JPEG or PNG."
    );
  } finally {
    clearTimeout(timer);
  }
  const { data } = result;
  let index = 0;
  const blocks = (data.blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) =>
      paragraph.lines.map((line) => ({
        id: `line-${index++}`,
        page: 0,
        text: line.text,
        confidence: line.confidence / 100,
        boundingBox: [
          { x: line.bbox.x0, y: line.bbox.y0 },
          { x: line.bbox.x1, y: line.bbox.y0 },
          { x: line.bbox.x1, y: line.bbox.y1 },
          { x: line.bbox.x0, y: line.bbox.y1 }
        ]
      }))
    )
  );
  return {
    engine: "tesseract",
    engineVersion,
    modelVersion,
    profile: "mobile",
    fallbackUsed: false,
    blocks,
    fullText: data.text,
    averageConfidence: data.confidence / 100,
    warnings: []
  };
}
