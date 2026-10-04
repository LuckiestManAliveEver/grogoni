import net from "node:net";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPostgresCp2Store } from "./cp2/postgres-store.js";
import {
  isTransientDatabaseError,
  retryDatabaseStartup,
  retryInBackground
} from "./db-startup-retry.js";

function codedError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

const noSleep = {
  initialDelayMs: 1,
  maxDelayMs: 1,
  random: () => 1,
  sleep: async () => undefined
};

describe("isTransientDatabaseError", () => {
  it.each(["EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"])(
    "retries the network code %s",
    (code) => {
      expect(isTransientDatabaseError(codedError(code))).toBe(true);
    }
  );

  it.each(["08006", "08001", "57P03", "57P01", "53300"])("retries the SQLSTATE %s", (code) => {
    expect(isTransientDatabaseError(codedError(code))).toBe(true);
  });

  it.each([
    "Connection terminated unexpectedly",
    "Connection terminated due to connection timeout",
    "timeout exceeded when trying to connect",
    "timeout expired",
    "Query read timeout"
  ])("retries the node-postgres message %s", (message) => {
    expect(isTransientDatabaseError(new Error(message))).toBe(true);
  });

  it.each([
    ["08P01", "query_wait_timeout"],
    ["08P01", "no more connections allowed (max_client_conn)"],
    [
      "08P01",
      "server login has been failing, cached error: server DNS lookup failed (server_login_retry)"
    ],
    ["08P01", "server login has been failing, try again later (server_login_retry)"],
    ["08P01", "client_login_timeout (server down)"],
    ["08P01", "server shutting down"],
    ["08P01", "pooler is shutting down"],
    ["08P01", "client connections exceeded (max_db_client_connections)"],
    ["08P01", "client connections exceeded (max_user_client_connections)"],
    ["08P01", "query_timeout"],
    ["XX000", "Couldn't connect to compute node"],
    [
      "XX000",
      "Failed to acquire permit to connect to the database. Too many database connection attempts are currently ongoing."
    ]
  ])("retries the pooler/proxy error %s %s", (code, message) => {
    expect(isTransientDatabaseError(codedError(code, message))).toBe(true);
  });

  it("finds a transient code behind a cause chain and inside an AggregateError", () => {
    expect(isTransientDatabaseError(new Error("wrapped", { cause: codedError("EAI_AGAIN") }))).toBe(
      true
    );
    expect(
      isTransientDatabaseError(new AggregateError([codedError("ECONNREFUSED")], "connect failed"))
    ).toBe(true);
  });

  it.each([
    ["wrong hostname", codedError("ENOTFOUND")],
    ["missing table", codedError("42P01", 'relation "grogoni_schema_migrations" does not exist')],
    ["bad password", codedError("28P01", "password authentication failed")],
    ["plain error", new Error("Database migrations are behind")],
    ["rejected connection (08004)", codedError("08004", "server rejected the connection")],
    ["protocol violation (08P01)", codedError("08P01", "protocol violation")],
    ["pooler protocol error (08P01)", codedError("08P01", "unsupported pkt type: 80")],
    [
      "cached unknown database behind the pooler (08P01)",
      codedError(
        "08P01",
        'server login has been failing, cached error: database "grogoni" does not exist (server_login_retry)'
      )
    ],
    [
      "cached pooler auth failure (08P01)",
      codedError(
        "08P01",
        'server login has been failing, cached error: password authentication failed for user "grogoni" (server_login_retry)'
      )
    ],
    ["unknown database via pooler (08P01)", codedError("08P01", 'no such database: "grogoni"')],
    ["Neon endpoint disabled (XX000)", codedError("XX000", "The endpoint has been disabled")],
    ["non-error", "EAI_AGAIN"],
    ["null", null]
  ])("fails fast on %s", (_label, error) => {
    expect(isTransientDatabaseError(error)).toBe(false);
  });

  it("does not loop on a self-referencing cause", () => {
    const error = new Error("cyclic") as Error & { cause?: unknown };
    error.cause = error;
    expect(isTransientDatabaseError(error)).toBe(false);
  });
});

describe("retryDatabaseStartup", () => {
  it("recovers when the resolver fails transiently and then answers (the dev:local crash)", async () => {
    const events: Record<string, unknown>[] = [];
    let calls = 0;
    const result = await retryDatabaseStartup(
      "inference_schema",
      async () => {
        calls += 1;
        if (calls < 3) {
          throw codedError(
            "EAI_AGAIN",
            "getaddrinfo EAI_AGAIN ep-example-pooler.us-east-2.aws.neon.tech"
          );
        }
        return "ready";
      },
      { maxAttempts: 6, ...noSleep, log: (event) => events.push(event) }
    );
    expect(result).toBe("ready");
    expect(calls).toBe(3);
    expect(events).toEqual([
      {
        event: "db.startup_retry",
        step: "inference_schema",
        attempt: 1,
        maxAttempts: 6,
        code: "EAI_AGAIN",
        delayMs: 1
      },
      {
        event: "db.startup_retry",
        step: "inference_schema",
        attempt: 2,
        maxAttempts: 6,
        code: "EAI_AGAIN",
        delayMs: 1
      },
      { event: "db.startup_recovered", step: "inference_schema", failedAttempts: 2 }
    ]);
  });

  it("logs the code that made the error retryable, not a wrapping error's own code", async () => {
    const events: Record<string, unknown>[] = [];
    let calls = 0;
    await retryDatabaseStartup(
      "cp2_store",
      async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("boot failed", { cause: codedError("ECONNRESET") }), {
            code: "BOOT_FAILED"
          });
        }
        return null;
      },
      { maxAttempts: 2, ...noSleep, log: (event) => events.push(event) }
    );
    expect(events[0]).toMatchObject({ event: "db.startup_retry", code: "ECONNRESET" });
  });

  it("logs the message for a code-less node-postgres timeout", async () => {
    const events: Record<string, unknown>[] = [];
    let calls = 0;
    await retryDatabaseStartup(
      "inference_schema",
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("Query read timeout");
        return null;
      },
      { maxAttempts: 2, ...noSleep, log: (event) => events.push(event) }
    );
    expect(events[0]).toMatchObject({ code: "Query read timeout" });
  });

  it("logs the pooler message, not just 08P01, when the message made the error retryable", async () => {
    const events: Record<string, unknown>[] = [];
    let calls = 0;
    await retryDatabaseStartup(
      "cp2_store",
      async () => {
        calls += 1;
        if (calls === 1) throw codedError("08P01", "query_wait_timeout");
        return null;
      },
      { maxAttempts: 2, ...noSleep, log: (event) => events.push(event) }
    );
    expect(events[0]).toMatchObject({ code: "08P01: query_wait_timeout" });
  });

  it("does not retry a schema failure and rethrows it unchanged", async () => {
    const schemaError = codedError("42P01", 'relation "inference_providers" does not exist');
    let calls = 0;
    const events: Record<string, unknown>[] = [];
    await expect(
      retryDatabaseStartup(
        "inference_schema",
        async () => {
          calls += 1;
          throw schemaError;
        },
        { maxAttempts: 6, ...noSleep, log: (event) => events.push(event) }
      )
    ).rejects.toBe(schemaError);
    expect(calls).toBe(1);
    expect(events).toEqual([]);
  });

  it("gives up after maxAttempts and throws the last transient error", async () => {
    let calls = 0;
    const events: Record<string, unknown>[] = [];
    await expect(
      retryDatabaseStartup(
        "cp2_store",
        async () => {
          calls += 1;
          throw codedError("EAI_AGAIN", `attempt ${calls}`);
        },
        { maxAttempts: 3, ...noSleep, log: (event) => events.push(event) }
      )
    ).rejects.toThrow("attempt 3");
    expect(calls).toBe(3);
    expect(events.map((event) => event.attempt)).toEqual([1, 2]);
  });

  it("logs nothing when the first attempt succeeds", async () => {
    const events: Record<string, unknown>[] = [];
    await retryDatabaseStartup("cp2_store", async () => 1, {
      maxAttempts: 3,
      ...noSleep,
      log: (event) => events.push(event)
    });
    expect(events).toEqual([]);
  });

  it("classifies a real node-postgres connection failure as transient", async () => {
    // Reserve a free port and close it, so node-postgres gets a genuine refused connection.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const pool = new Pool({
      connectionString: `postgres://user:pass@127.0.0.1:${port}/db`,
      connectionTimeoutMillis: 500
    });
    try {
      const failure = await pool.query("select 1").then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).not.toBeNull();
      expect(isTransientDatabaseError(failure)).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("re-runs createPostgresCp2Store on a refused connection and surfaces the transient error", async () => {
    const port = await closedPort();
    let calls = 0;
    const failure = await retryDatabaseStartup(
      "cp2_store",
      () => {
        calls += 1;
        return createPostgresCp2Store({
          databaseUrl: `postgres://user:pass@127.0.0.1:${port}/db`
        });
      },
      { maxAttempts: 3, ...noSleep, log: () => undefined }
    ).then(
      () => null,
      (error: unknown) => error
    );
    expect(calls).toBe(3);
    expect(isTransientDatabaseError(failure)).toBe(true);
  });
});

describe("retryInBackground", () => {
  function manualTimers() {
    const queue: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
    return {
      queue,
      setTimer: (run: () => void, ms: number) => {
        const entry = { run, ms, cancelled: false };
        queue.push(entry);
        return { cancel: () => (entry.cancelled = true) };
      },
      async fireNext() {
        const entry = queue.shift();
        if (entry === undefined) throw new Error("no timer scheduled");
        if (!entry.cancelled) entry.run();
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
  }

  it("keeps retrying with capped backoff until the step recovers, then stops", async () => {
    const timers = manualTimers();
    const events: Record<string, unknown>[] = [];
    let calls = 0;
    retryInBackground(
      "inference_refresh",
      async () => {
        calls += 1;
        if (calls < 4) throw codedError("EAI_AGAIN");
      },
      {
        initialDelayMs: 5_000,
        maxDelayMs: 12_000,
        random: () => 1,
        log: (event) => events.push(event),
        setTimer: timers.setTimer
      }
    );
    const delays: number[] = [];
    for (let fired = 0; fired < 4; fired += 1) {
      delays.push(timers.queue[0]!.ms);
      await timers.fireNext();
    }
    expect(calls).toBe(4);
    expect(delays).toEqual([5_000, 10_000, 12_000, 12_000]);
    expect(timers.queue).toHaveLength(0);
    expect(events).toEqual([
      {
        event: "db.background_retry",
        step: "inference_refresh",
        attempt: 1,
        code: "EAI_AGAIN",
        delayMs: 10_000
      },
      {
        event: "db.background_retry",
        step: "inference_refresh",
        attempt: 2,
        code: "EAI_AGAIN",
        delayMs: 12_000
      },
      {
        event: "db.background_retry",
        step: "inference_refresh",
        attempt: 3,
        code: "EAI_AGAIN",
        delayMs: 12_000
      },
      {
        event: "db.startup_recovered",
        step: "inference_refresh",
        failedAttempts: 3,
        background: true
      }
    ]);
  });

  it("does not log or reschedule when stopped while an attempt is in flight", async () => {
    const timers = manualTimers();
    const events: Record<string, unknown>[] = [];
    let rejectAttempt: (error: unknown) => void = () => undefined;
    const stop = retryInBackground(
      "inference_refresh",
      () =>
        new Promise((_resolve, reject) => {
          rejectAttempt = reject;
        }),
      {
        initialDelayMs: 1,
        maxDelayMs: 1,
        random: () => 1,
        log: (event) => events.push(event),
        setTimer: timers.setTimer
      }
    );
    await timers.fireNext();
    stop();
    rejectAttempt(codedError("EAI_AGAIN"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([]);
    expect(timers.queue).toHaveLength(0);
  });

  it("cancels the pending timer when stopped", () => {
    let cancelled = 0;
    const stop = retryInBackground("inference_refresh", async () => undefined, {
      initialDelayMs: 1,
      maxDelayMs: 1,
      setTimer: () => ({ cancel: () => (cancelled += 1) })
    });
    stop();
    expect(cancelled).toBe(1);
  });

  it("stops scheduling and running once stopped (shutdown)", async () => {
    const timers = manualTimers();
    let calls = 0;
    const stop = retryInBackground(
      "inference_refresh",
      async () => {
        calls += 1;
        throw codedError("EAI_AGAIN");
      },
      {
        initialDelayMs: 1,
        maxDelayMs: 1,
        random: () => 1,
        log: () => undefined,
        setTimer: timers.setTimer
      }
    );
    await timers.fireNext();
    expect(calls).toBe(1);
    stop();
    await timers.fireNext();
    expect(calls).toBe(1);
    expect(timers.queue).toHaveLength(0);
  });
});

const testDatabaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)(
  "createPostgresCp2Store retry safety (CP2_POSTGRES_TEST_DATABASE_URL)",
  () => {
    it("closes every pool it opened when an attempt fails after connecting, so boot retries leak nothing", async () => {
      // An empty database: connections succeed (warmPool opens live sockets), then the migration
      // check fails. Without endPools() on that path each boot retry would strand those connections.
      const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
      const emptyDatabase = `grogoni_retry_leak_${process.pid}_${Date.now()}`;
      await admin.query(`create database ${emptyDatabase}`);
      const emptyUrl = new URL(testDatabaseUrl!);
      emptyUrl.pathname = `/${emptyDatabase}`;
      try {
        await settle();
        const baseline = activeNetworkResources();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await expect(
            createPostgresCp2Store({ databaseUrl: emptyUrl.toString() })
          ).rejects.toThrow();
        }
        await settle();
        const after = activeNetworkResources();
        for (const resource of Object.keys(after)) {
          expect(after[resource], resource).toBeLessThanOrEqual(baseline[resource] ?? 0);
        }
      } finally {
        await admin.query(`drop database if exists ${emptyDatabase} with (force)`);
        await admin.end();
      }
    }, 60_000);
  }
);

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200));
}

async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function activeNetworkResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const resource of process.getActiveResourcesInfo()) {
    if (resource === "TCPSocketWrap" || resource === "TCPServerWrap" || resource === "Timeout") {
      counts[resource] = (counts[resource] ?? 0) + 1;
    }
  }
  return counts;
}
