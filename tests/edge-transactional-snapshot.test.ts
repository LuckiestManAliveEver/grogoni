import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { loadTransactionalCp2Snapshot } from "../services/api/src/cp2/postgres-store";

describe("Edge transactional snapshot loading", () => {
  it("batches relational reads on the caller's transaction connection", async () => {
    const query = vi.fn(async (sql: string) => {
      const results = sql.split(";\n").map(() => ({ rows: [], rowCount: 0 }));
      return results.length === 1 ? results[0] : results;
    });
    const snapshot = await loadTransactionalCp2Snapshot({ query } as unknown as PoolClient);
    expect(snapshot.accounts).toEqual([]);
    expect(snapshot.businesses).toEqual([]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]![0]).toContain("from accounts");
    expect(query.mock.calls[1]![0]).toContain("from business_memberships");
  });

  it("rejects the whole load if a batched query fails", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("unavailable"));
    await expect(loadTransactionalCp2Snapshot({ query } as unknown as PoolClient)).rejects.toThrow(
      "unavailable"
    );
  });
});
