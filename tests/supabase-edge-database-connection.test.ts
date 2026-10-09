import { describe, expect, it, vi } from "vitest";
import { connectDatabase } from "../supabase/functions/api/database-connection";

describe("Edge database connection establishment", () => {
  it("retries a transient connection failure with a fresh client", async () => {
    const failed = {
      connect: vi.fn().mockRejectedValue(new Error("connection timeout")),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const connected = { connect: vi.fn().mockResolvedValue(undefined), end: vi.fn() };
    const create = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(connected);
    expect(await connectDatabase(create)).toBe(connected);
    expect(failed.end).toHaveBeenCalledOnce();
    expect(connected.end).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
  });
  it("does not retry authentication failures", async () => {
    const error = Object.assign(new Error("authentication failed"), { code: "28P01" });
    const create = vi.fn(() => ({
      connect: vi.fn().mockRejectedValue(error),
      end: vi.fn().mockResolvedValue(undefined)
    }));
    await expect(connectDatabase(create)).rejects.toBe(error);
    expect(create).toHaveBeenCalledOnce();
  });
  it("stops after two attempts", async () => {
    const create = vi.fn(() => ({
      connect: vi.fn().mockRejectedValue(new Error("timeout")),
      end: vi.fn().mockResolvedValue(undefined)
    }));
    await expect(connectDatabase(create)).rejects.toThrow("timeout");
    expect(create).toHaveBeenCalledTimes(2);
  });
});
