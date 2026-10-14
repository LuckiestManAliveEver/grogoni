import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { guardPgPoolErrors } from "../services/api/src/pg-pool-errors";

describe("PostgreSQL client error handling", () => {
  it("handles fatal client errors between checked-out transaction statements without replay", () => {
    const pool = new EventEmitter();
    const client = new EventEmitter();
    const report = vi.fn();
    guardPgPoolErrors(pool as Pool, report);
    pool.emit("connect", client);
    const error = new Error("Connection terminated");
    expect(() => client.emit("error", error)).not.toThrow();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(error);
    expect(client.listenerCount("error")).toBe(1);
    expect(client.listenerCount("query")).toBe(0);
  });
  it("keeps the pool-level idle connection error handler", () => {
    const pool = new EventEmitter();
    const report = vi.fn();
    guardPgPoolErrors(pool as Pool, report);
    const error = new Error("Idle connection terminated");
    expect(() => pool.emit("error", error)).not.toThrow();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(error);
  });
});
