import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  activeDaemonTaskStatuses,
  canTransitionDaemonTask,
  daemonTaskTransitions,
  isActiveDaemonTaskStatus,
  terminalDaemonTaskStatuses,
  type DaemonTaskStatus
} from "@grogoni/shared-types";

const statuses = Object.keys(daemonTaskTransitions) as DaemonTaskStatus[];

describe("daemon task lifecycle", () => {
  it("splits every status into exactly one of active or terminal", () => {
    expect([...activeDaemonTaskStatuses, ...terminalDaemonTaskStatuses].sort()).toEqual(
      [...statuses].sort()
    );
    for (const status of statuses)
      expect(isActiveDaemonTaskStatus(status)).toBe(
        (activeDaemonTaskStatuses as readonly string[]).includes(status)
      );
  });

  it("keeps completed final and every terminal task recoverable only through queued", () => {
    expect(daemonTaskTransitions.completed).toEqual([]);
    for (const status of terminalDaemonTaskStatuses)
      for (const to of daemonTaskTransitions[status]) expect(to).toBe("queued");
    expect(canTransitionDaemonTask("queued", "completed")).toBe(false);
    expect(canTransitionDaemonTask("running", "completed")).toBe(true);
  });

  it("only writes statuses along declared edges in the Postgres queue store", async () => {
    const source = await readFile(new URL("./task-store.ts", import.meta.url), "utf8");
    // Every literal `set status='to'` update, with the `status` guards of its where clause.
    const updates = [...source.matchAll(/set status='(\w+)'([\s\S]*?)`/g)];
    expect(updates.length).toBeGreaterThanOrEqual(6);
    for (const [statement, to, rest = ""] of updates) {
      const where = rest.slice(rest.indexOf("where"));
      const from = new Set<string>();
      for (const match of where.matchAll(/status in \(([^)]*)\)/g))
        for (const value of (match[1] ?? "").matchAll(/'(\w+)'/g)) from.add(value[1] ?? "");
      for (const match of where.matchAll(/status='(\w+)'/g)) from.add(match[1] ?? "");
      // The claim CTE interpolates its status guard (queued, or running with an expired lease).
      if (from.size === 0) {
        expect(statement).toContain("from candidate");
        from.add("queued").add("running");
      }
      for (const status of from)
        expect(
          canTransitionDaemonTask(status as DaemonTaskStatus, to as DaemonTaskStatus) ||
            // running → running is a lease re-claim after expiry, not a status change.
            (status === to && to === "running"),
          `${status} → ${to}`
        ).toBe(true);
    }
  });
});
