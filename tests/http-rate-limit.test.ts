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

  it("rejects concurrent overloads before they hit the expensive route layer", async () => {
    const app = buildApi({ webRoot: false, maxConcurrentRequests: 1 });
    app.get("/slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ok: true };
    });
    app.log.level = "silent";
    try {
      const first = app.inject({ method: "GET", url: "/slow" });
      const second = app.inject({ method: "GET", url: "/slow" });
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      const statuses = [firstResponse.statusCode, secondResponse.statusCode].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 503]);
    } finally {
      await app.close();
    }
  });

  it("does not release another request's slot when rejecting an overload", async () => {
    const app = buildApi({ webRoot: false, maxConcurrentRequests: 1 });
    app.log.level = "silent";
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.get("/held", async () => {
      started();
      await gate;
      return { ok: true };
    });
    app.get("/probe", async () => ({ ok: true }));
    const first = app
      .inject({ method: "GET", url: "/held", headers: { upgrade: "websocket" } })
      .then((response) => response);
    try {
      await entered;
      expect((await app.inject({ method: "GET", url: "/probe" })).statusCode).toBe(503);
      expect((await app.inject({ method: "GET", url: "/probe" })).statusCode).toBe(503);
      release();
      expect((await first).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/held" })).statusCode).toBe(200);
    } finally {
      release();
      await first;
      await app.close();
    }
  });
});
