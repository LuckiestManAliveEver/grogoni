import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { URL } from "node:url";
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const { build } = viteRequire("esbuild");
const apiRequire = createRequire(
  fileURLToPath(new URL("../services/api/package.json", import.meta.url))
);
const pdfRequire = createRequire(apiRequire.resolve("pdf-parse"));
const pdfBrowserEntry = fileURLToPath(
  new URL("../web/pdf-parse.es.js", pathToFileURL(apiRequire.resolve("pdf-parse")))
);
const externalPackages = new Map([
  ["fastify", "npm:fastify@5.9.0"],
  ["@simplewebauthn/server", "npm:@simplewebauthn/server@13.3.2"],
  ["@fastify/websocket", "npm:@fastify/websocket@11.3.0"],
  ["pg", "npm:pg@8.22.0"],
  ["mammoth", "npm:mammoth@1.12.0"],
  ["libphonenumber-js", "npm:libphonenumber-js@1.13.9"],
  ["libphonenumber-js/max", "npm:libphonenumber-js@1.13.9/max"]
]);
await build({
  entryPoints: [
    fileURLToPath(new URL("../services/api/src/edge-domain-routes.ts", import.meta.url))
  ],
  outfile: fileURLToPath(new URL("../supabase/functions/api/domain-bundle.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  minify: true,
  banner: {
    js: 'import { WorkerMessageHandler as EdgePdfWorker } from "./pdf-worker.mjs"; import { createRequire as edgeCreateRequire } from "node:module"; import EdgeDOMMatrix from "npm:@thednp/dommatrix@2.0.12"; import edgeProcess from "node:process"; import { Buffer as EdgeBuffer } from "node:buffer"; import { setImmediate as edgeSetImmediate, clearImmediate as edgeClearImmediate } from "node:timers"; globalThis.pdfjsWorker = { WorkerMessageHandler: EdgePdfWorker }; globalThis.global ??= globalThis; globalThis.DOMMatrix ??= EdgeDOMMatrix; globalThis.process ??= edgeProcess; globalThis.Buffer ??= EdgeBuffer; globalThis.setImmediate ??= edgeSetImmediate; globalThis.clearImmediate ??= edgeClearImmediate; globalThis.__edgePdfWorkerUrl = new URL("./pdf-worker.mjs", import.meta.url).href; const require = edgeCreateRequire(import.meta.url);'
  },
  plugins: [
    {
      name: "deno-npm-dependencies",
      setup(builder) {
        builder.onResolve(
          {
            filter:
              /^(@simplewebauthn\/server|fastify|@fastify\/websocket|pg|mammoth|pdf-parse|libphonenumber-js(?:\/max)?)$/
          },
          (args) => ({
            // Avoid shipping native canvas binaries to Edge for PDF text extraction.
            path: args.path === "pdf-parse" ? pdfBrowserEntry : externalPackages.get(args.path),
            external: args.path !== "pdf-parse"
          })
        );
      }
    }
  ],
  logLevel: "info"
});
await build({
  entryPoints: [pdfRequire.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")],
  outfile: fileURLToPath(new URL("../supabase/functions/api/pdf-worker.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  minify: true,
  logLevel: "info"
});
