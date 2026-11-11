import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";

afterEach(() => vi.unstubAllEnvs());
describe("HTTPS security headers", () => {
  it("publishes a year-long HSTS policy for every production hosting route", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8"));
    const global = config.headers.find((entry: { source: string }) => entry.source === "/(.*)");
    expect(global.headers).toContainEqual({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains"
    });
  });
  it("sends HSTS on API responses in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const name of [
      "OTP_HMAC_SECRET",
      "AUTH_AUDIT_HMAC_SECRET",
      "AUTH_TOKEN_ENCRYPTION_KEY",
      "PIN_HASH_SECRET",
      "PASSWORD_HASH_SECRET"
    ])
      vi.stubEnv(name, randomBytes(32).toString("hex"));
    vi.stubEnv("WEBAUTHN_RP_ID", "grogoni.com");
    vi.stubEnv("WEBAUTHN_EXPECTED_ORIGINS", "https://grogoni.com");
    const app = buildApi({ webRoot: false });
    try {
      const response = await app.inject({ url: "/health" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["strict-transport-security"]).toBe(
        "max-age=31536000; includeSubDomains"
      );
    } finally {
      await app.close();
    }
  });
  it("does not set a persistent HTTPS policy on local development responses", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const app = buildApi({ webRoot: false });
    try {
      expect(
        (await app.inject({ url: "/health" })).headers["strict-transport-security"]
      ).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
