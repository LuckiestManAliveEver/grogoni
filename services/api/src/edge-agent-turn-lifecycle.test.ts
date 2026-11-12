import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  agentTurnTransitions,
  canTransitionAgentTurn,
  isUnfinishedAgentTurn,
  unfinishedAgentTurnStatuses,
  type AgentTurnStatus
} from "./edge-agent-turns.js";

const statuses = Object.keys(agentTurnTransitions) as AgentTurnStatus[];

describe("agent turn lifecycle", () => {
  it("names every status, and only pending and running as unfinished", () => {
    expect(statuses.sort()).toEqual(["completed", "failed", "pending", "running"]);
    expect(statuses.filter(isUnfinishedAgentTurn).sort()).toEqual(
      [...unfinishedAgentTurnStatuses].sort()
    );
  });

  it("lets a finished turn run again only through pending", () => {
    for (const status of statuses.filter((status) => !isUnfinishedAgentTurn(status)))
      expect(agentTurnTransitions[status]).not.toContain("running");
    expect(canTransitionAgentTurn("completed", "failed")).toBe(false);
    expect(canTransitionAgentTurn("running", "pending")).toBe(false);
  });

  it("only writes statuses along declared edges in the turn store", async () => {
    const source = await readFile(new URL("./edge-agent-turns.ts", import.meta.url), "utf8");
    // Every SQL statement that sets a literal status, with the status guards of its own row.
    const updates = [...source.matchAll(/set\s+status\s*=\s*'(\w+)'([\s\S]*?)`/g)];
    expect(updates.length).toBeGreaterThanOrEqual(7);
    for (const [statement, to, rest = ""] of updates) {
      // Guards on earlier turns of the conversation (`not exists (...)`) are not this row's.
      const own = rest.slice(rest.indexOf("where")).split("not exists")[0] ?? "";
      const from = new Set<string>();
      for (const match of own.matchAll(/status in \(([^)]*)\)/g))
        for (const value of (match[1] ?? "").matchAll(/'(\w+)'/g)) from.add(value[1] ?? "");
      for (const match of own.matchAll(/status\s*=\s*'(\w+)'/g)) from.add(match[1] ?? "");
      expect(from.size, statement).toBeGreaterThan(0);
      for (const status of from)
        expect(
          canTransitionAgentTurn(status as AgentTurnStatus, to as AgentTurnStatus) ||
            // running → running is a lease re-claim after expiry, not a status change.
            (status === to && to === "running"),
          `${status} → ${to}`
        ).toBe(true);
    }
  });
});
