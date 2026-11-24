import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The weekly paid eval of agent replies across the send/turn split stays off until configured,
// gives the OpenRouter key only to the step that calls the model, and runs on a throwaway
// database, never production.
const workflow = readFileSync(".github/workflows/agent-eval.yml", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

describe("agent turn split eval workflow", () => {
  it("runs weekly only when enabled, or on a manual dispatch", () => {
    expect(workflow).toContain('- cron: "17 5 * * 1"');
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' || vars.AGENT_TURN_EVAL_ENABLED == 'true'"
    );
  });

  it("gives the model key to the eval steps only, against the job's own PostgreSQL", () => {
    const secretAt = workflow.indexOf("secrets.OPENROUTER_API_KEY");
    expect(workflow.indexOf("secrets.")).toBe(secretAt);
    // Every secret reference is the model key, on an eval step.
    expect(workflow.match(/secrets\.[A-Z_]+/gu)).toEqual([
      "secrets.OPENROUTER_API_KEY",
      "secrets.OPENROUTER_API_KEY"
    ]);
    expect(secretAt).toBeGreaterThan(workflow.indexOf("pnpm install"));
    expect(secretAt).toBeGreaterThan(workflow.indexOf("pnpm db:migrate"));
    expect(workflow).toContain(
      "EVAL_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/grogoni_eval"
    );
    expect(workflow).not.toMatch(/PRODUCTION_DATABASE_URL|neon\.tech/u);
    expect(workflow).toContain("permissions:\n  contents: read");
  });

  it("runs the eval script that exists", () => {
    expect(workflow).toContain("pnpm eval:agent-turn-split");
    expect(pkg.scripts["eval:agent-turn-split"]).toContain("scripts/eval-agent-turn-split.ts");
    expect(workflow).toContain("pnpm eval:receipt-reading");
    expect(pkg.scripts["eval:receipt-reading"]).toContain("scripts/eval-receipt-reading.ts");
  });
});
