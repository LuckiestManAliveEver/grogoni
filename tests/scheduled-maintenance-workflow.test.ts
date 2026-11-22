import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The production jobs that ran as Render cron services moved to
// .github/workflows/scheduled-maintenance.yml when Render was retired. Each must keep its
// schedule and command, read its secrets from GitHub, and stay behind its repository-variable
// gate so a fork or an unconfigured repository never touches production.
const workflow = readFileSync(".github/workflows/scheduled-maintenance.yml", "utf8");

function jobSection(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name} is missing`).toBeGreaterThan(-1);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

const jobs = [
  { name: "shop-purge", cron: "37 3 * * *", gate: "SHOP_PURGE_ENABLED", run: "db:purge-shops" },
  {
    name: "account-purge",
    cron: "7 4 * * *",
    gate: "ACCOUNT_PURGE_ENABLED",
    run: "db:purge-accounts"
  },
  { name: "db-health", cron: "*/30 * * * *", gate: "DB_HEALTH_ENABLED", run: "db:health" }
] as const;

describe("scheduled database maintenance (formerly Render crons)", () => {
  it("has no Render blueprint left to run them a second way", () => {
    expect(existsSync("render.yaml")).toBe(false);
  });

  it.each(jobs)("$name keeps its schedule, command and gate", ({ name, cron, gate, run }) => {
    const job = jobSection(name);
    expect(workflow).toContain(`- cron: "${cron}"`);
    expect(job).toContain(`run: pnpm ${run}`);
    // Scheduled runs need both the matching cron and the opt-in variable; manual runs name the job.
    expect(job).toContain(`github.event.schedule == '${cron}' && vars.${gate} == 'true'`);
    expect(job).toContain(`github.event_name == 'workflow_dispatch' && inputs.job == '${name}'`);
  });

  it("builds the API before purges that import its dist output", () => {
    for (const name of ["shop-purge", "account-purge"]) {
      const job = jobSection(name);
      expect(job.indexOf("pnpm --filter @grogoni/api... build")).toBeGreaterThan(-1);
      expect(job.indexOf("pnpm --filter @grogoni/api... build")).toBeLessThan(
        job.indexOf("run: pnpm db:purge")
      );
    }
  });

  it("reads production credentials only from GitHub secrets", () => {
    expect(workflow).toContain("DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }}");
    expect(workflow).toContain(
      "DIRECT_DATABASE_URL: ${{ secrets.PRODUCTION_DIRECT_DATABASE_URL }}"
    );
    expect(jobSection("account-purge")).toContain(
      "ACCOUNT_DELETION_PROCESSORS_JSON: ${{ secrets.ACCOUNT_DELETION_PROCESSORS_JSON }}"
    );
    // The production processor is {"id":"brevo","type":"brevo"}, which calls Brevo directly.
    expect(jobSection("account-purge")).toContain("BREVO_API_KEY: ${{ secrets.BREVO_API_KEY }}");
    for (const name of ["shop-purge", "db-health"]) {
      expect(jobSection(name)).not.toContain("BREVO_API_KEY");
    }
    expect(workflow).not.toMatch(/postgres(?:ql)?:\/\/[^$\s]+@/u);
    expect(workflow).toContain("permissions:\n  contents: read");
  });

  it.each(jobs)(
    "$name exposes secrets only to its script step, after install and build",
    ({ name, run }) => {
      // A dependency's install script or a build plugin must never see production credentials.
      const job = jobSection(name);
      const scriptStep = job.indexOf(`run: pnpm ${run}`);
      expect(job.indexOf("secrets.")).toBeGreaterThan(scriptStep);
      expect(job.indexOf("pnpm install")).toBeLessThan(scriptStep);
      expect(workflow.slice(0, workflow.indexOf("\njobs:"))).not.toContain("secrets.");
    }
  );
});
