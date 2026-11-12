import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Android App Links certificate generation", () => {
  const placeholder =
    "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
  for (const fingerprint of ["", "invalid", placeholder, "ab:".repeat(31) + "cd"]) {
    it(`handles ${fingerprint || "missing certificate"} without fabricating trust`, () => {
      const root = mkdtempSync(join(tmpdir(), "android-assetlinks-"));
      try {
        mkdirSync(join(root, "scripts"));
        const script = join(root, "scripts/generate-android-assetlinks.mjs");
        copyFileSync("scripts/generate-android-assetlinks.mjs", script);
        const result = spawnSync(process.execPath, [script], {
          encoding: "utf8",
          env: {
            ...process.env,
            GROGONI_RELEASE_CERT_SHA256: fingerprint,
            GROGONI_RELEASE_STORE_FILE: ""
          }
        });
        if (fingerprint.startsWith("ab:")) {
          expect(result.status, result.stderr).toBe(0);
          const links = JSON.parse(
            readFileSync(join(root, "apps/web/public/.well-known/assetlinks.json"), "utf8")
          );
          expect(links[0].target.sha256_cert_fingerprints).toEqual([fingerprint.toUpperCase()]);
        } else {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toMatch(/Provide GROGONI_RELEASE_CERT_SHA256|real colon-separated/);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
