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

const checkpoint = (version: number | null, id = `v${version}`): RuntimeHandoff =>
  ({ id, taskId: "task", parentHandoffId: null, checkpointVersion: version }) as RuntimeHandoff;
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
    const pruned = prunableRuntimeCheckpoints({
      handoffs: chain(1, 30),
      head: head("v30", 31),
      instance: undefined,
      transfers: []
    });
    expect(pruned).toEqual(chain(1, 10).map((handoff) => handoff.id));
  });

  it("never prunes what resume, the drift check, a transfer or an offline sync reads", () => {
    const pruned = prunableRuntimeCheckpoints({
      handoffs: [...chain(1, 40), checkpoint(null, "offline")],
      // Rolled back to version 3: the head is old but kept.
      head: head("v3", 41),
      instance: { taskId: "task", activeHandoffId: "v4" } as RuntimeTaskInstance,
      transfers: [
        { taskId: "task", sourceHandoffId: "v5", checkpointId: "v6" } as RuntimeTransfer,
        { taskId: "task", sourceHandoffId: "v7", checkpointId: null } as RuntimeTransfer
      ]
    });
    expect(pruned).not.toContain("offline");
    for (const kept of ["v3", "v4", "v5", "v6", "v7"]) expect(pruned).not.toContain(kept);
    expect(pruned).toEqual(["v1", "v2", ...chain(8, 20).map((handoff) => handoff.id)]);
  });

  it("prunes nothing for a task without a head, and at most one batch per write", () => {
    expect(
      prunableRuntimeCheckpoints({
        handoffs: chain(1, 50),
        head: undefined,
        instance: undefined,
        transfers: []
      })
    ).toEqual([]);
    const pruned = prunableRuntimeCheckpoints({
      handoffs: chain(1, 500).reverse(),
      head: head("v500", 501),
      instance: undefined,
      transfers: []
    });
    expect(pruned).toHaveLength(runtimeCheckpointPruneBatch);
    expect(pruned[0]).toBe("v1");
    expect(pruned.at(-1)).toBe(`v${runtimeCheckpointPruneBatch}`);
  });
});
