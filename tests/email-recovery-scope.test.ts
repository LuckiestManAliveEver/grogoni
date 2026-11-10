import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { createEdgeSnapshotScope } from "../services/api/src/cp2/edge-snapshot-scope";

describe("recovery target selection", () => {
  it.each(["start", "verify", "reset-password", "device-approval/status"])(
    "ignores an unrelated cookie and bearer token for %s",
    async (suffix) => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      const path = `/auth/recovery/${suffix}`;
      const body = Buffer.from(JSON.stringify({ type: "email", identifier: "owner@example.test" }));
      await createEdgeSnapshotScope(
        { query } as unknown as PoolClient,
        new Request(`https://grogoni.com/api${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: "grogoni_session=12345678-1234-4234-8234-123456789abc",
            authorization: "Bearer unrelated-account-token"
          },
          body
        }),
        path,
        body
      );
      const parameters = query.mock.calls[0]![1] as unknown[];
      expect(parameters[0]).toBeNull();
      expect(parameters[1]).toBe(createHash("sha256").update("").digest("hex"));
      if (suffix === "start") expect(parameters[5]).toBe("owner@example.test");
    }
  );
});
