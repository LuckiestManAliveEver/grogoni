import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Cp2Store } from "../services/api/src/cp2/store";
import pg from "../services/api/node_modules/pg";
import type { PoolClient } from "../services/api/node_modules/pg";
import { createPostgresCp2Store } from "../services/api/src/cp2/postgres-store";
import {
  edgeJobDefinitions,
  runEdgeJob,
  type EdgeJobDatabase
} from "../services/api/src/edge-job-runner";
import { createJobTransaction } from "../supabase/functions/api/job-transaction";
import { buildSupabaseCronSql } from "../services/api/src/edge-job-schedule";
import { RateLimitExceededError, createRateLimiter } from "../supabase/functions/api/rate-limit";

// Runs the Edge job runner and rate limiter against a real, fully migrated PostgreSQL database:
// CP2_POSTGRES_TEST_DATABASE_URL=postgresql://... pnpm vitest run tests/edge-runtime-postgres.test.ts
const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;

// The same shape as the Edge transaction (supabase/functions/api/index.ts): one connection per
// transaction, rate-limit count before BEGIN, then the store lock.
function edgeDatabase(rateLimiter?: ReturnType<typeof createRateLimiter>) {
  return {
    async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await rateLimiter?.check(client);
        await client.query("begin");
        await client.query(
          "select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))"
        );
        const result = await action(client as unknown as PoolClient);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        await client.end();
      }
    },
    // The production job transaction (supabase/functions/api/job-transaction.ts).
    jobTransaction: createJobTransaction({
      connect: async () => {
        const client = new pg.Client({ connectionString: databaseUrl });
        await client.connect();
        return client;
      },
      onFailure: () => {}
    }) as unknown as EdgeJobDatabase["jobTransaction"]
  };
}

async function sql<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

// Snapshot loads grow with the test database; 1-3s each, so the default 5s per test is too tight.
describe.skipIf(!databaseUrl)("Edge runtime on PostgreSQL", { timeout: 60_000 }, () => {
  it("counts concurrent requests from one client exactly and rejects past the limit", async () => {
    const limiter = createRateLimiter({
      enabled: true,
      windowMs: 60_000,
      authMax: 60,
      defaultMax: 15
    });
    const ip = `198.51.100.${Date.now() % 250}`;
    const request = new Request("https://grogoni.com/api/v1/conversations", {
      headers: { "x-forwarded-for": ip }
    });
    const database = edgeDatabase(limiter);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        limiter.run(request, "/v1/conversations", () => database.transaction(async () => "ok"))
      )
    );
    const rejected = results.filter(
      (result) => result.status === "rejected" && result.reason instanceof RateLimitExceededError
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(15);
    expect(rejected).toHaveLength(5);
    const rows = await sql<{ request_count: number; rate_key: string }>(
      "select rate_key, request_count from cp2_edge_rate_limits where rate_key like 'client:%' order by window_start desc limit 50"
    );
    expect(rows.some((row) => row.request_count === 20)).toBe(true);
    expect(rows.every((row) => !row.rate_key.includes(ip))).toBe(true);
  });

  it("persists a job's effect through the real snapshot load and save", async () => {
    const store = await createPostgresCp2Store({ databaseUrl: databaseUrl! });
    let businessId: string;
    try {
      const actor = store.continueWithChannelPin({
        channel: "phone",
        destination: `+254798${Date.now().toString().slice(-6)}`,
        pin: "7421"
      });
      const business = store.createBusiness({
        sessionId: actor.session.id,
        name: `Edge job persistence ${Date.now()}`,
        language: "en"
      }).business;
      businessId = business.id;
      store.renameGrogoniId({
        sessionId: actor.session.id,
        businessId,
        handle: `edgejob${Date.now().toString().slice(-6)}`,
        now: new Date("2026-01-01T00:00:00.000Z")
      });
      await store.flush();
    } finally {
      await store.close();
    }

    const outcome = await runEdgeJob(edgeDatabase(), "grogoniid_cooldown", {
      environment: { GROGONI_ID_COOLDOWN_MS: "1000" }
    });
    expect(outcome.status).toBe("completed");
    expect((outcome.result as { released: number }).released).toBeGreaterThanOrEqual(1);

    const reloaded = await createPostgresCp2Store({ databaseUrl: databaseUrl! });
    try {
      const history = (reloaded.snapshot().grogoniIdHistory ?? []).filter(
        (entry) => entry.businessId === businessId
      );
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history.every((entry) => entry.releasedAt !== null)).toBe(true);
    } finally {
      await reloaded.close();
    }
  });

  it("runs one copy of a job when triggers overlap while a request holds the store lock", async () => {
    // The production shape the first version got wrong: the store lock is busy (a user request),
    // and several cron ticks or retries trigger the same job at once. grogoniid_cooldown has no
    // idle check, so the winning run really waits on the store lock.
    const request = new pg.Client({ connectionString: databaseUrl });
    await request.connect();
    await request.query("begin");
    await request.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
    const database = edgeDatabase();
    const runs = Array.from({ length: 3 }, () =>
      runEdgeJob(database, "grogoniid_cooldown", { environment: {} })
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await request.query("commit");
    await request.end();
    const statuses = (await Promise.all(runs)).map((outcome) => outcome.status).sort();
    expect(statuses).toEqual(["completed", "skipped", "skipped"]);
  });

  it("skips the store lock when no message notification is due", async () => {
    await sql(
      "update cp2_message_notification_deliveries set record = jsonb_set(record, '{status}', '\"sent\"') where record->>'status' in ('pending', 'failed')"
    );
    const request = new pg.Client({ connectionString: databaseUrl });
    await request.connect();
    await request.query("begin");
    await request.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
    try {
      const outcome = await runEdgeJob(edgeDatabase(), "notification_delivery", {
        environment: {}
      });
      expect(outcome).toMatchObject({ status: "completed", result: { idle: true } });
    } finally {
      await request.query("commit");
      await request.end();
    }
  });

  it("skips the store lock entirely when the outbox is empty", async () => {
    await sql(
      "update fulfillment_outbox_events set delivered_at = now() where delivered_at is null"
    );
    const request = new pg.Client({ connectionString: databaseUrl });
    await request.connect();
    await request.query("begin");
    await request.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
    try {
      const outcome = await runEdgeJob(edgeDatabase(), "fulfillment_outbox_delivery", {
        environment: {}
      });
      expect(outcome).toMatchObject({ status: "completed", result: { idle: true } });
    } finally {
      await request.query("commit");
      await request.end();
    }
  });

  it("purges rate-limit windows without waiting on the store lock", async () => {
    const request = new pg.Client({ connectionString: databaseUrl });
    await request.connect();
    await request.query("begin");
    await request.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
    try {
      const outcome = await runEdgeJob(edgeDatabase(), "edge_rate_limit_retention", {
        environment: {}
      });
      expect(outcome.status).toBe("completed");
    } finally {
      await request.query("commit");
      await request.end();
    }
  });

  it("counts nothing and serves the request when the counter table is missing", async () => {
    const limiter = createRateLimiter({
      enabled: true,
      windowMs: 60_000,
      authMax: 1,
      defaultMax: 1
    });
    await sql("alter table cp2_edge_rate_limits rename to cp2_edge_rate_limits_hidden");
    try {
      const request = new Request("https://grogoni.com/api/v1/conversations", {
        headers: { "x-forwarded-for": "198.51.100.77" }
      });
      for (let index = 0; index < 3; index++)
        await expect(
          limiter.run(request, "/v1/conversations", () =>
            edgeDatabase(limiter).transaction(async () => "served")
          )
        ).resolves.toBe("served");
    } finally {
      await sql("alter table cp2_edge_rate_limits_hidden rename to cp2_edge_rate_limits");
    }
  });

  it("delivers outbox events through the store's notifier, not just marks them delivered", async () => {
    // Regression from review round 2: the Edge service was built without deliverOutboxEvent, so
    // events were marked delivered and the customer was never notified.
    const id = randomUUID();
    await sql(
      "insert into fulfillment_outbox_events (id, business_id, event_type, event_key, payload, occurred_at) values ($1, $2, 'delivery.completed', $3, $4, now())",
      [id, randomUUID(), `edge-outbox-${id}`, JSON.stringify({ invoiceId: "inv-1" })]
    );
    const notify = vi.spyOn(Cp2Store.prototype, "deliverFulfillmentNotification");
    try {
      const outcome = await runEdgeJob(edgeDatabase(), "fulfillment_outbox_delivery", {
        environment: {}
      });
      expect(outcome.status).toBe("completed");
      expect(notify.mock.calls.some(([event]) => (event as { id?: string }).id === id)).toBe(true);
      const [row] = await sql<{ delivered_at: Date | null }>(
        "select delivered_at from fulfillment_outbox_events where id = $1",
        [id]
      );
      expect(row?.delivered_at).not.toBeNull();
    } finally {
      notify.mockRestore();
    }
  });

  it("runs every background job to completion on the migrated schema", async () => {
    for (const job of Object.keys(edgeJobDefinitions)) {
      const outcome = await runEdgeJob(edgeDatabase(), job, {
        environment: { ENABLE_ACCOUNT_DELETION_RUNNER: "true" }
      });
      expect(outcome.status, job).toBe("completed");
    }
  }, 60_000);

  it("purges only expired rate-limit windows", async () => {
    await sql(
      `insert into cp2_edge_rate_limits (rate_key, window_start, request_count) values
        ('default:retention-old', now() - interval '2 hours', 3),
        ('default:retention-new', now(), 3)
      on conflict (rate_key) do update set window_start = excluded.window_start`
    );
    const outcome = await runEdgeJob(edgeDatabase(), "edge_rate_limit_retention", {
      environment: {}
    });
    expect((outcome.result as { purged: number }).purged).toBeGreaterThanOrEqual(1);
    const left = await sql<{ rate_key: string }>(
      "select rate_key from cp2_edge_rate_limits where rate_key like 'default:retention-%'"
    );
    expect(left.map((row) => row.rate_key)).toEqual(["default:retention-new"]);
  });

  it("applies the Supabase Cron schedule idempotently and keeps the token out of cron.job", async () => {
    // Plain PostgreSQL has no pg_cron, pg_net or Vault; these stand-ins have their signatures.
    await sql(`
      do $r$ begin create role anon; exception when duplicate_object then null; end $r$;
      do $r$ begin create role authenticated; exception when duplicate_object then null; end $r$;
      create schema if not exists cron;
      create table if not exists cron.job (jobname text primary key, schedule text, command text);
      create or replace function cron.schedule(name text, schedule text, command text)
      returns bigint language sql as $f$
        insert into cron.job values (name, schedule, command)
        on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
        returning 1::bigint
      $f$;
      create or replace function cron.unschedule(name text) returns boolean language sql as $f$
        delete from cron.job where jobname = name returning true
      $f$;
      create schema if not exists net;
      create or replace function net.http_post(url text, headers jsonb, body jsonb,
        timeout_milliseconds integer) returns bigint language sql as $f$ select 1::bigint $f$;
      create schema if not exists vault;
      create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(),
        name text unique, secret text);
      create or replace view vault.decrypted_secrets as
        select id, name, secret as decrypted_secret from vault.secrets;
      create or replace function vault.create_secret(secret text, name text) returns uuid
        language sql as $f$ insert into vault.secrets (name, secret) values (name, secret) returning id $f$;
      create or replace function vault.update_secret(id uuid, secret text) returns void
        language sql as $f$ update vault.secrets set secret = $2 where vault.secrets.id = $1 $f$;
      insert into cron.job values ('grogoni-job-retired_job', '* * * * *', 'select 1')
        on conflict do nothing;
      insert into cron.job values ('someone-elses-job', '* * * * *', 'select 1')
        on conflict do nothing;
    `);
    const token = "k".repeat(48);
    const generated = buildSupabaseCronSql({
      apiUrl: "https://example.supabase.co/functions/v1/api",
      jobToken: token
    }).replace(/create extension[^;]+;/gu, "");
    await sql(generated);
    await sql(generated.replaceAll(token, "r".repeat(48)));

    const jobs = await sql<{ jobname: string; command: string }>(
      "select jobname, command from cron.job order by jobname"
    );
    const names = jobs.map((job) => job.jobname);
    expect(names).toContain("someone-elses-job");
    expect(names).not.toContain("grogoni-job-retired_job");
    expect(names.filter((name) => name.startsWith("grogoni-job-"))).toHaveLength(
      Object.keys(edgeJobDefinitions).length
    );
    expect(
      jobs.every((job) => !job.command.includes("kkkk") && !job.command.includes("rrrr"))
    ).toBe(true);
    const secrets = await sql<{ secret: string }>(
      "select secret from vault.secrets where name = 'grogoni_background_job_token'"
    );
    expect(secrets).toEqual([{ secret: "r".repeat(48) }]);
    const [run] = await sql<{ id: string }>(
      "select public.grogoni_run_background_job('notification_delivery')::text as id"
    );
    expect(run?.id).toBe("1");
  });
});
