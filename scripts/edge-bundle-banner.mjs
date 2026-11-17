// Code prepended to supabase/functions/api/domain-bundle.mjs. It runs in the
// Supabase Edge (Deno) isolate before any bundled module, so each snippet is a
// string. The snippets are exported separately so gate tests can execute them.

// Fastify is an npm: import, so Supabase resolves its light-my-request range
// (^6.0.0) at deploy time instead of using our lockfile. light-my-request 6.8.1
// (2026-11-14) returns early from Response#write unless Node's internal
// ServerResponse._hasBody is truthy. Node sets it in the OutgoingMessage
// constructor; Deno's node:http never does, so every injected domain response
// reached the client with an empty body. Restore Node's default of true on the
// prototype. A per-instance value (Node's false for HEAD/204/304) still wins,
// and edge-domain-routes drops HEAD/204/304 bodies when it builds the Response.
export const serverResponseBodyDefault =
  'if (!("_hasBody" in EdgeServerResponse.prototype)) EdgeServerResponse.prototype._hasBody = true;';

// Keep the matching minified worker local: importing its npm package pulls a
// 35 MB graph into the local Supabase bundle and exceeds the deployment limit.
export function pdfWorkerSpecifier(pdfjsVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(pdfjsVersion))
    throw new Error(`Unexpected pdfjs-dist version ${pdfjsVersion}.`);
  return "./pdf-worker.mjs";
}

export function pdfWorkerLoader(specifier) {
  return `globalThis.__edgeLoadPdfWorker = () => import("${specifier}");`;
}

export function edgeBundleBanner(pdfjsVersion) {
  return [
    'import { createRequire as edgeCreateRequire } from "node:module";',
    'import { ServerResponse as EdgeServerResponse } from "node:http";',
    'import EdgeDOMMatrix from "npm:@thednp/dommatrix@2.0.12";',
    'import edgeProcess from "node:process";',
    'import { Buffer as EdgeBuffer } from "node:buffer";',
    'import { setImmediate as edgeSetImmediate, clearImmediate as edgeClearImmediate } from "node:timers";',
    serverResponseBodyDefault,
    "globalThis.global ??= globalThis;",
    "globalThis.DOMMatrix ??= EdgeDOMMatrix;",
    "globalThis.process ??= edgeProcess;",
    "globalThis.Buffer ??= EdgeBuffer;",
    "globalThis.setImmediate ??= edgeSetImmediate;",
    "globalThis.clearImmediate ??= edgeClearImmediate;",
    pdfWorkerLoader(pdfWorkerSpecifier(pdfjsVersion)),
    "const require = edgeCreateRequire(import.meta.url);"
  ].join(" ");
}
