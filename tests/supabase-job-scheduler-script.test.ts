import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Supabase job scheduling command", () => {
  it("continues after an empty successful secret response and applies the schedules", () => {
    const mock = `
      let calls = 0;
      globalThis.fetch = async (url, options) => {
        calls++;
        if (calls === 1) {
          if (!url.endsWith('/secrets')) throw new Error('Expected secret update');
          return new Response(null, { status: 201 });
        }
        if (!url.endsWith('/database/query')) throw new Error('Unexpected endpoint');
        const body = JSON.parse(options.body);
        if (calls === 2) {
          if (!body.query.includes('vault.create_secret') || !body.query.includes('cron.schedule'))
            throw new Error('Missing token or schedules');
          return new Response('[]');
        }
        return Response.json([{ jobname: 'grogoni-job-notification_delivery', schedule: '* * * * *' }]);
      };
      process.on('exit', () => { if (calls !== 3) process.exitCode = 1; });
    `;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        `data:text/javascript,${encodeURIComponent(mock)}`,
        "scripts/schedule-supabase-jobs.mjs",
        "--apply"
      ],
      { encoding: "utf8", env: { ...process.env, SUPABASE_ACCESS_TOKEN: "test-token" } }
    );
    expect(output).toContain("Applied.");
    expect(output).toContain("grogoni-job-notification_delivery");
    expect(output).not.toContain("test-token");
  });
});
