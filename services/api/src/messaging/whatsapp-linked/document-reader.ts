import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { linkedMediaMaxBytes } from "./media.js";

/** This is a resource boundary, not an OS security sandbox. No model or credential environment
 * is inherited. It never renders PDF images, executes documents or follows embedded links.
 */
let active = false;
export async function readLinkedDocument(
  input: { filename: string; mimeType: string; bytes: Buffer },
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  if (
    input.mimeType !== "application/pdf" ||
    !input.bytes.length ||
    input.bytes.length > linkedMediaMaxBytes
  )
    throw new Error("Unsupported document.");
  if (active) throw new Error("Document extraction capacity is unavailable.");
  const compiled = new URL("./document-worker.js", import.meta.url);
  const isCompiled = existsSync(compiled);
  const source = new URL("./document-worker.ts", import.meta.url);
  // Source checkouts use the existing development TS loader; release builds use emitted JS.
  const worker = new Worker(
    isCompiled
      ? compiled
      : `import("tsx/esm/api").then(({ tsImport }) => tsImport(${JSON.stringify(source.href)}, ${JSON.stringify(import.meta.url)}))`,
    {
      ...(isCompiled ? {} : { eval: true }),
      workerData: { ...input, bytes: Uint8Array.from(input.bytes) },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
    }
  );
  active = true;
  worker.stdout.on("data", () => undefined);
  worker.stderr.on("data", () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const failed = () => reject(new Error("Document extraction is unavailable."));
      worker.once("error", failed);
      worker.once("exit", failed);
      worker.once("message", (result: { text?: unknown }) => {
        if (typeof result.text === "string" && result.text.trim() && result.text.length <= 12000)
          resolve(result.text);
        else failed();
      });
      // Release builds load compiled JS: 15 seconds bounds the extraction itself. A source
      // checkout first compiles the extractor graph through tsx inside the worker (7-8 seconds
      // alone, far more under a parallel test run), so it gets a startup allowance on top.
      timer = setTimeout(failed, isCompiled ? 15_000 : 60_000);
      abort = () => reject(new Error("Document extraction was cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    try {
      await worker.terminate();
    } finally {
      active = false;
    }
  }
}
