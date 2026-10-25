import { describe, expect, it } from "vitest";
import type {
  RuntimeHandoff,
  RuntimeTaskHead,
  RuntimeTaskInstance,
  RuntimeTransfer
} from "@grogoni/shared-types";
import {
  prunableRuntimeCheckpoints,
  runtimeCheckpointPruneBatch,
  runtimeCheckpointRecentVersions
} from "../services/api/src/cp2/domains/runtime-handoff/checkpoint-retention";

const now = new Date("2026-10-24T12:00:00.000Z");
const old = "2026-08-01T00:00:00.000Z";
const checkpoint = (
  version: number | null,
  id = `v${version}`,
  extra: Partial<RuntimeHandoff> = {}
): RuntimeHandoff =>
  ({
    id,
    taskId: "task",
    parentHandoffId: version !== null && version > 1 ? `v${version - 1}` : null,
    mergedFromHandoffIds: [],
    checkpointVersion: version,
    createdAt: old,
    ...extra
  }) as RuntimeHandoff;
const chain = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_value, index) => checkpoint(from + index));
const head = (activeHandoffId: string, nextCheckpointVersion: number): RuntimeTaskHead => ({
  taskId: "task",
  activeHandoffId,
  nextCheckpointVersion,
  updatedAt: "2026-10-17T00:00:00.000Z"
});

describe("runtime checkpoint retention", () => {
  it("keeps the latest versions and prunes older ones, oldest first", () => {
    expect(runtimeCheckpointRecentVersions).toBe(20);
    const pruned = prunableRuntimeCheckpoints(
      {
        handoffs: chain(1, 30),
        head: head("v30", 31),
        instance: undefined,
        transfers: []
      },
      now
    );
    expect(pruned).toEqual(chain(1, 10).map((handoff) => handoff.id));
  });

  it("never prunes what resume, the drift check, a transfer or an offline sync reads", () => {
    const pruned = prunableRuntimeCheckpoints(
      {
        handoffs: [...chain(1, 40), checkpoint(null, "offline")],
        // Rolled back to version 3: the head is old but kept.
        head: head("v3", 41),
        instance: { taskId: "task", activeHandoffId: "v4" } as RuntimeTaskInstance,
        transfers: [
          { taskId: "task", sourceHandoffId: "v5", checkpointId: "v6" } as RuntimeTransfer,
          { taskId: "task", sourceHandoffId: "v7", checkpointId: null } as RuntimeTransfer
        ]
      },
      now
    );
    expect(pruned).not.toContain("offline");
    for (const kept of ["v3", "v4", "v5", "v6", "v7"]) expect(pruned).not.toContain(kept);
    expect(pruned).toEqual(["v1", "v2", ...chain(8, 20).map((handoff) => handoff.id)]);
  });

  it("prunes nothing for a task without a head, and at most one batch per write", () => {
    expect(
      prunableRuntimeCheckpoints(
        {
          handoffs: chain(1, 50),
          head: undefined,
          instance: undefined,
          transfers: []
        },
        now
      )
    ).toEqual([]);
    const pruned = prunableRuntimeCheckpoints(
      {
        handoffs: chain(1, 500).reverse(),
        head: head("v500", 501),
        instance: undefined,
        transfers: []
      },
      now
    );
    expect(pruned).toHaveLength(runtimeCheckpointPruneBatch);
    expect(pruned[0]).toBe("v1");
    expect(pruned.at(-1)).toBe(`v${runtimeCheckpointPruneBatch}`);
  });

  it("keeps an unmerged branch, a synced batch and their parents for 30 days, then prunes them", () => {
    const recent = "2026-10-20T00:00:00.000Z";
    const handoffs = [
      ...chain(1, 40),
      // A branch from version 5 nobody merged (made recently, nothing descends from it).
      checkpoint(41, "tip", { parentHandoffId: "v5", createdAt: recent }),
      // A batch synced recently from version 8, made offline long ago.
      checkpoint(42, "synced-1", { parentHandoffId: "v8", branchedAt: recent }),
      checkpoint(43, "synced-2", { parentHandoffId: "synced-1", branchedAt: recent }),
      // An old branch nobody merged: past 30 days.
      checkpoint(44, "old-tip", { parentHandoffId: "v9" })
    ];
    const input = {
      handoffs,
      head: head("v40", 70),
      instance: undefined,
      transfers: []
    };
    const pruned = prunableRuntimeCheckpoints(input, now);
    for (const kept of ["tip", "synced-1", "synced-2", "v8"]) expect(pruned).not.toContain(kept);
    expect(pruned).toContain("old-tip");
    expect(pruned).toContain("v5");
    // 31 days later they are history like the rest (all are older than the latest 20 versions).
    const later = prunableRuntimeCheckpoints(input, new Date("2026-11-21T00:00:00.000Z"));
    for (const id of ["tip", "synced-1", "v8"]) expect(later).toContain(id);
    // The latest of the synced batch is a tip made offline long ago, but synced recently.
    expect(pruned).not.toContain("synced-2");
  });
});
