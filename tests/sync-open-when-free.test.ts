import { describe, expect, it, vi } from "vitest";
import { SyncDatabaseBlockedError } from "../apps/web/src/sync/indexeddb-repository";
import {
  blockedRetryDelaysMs,
  openSyncRepositoryWhenFree
} from "../apps/web/src/sync/open-when-free";

// An older Grogoni tab holding the device database blocked this tab's upgrade, and one failed
// open turned sync off for the rest of the session. It now retries until that tab lets go.
const repository = () => ({ close: vi.fn() });

describe("opening the sync database while another tab blocks it", () => {
  it("retries with backoff until the blocking tab closes, telling the person once", async () => {
    const opened = repository();
    const open = vi
      .fn<() => Promise<ReturnType<typeof repository>>>()
      .mockRejectedValueOnce(new SyncDatabaseBlockedError())
      .mockRejectedValueOnce(new SyncDatabaseBlockedError())
      .mockRejectedValueOnce(new SyncDatabaseBlockedError())
      .mockResolvedValueOnce(opened);
    const waits: number[] = [];
    const onBlocked = vi.fn();

    const result = await openSyncRepositoryWhenFree({
      open,
      isCancelled: () => false,
      onBlocked,
      wait: async (ms) => {
        waits.push(ms);
      }
    });

    expect(result).toBe(opened);
    expect(open).toHaveBeenCalledTimes(4);
    expect(waits).toEqual(blockedRetryDelaysMs.slice(0, 3));
    expect(onBlocked).toHaveBeenCalledOnce();
  });

  it("keeps waiting at the longest delay instead of giving up", async () => {
    const open = vi.fn(async () => {
      throw new SyncDatabaseBlockedError();
    });
    const waits: number[] = [];
    let cancelled = false;
    await openSyncRepositoryWhenFree({
      open,
      isCancelled: () => cancelled,
      wait: async (ms) => {
        waits.push(ms);
        if (waits.length === 8) cancelled = true;
      }
    });
    expect(waits.slice(-3)).toEqual([60_000, 60_000, 60_000]);
  });

  it("does not retry a failure that is not a blocked upgrade", async () => {
    const open = vi.fn(async () => {
      throw new Error("IndexedDB is unavailable in this runtime.");
    });
    await expect(
      openSyncRepositoryWhenFree({ open, isCancelled: () => false, wait: async () => undefined })
    ).rejects.toThrow(/unavailable/u);
    expect(open).toHaveBeenCalledOnce();
  });

  it("closes an open that lands after the page stopped wanting it", async () => {
    const opened = repository();
    let cancelled = false;
    const result = await openSyncRepositoryWhenFree({
      open: async () => {
        cancelled = true;
        return opened;
      },
      isCancelled: () => cancelled
    });
    expect(result).toBeNull();
    expect(opened.close).toHaveBeenCalledOnce();
  });

  it("stops retrying once cancelled", async () => {
    const open = vi.fn(async () => {
      throw new SyncDatabaseBlockedError();
    });
    let cancelled = false;
    const result = await openSyncRepositoryWhenFree({
      open,
      isCancelled: () => cancelled,
      wait: async () => {
        cancelled = true;
      }
    });
    expect(result).toBeNull();
    expect(open).toHaveBeenCalledOnce();
  });
});
