import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";

describe("API response privacy", () => {
  it("does not permit shared or browser caches to retain JSON responses or errors", async () => {
    const app = buildApi({ webRoot: false });
    try {
      for (const url of [
        "/health",
        "/session",
        "/businesses/unknown/products",
        "/missing-api-route"
      ]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers.pragma).toBe("no-cache");
      }
    } finally {
      await app.close();
    }
  });
});
