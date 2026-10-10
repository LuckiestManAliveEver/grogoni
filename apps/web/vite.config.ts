import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import webPackage from "./package.json";
import { ocrAssetFiles, ocrManifestVersion } from "./src/offline-ocr-assets";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The on-device receipt-OCR engine (tesseract.js). These are large, self-contained WASM/data
 * files fetched and cache-verified on demand (packages/offline-runtime's cacheArtifactsByUrl)
 * only when a user opts into offline OCR - never part of the mandatory app-shell precache, so they
 * are emitted under tesseract/ rather than assets/ and excluded from offline-manifest.json below.
 */
function tesseractOfflineAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const packageDir = (name: string) => dirname(require.resolve(`${name}/package.json`));
  const files = ocrAssetFiles.map((fileName) => ({
    fileName,
    source:
      fileName === "worker.min.js"
        ? join(packageDir("tesseract.js"), "dist", fileName)
        : fileName.startsWith("lang/")
          ? join(packageDir("@tesseract.js-data/eng"), "4.0.0_best_int/eng.traineddata.gz")
          : join(packageDir("tesseract.js-core"), fileName)
  }));
  const assets = () =>
    files.map(({ source, fileName }) => {
      const buffer = readFileSync(source);
      return {
        fileName,
        buffer,
        artifact: {
          url: `/tesseract/${fileName}`,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          bytes: buffer.byteLength
        }
      };
    });
  const manifest = (entries: ReturnType<typeof assets>) =>
    JSON.stringify({
      version: ocrManifestVersion,
      artifacts: entries.map((entry) => entry.artifact)
    });
  return {
    name: "tesseract-offline-assets",
    configureServer(server) {
      // Development must serve the same opt-in engine URLs as the production build.
      const entries = assets();
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0];
        if (path === "/tesseract/manifest.json") {
          res.setHeader("Content-Type", "application/json");
          res.end(manifest(entries));
          return;
        }
        const entry = entries.find((item) => item.artifact.url === path);
        if (!entry) {
          next();
          return;
        }
        res.setHeader(
          "Content-Type",
          entry.fileName.endsWith(".js") ? "application/javascript" : "application/octet-stream"
        );
        res.end(entry.buffer);
      });
    },
    generateBundle() {
      const entries = assets();
      for (const { fileName, buffer } of entries)
        this.emitFile({ type: "asset", fileName: `tesseract/${fileName}`, source: buffer });
      this.emitFile({
        type: "asset",
        fileName: "tesseract/manifest.json",
        source: manifest(entries)
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, "");
  const apiBase =
    process.env.VITE_API_BASE_URL ??
    env.VITE_API_BASE_URL ??
    process.env.VITE_API_URL ??
    env.VITE_API_URL;
  if (mode === "production" && !apiBase?.trim()) {
    throw new Error("Production builds require VITE_API_BASE_URL or VITE_API_URL.");
  }
  const usePolling =
    (process.env.VITE_USE_POLLING ?? env.VITE_USE_POLLING) === "true" ||
    process.env.CHOKIDAR_USEPOLLING === "true" ||
    process.env.WSL_DISTRO_NAME !== undefined ||
    existsSync("/.dockerenv");
  const debugUi = (process.env.DEBUG_UI ?? env.DEBUG_UI) === "true";
  const appVersion = process.env.VITE_APP_VERSION ?? env.VITE_APP_VERSION ?? webPackage.version;
  const gitCommitSha =
    process.env.VITE_GIT_COMMIT_SHA ??
    env.VITE_GIT_COMMIT_SHA ??
    process.env.RENDER_GIT_COMMIT ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    "local";
  const deploymentEnvironment =
    process.env.VITE_DEPLOYMENT_ENV ??
    env.VITE_DEPLOYMENT_ENV ??
    (process.env.RENDER === "true" ? "render" : mode);
  const buildTimestamp = new Date().toISOString();
  const stagingSecurityHeaders =
    deploymentEnvironment === "staging"
      ? {
          "Content-Security-Policy": [
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "script-src 'self' 'wasm-unsafe-eval' 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "manifest-src 'self'",
            "worker-src 'self' blob:",
            "child-src 'self' blob:",
            "connect-src 'self' http://127.0.0.1:4000 ws://127.0.0.1:5173 ws://localhost:5173 https://huggingface.co https://*.huggingface.co https://hf.co https://*.hf.co https://raw.githubusercontent.com"
          ].join("; "),
          "Cross-Origin-Embedder-Policy": "credentialless",
          "Cross-Origin-Opener-Policy": "same-origin"
        }
      : {};

  return {
    build: {
      manifest: true,
      rollupOptions: {
        output: {
          assetFileNames: "assets/[name]-[hash][extname]",
          chunkFileNames: "assets/[name]-[hash].js",
          entryFileNames: "assets/[name]-[hash].js"
        }
      }
    },
    define: {
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify(apiBase),
      "import.meta.env.VITE_API_URL": JSON.stringify(apiBase),
      __APP_NAME__: JSON.stringify("Grogoni"),
      __APP_VERSION__: JSON.stringify(appVersion),
      __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
      __DEPLOYMENT_ENV__: JSON.stringify(deploymentEnvironment),
      __DEBUG_UI__: JSON.stringify(debugUi),
      __GIT_COMMIT_SHA__: JSON.stringify(gitCommitSha)
    },
    envDir: workspaceRoot,
    plugins: [
      react(),
      tesseractOfflineAssets(),
      {
        // A lightweight, server-fetchable build identity (docs/architecture/
        // frontend-deployment-recovery.md). apps/web/src/lazy-module-recovery.ts fetches this
        // with `cache: "no-store"` - bypassing the service worker and HTTP caching - to tell
        // whether an already-open tab's compiled-in build id (__GIT_COMMIT_SHA__) still matches
        // what is actually deployed.
        name: "build-identity-manifest",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "build-meta.json",
            source: JSON.stringify({
              buildId: gitCommitSha,
              version: appVersion,
              builtAt: buildTimestamp,
              environment: deploymentEnvironment
            })
          });
        }
      },
      {
        name: "offline-shell-manifest",
        generateBundle(_options, bundle) {
          const entries = Object.entries(bundle).filter(([name]) => name.startsWith("assets/"));
          const bytes = entries.reduce(
            (sum, [, entry]) =>
              sum +
              (entry.type === "chunk"
                ? Buffer.byteLength(entry.code)
                : typeof entry.source === "string"
                  ? Buffer.byteLength(entry.source)
                  : entry.source.byteLength),
            0
          );
          this.emitFile({
            type: "asset",
            fileName: "offline-manifest.json",
            source: JSON.stringify({ files: entries.map(([name]) => name), bytes })
          });
        }
      }
    ],
    server: {
      headers: {
        "Cache-Control": "no-store",
        ...stagingSecurityHeaders
      },
      hmr: true,
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      watch: {
        ...(usePolling ? { interval: 100 } : {}),
        usePolling
      }
    }
  };
});
