import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { URL } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { checkEdgeUploadBudget, measureEdgeUpload } from "./edge-api-upload.mjs";
import { edgeBundleBanner } from "./edge-bundle-banner.mjs";
execFileSync(
  process.execPath,
  [fileURLToPath(new URL("./build-seed-catalogue.mjs", import.meta.url)), "--check"],
  { stdio: "inherit" }
);
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
const pdfjsVersion = JSON.parse(
  await readFile(pdfRequire.resolve("pdfjs-dist/package.json"), "utf8")
).version;
const banner = edgeBundleBanner(pdfjsVersion);
const externalPackages = new Map([
  // Loaded only by the linked-WhatsApp daemon; keep its protocol/native dependencies
  // out of the Edge upload, where the management API enforces a 5 MB limit.
  ["baileys", "npm:baileys@7.0.0-rc14"],
  ["fastify", "npm:fastify@5.9.0"],
  ["@simplewebauthn/server", "npm:@simplewebauthn/server@13.3.2"],
  ["@fastify/websocket", "npm:@fastify/websocket@11.3.0"],
  ["pg", "npm:pg@8.22.0"],
  ["mammoth", "npm:mammoth@1.12.0"],
  ["libphonenumber-js", "npm:libphonenumber-js@1.13.9"],
  ["libphonenumber-js/max", "npm:libphonenumber-js@1.13.9/max"],
  // Pure JS with no dependencies (so no floating transitive ranges), resolved by Supabase like the
  // packages above. Keeping its ~112 KB out of the upload gives the intermittent 413 more room.
  ["yaml", "npm:yaml@2.9.0"]
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
  banner: { js: banner },
  plugins: [
    {
      name: "deno-npm-dependencies",
      setup(builder) {
        builder.onResolve({ filter: /baileys-driver\.js$/ }, (args) => {
          const driver = fileURLToPath(
            new URL(
              "../services/api/src/messaging/whatsapp-linked/baileys-driver.js",
              import.meta.url
            )
          );
          if (resolve(dirname(args.importer), args.path) !== driver) return null;
          return {
            path: fileURLToPath(
              new URL(
                "../services/api/src/messaging/whatsapp-linked/edge-driver.ts",
                import.meta.url
              )
            )
          };
        });
        builder.onResolve(
          {
            filter:
              /^(baileys|@simplewebauthn\/server|fastify|@fastify\/websocket|pg|mammoth|pdf-parse|libphonenumber-js(?:\/max)?|yaml)$/
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
const domainBundle = await readFile(
  new URL("../supabase/functions/api/domain-bundle.mjs", import.meta.url),
  "utf8"
);
if (/npm:baileys@/.test(domainBundle))
  throw new Error("The Edge bundle must not include the Node-only WhatsApp socket driver.");
if (!domainBundle.startsWith(banner))
  throw new Error("The Edge bundle must start with the Edge runtime banner.");
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
const upload = checkEdgeUploadBudget(
  await measureEdgeUpload(fileURLToPath(new URL("../supabase/functions/api", import.meta.url)))
);
console.log(upload.message);
if (!upload.ok)
  throw new Error(
    `${upload.message} Externalize a dependency or shrink the bundle before deploying.`
  );
