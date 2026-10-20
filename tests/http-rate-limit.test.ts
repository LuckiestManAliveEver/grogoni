import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";

describe("HTTP request throttling", () => {
  it("keeps workspace requests out of the auth bucket and returns 429 for exhausted auth requests", async () => {
    const app = buildApi({ webRoot: false });
    app.log.level = "silent";
    try {
      for (let count = 0; count < 65; count++)
        await app.inject({ method: "GET", url: "/public/storefronts" });
      for (let count = 0; count < 60; count++) {
        const response = await app.inject({ method: "GET", url: "/auth/bootstrap" });
        expect(response.statusCode).toBe(401);
      }
      const limited = await app.inject({ method: "GET", url: "/auth/bootstrap" });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: "rate_limited" });
      expect((await app.inject({ method: "GET", url: "/public/storefronts" })).statusCode).toBe(
        200
      );
    } finally {
      await app.close();
    }
  });
});
