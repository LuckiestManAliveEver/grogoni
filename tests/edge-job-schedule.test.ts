import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { edgeJobDefinitions } from "../services/api/src/edge-job-runner";
import {
  buildSupabaseCronSql,
  cronJobPrefix,
  daemonWakeJobName,
  redactJobToken
} from "../services/api/src/edge-job-schedule";

const apiUrl = "https://example.supabase.co/functions/v1/api";
const token = "t".repeat(48);

describe("Supabase Cron schedule for Edge background jobs", () => {
  it("pins Supabase jobs near Neon without changing custom API hosts", () => {
    const sql = buildSupabaseCronSql({ apiUrl });
    expect(sql).toContain("/run?forceFunctionRegion=us-east-1");
    expect(sql).toContain("'x-region', 'us-east-1'");
    expect(buildSupabaseCronSql({ apiUrl: "https://api.example.com" })).not.toContain(
      "forceFunctionRegion"
    );
  });
  it("schedules every runner job exactly once, with its own cadence", () => {
    const sql = buildSupabaseCronSql({ apiUrl });
    for (const [name, definition] of Object.entries(edgeJobDefinitions)) {
      const line = `select cron.schedule('${cronJobPrefix}${name}', '${definition.schedule}', `;
      expect(sql.split(line).length - 1, name).toBe(1);
    }
    // Plus the daemon wake guard, which is not a job of its own.
    expect(sql.match(/select cron\.schedule\(/gu)).toHaveLength(
      Object.keys(edgeJobDefinitions).length + 1
    );
    expect(sql).toContain(
      `select cron.schedule('${daemonWakeJobName}', '* * * * *', 'select public.grogoni_daemon_wake()');`
    );
  });

  it("unschedules jobs that no longer exist in the runner, and only Grogoni's", () => {
    const sql = buildSupabaseCronSql({ apiUrl });
    expect(sql).toContain(`where jobname like '${cronJobPrefix}%'`);
    expect(sql).toContain(`'${cronJobPrefix}notification_delivery'`);
  });

  it("keeps the job token out of the cron command text", () => {
    const sql = buildSupabaseCronSql({ apiUrl, jobToken: token });
    const scheduleLines = sql.split("\n").filter((line) => line.startsWith("select cron.schedule"));
    expect(scheduleLines.every((line) => !line.includes(token))).toBe(true);
    expect(sql).toContain("vault.decrypted_secrets");
    expect(sql).toContain(`vault.create_secret('${token}'`);
  });

  it("redacts the job token from Management API errors that echo the applied SQL", () => {
    const jobToken = "tok_" + "x".repeat(40);
    const echoed = `ERROR: syntax error in query: ${buildSupabaseCronSql({ apiUrl, jobToken })}`;
    expect(echoed).toContain(jobToken);
    const redacted = redactJobToken(echoed, jobToken);
    expect(redacted).not.toContain(jobToken);
    expect(redacted).toContain("[redacted job token]");
    expect(redactJobToken("plain", "")).toBe("plain");
    // An error excerpt that cuts through the token leaks no fragment of it.
    const realToken = "Q1w2E3r4T5y6U7i8O9p0-a_s_d_f_g_h_j_k_l_z_x_c";
    const excerpt = `LINE 3: ...vault.create_secret('${realToken.slice(0, 30)}`;
    expect(redactJobToken(excerpt, realToken)).not.toContain(realToken.slice(0, 12));
    expect(redactJobToken("grogoni-job-outbox-delivery ok", realToken)).toBe(
      "grogoni-job-outbox-delivery ok"
    );
    const script = readFileSync(
      new URL("../scripts/schedule-supabase-jobs.mjs", import.meta.url),
      "utf8"
    );
    // Redact the whole body before cutting it: a token that straddles the cut would otherwise
    // survive in part.
    expect(script).toMatch(
      /redactJobToken\(\s*await response\.text\(\),\s*jobToken\s*\)\.slice\(/u
    );
    const straddling = "x".repeat(1990) + jobToken + "y".repeat(100);
    const shown = redactJobToken(straddling, jobToken).slice(0, 2000);
    expect(shown).not.toContain(jobToken.slice(0, 10));
    expect(redactJobToken(straddling.slice(0, 2000), jobToken)).toContain(jobToken.slice(0, 10));
  });

  it("uses five-field cron expressions or pg_cron's sub-minute interval syntax", () => {
    for (const [name, { schedule }] of Object.entries(edgeJobDefinitions))
      expect(
        schedule.split(" ").length === 5 || /^([1-9]|[1-5][0-9]) seconds$/u.test(schedule),
        `${name}: ${schedule}`
      ).toBe(true);
  });

  it("rejects values that could break out of the SQL", () => {
    expect(() => buildSupabaseCronSql({ apiUrl: "https://x'; drop table y; --" })).toThrow();
    expect(() => buildSupabaseCronSql({ apiUrl, jobToken: "short" })).toThrow();
    expect(() => buildSupabaseCronSql({ apiUrl, jobToken: `${"a".repeat(40)}'--` })).toThrow();
  });
});

describe("Supabase function deploy bundle", () => {
  it("uploads every module the Edge entry point imports", () => {
    const deploy = readFileSync("scripts/deploy-supabase-api.mjs", "utf8");
    const uploaded = new Set(
      [...deploy.matchAll(/^\s+"([a-z0-9-]+\.(?:ts|mjs))",?$/gmu)].map((match) => match[1])
    );
    const pending = ["index.ts"];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(`supabase/functions/api/${file}`, "utf8");
      for (const match of source.matchAll(/(?:from |import\()"\.\/([^"]+)"/gu))
        pending.push(match[1]!);
    }
    for (const file of seen) expect(uploaded.has(file), file).toBe(true);
  });
});
