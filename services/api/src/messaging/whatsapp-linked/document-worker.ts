import { parentPort, workerData } from "node:worker_threads";
import { extractUploadedDocument } from "../../cp2/document-extraction.js";

// Reuse the established extractor. The parent bounds input, lifetime, output and JS heap.
const input = workerData as { filename: string; mimeType: string; bytes: Uint8Array };
try {
  const result = await extractUploadedDocument({
    fileName: input.filename,
    contentType: input.mimeType,
    contentBase64: Buffer.from(input.bytes).toString("base64")
  });
  parentPort?.postMessage({ text: result.text.slice(0, 12000) });
} catch {
  parentPort?.postMessage({ error: true });
}
