import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Supabase job scheduling command", () => {
  it.each([false, true])(
    "creates a token only for first setup or explicit rotation (%s)",
    (rotate) => {
      const mock = `
      let reads = 0, writes = 0, token;
      globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        if (url.endsWith('/secrets')) {
          writes++;
          token = body[0].value;
          if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error('Invalid generated token');
          return new Response(null, { status: 201 });
        }
        if (body.query.includes('vault.decrypted_secrets') && !body.query.includes('cron.schedule')) {
          reads++;
          return Response.json([]);
        }
        if (body.query.includes('cron.schedule')) {
          writes++;
          if (!body.query.includes(token)) throw new Error('Function and Vault token mismatch');
        }
        return Response.json([]);
      };
      process.on('exit', () => {
        if (reads !== ${rotate ? 0 : 1} || writes !== 2) process.exitCode = 1;
      });
    `;
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          `data:text/javascript,${encodeURIComponent(mock)}`,
          "scripts/schedule-supabase-jobs.mjs",
          "--apply",
          ...(rotate ? ["--rotate-token"] : [])
        ],
        { encoding: "utf8", env: { ...process.env, SUPABASE_ACCESS_TOKEN: "test-token" } }
      );
      expect(output).toContain("Existing Vault token reused: false");
      expect(output).not.toContain("test-token");
    }
  );

  it("continues after an empty successful secret response and applies the schedules", () => {
    const mock = `
      const token = 'existing-vault-token-'.repeat(3);
      let calls = 0;
      globalThis.fetch = async (url, options) => {
        calls++;
        if (calls === 1) {
          if (!url.endsWith('/database/query') || !JSON.parse(options.body).query.includes('vault.decrypted_secrets'))
            throw new Error('Expected existing token lookup');
          return Response.json([{ token }]);
        }
        if (calls === 2) {
          if (!url.endsWith('/secrets')) throw new Error('Expected secret update');
          if (JSON.parse(options.body)[0].value !== token) throw new Error('Token unexpectedly rotated');
          return new Response(null, { status: 201 });
        }
        if (!url.endsWith('/database/query')) throw new Error('Unexpected endpoint');
        const body = JSON.parse(options.body);
        if (calls === 3) {
          if (!body.query.includes('vault.create_secret') || !body.query.includes('cron.schedule'))
            throw new Error('Missing token or schedules');
          return new Response('[]');
        }
        return Response.json([{ jobname: 'grogoni-job-notification_delivery', schedule: '* * * * *' }]);
      };
      process.on('exit', () => { if (calls !== 4) process.exitCode = 1; });
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
    expect(output).not.toContain("existing-vault-token-");
    expect(output).toContain("Existing Vault token reused: true");
  });
});
