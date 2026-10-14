import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool as PgPool, PoolConfig } from "pg";
import { describe, expect, it } from "vitest";

// Regression for the dev:local crash on a flaky resolver: a single
// `getaddrinfo EAI_AGAIN <host>.neon.tech` during boot killed the API (docs/runbooks/db-startup-dns-flake.md).
// These tests run the real entrypoint (services/api/src/index.ts) in a child process with
// tests/fixtures/flaky-dns.mjs preloaded, so they fail if any boot step stops going through
// retryDatabaseStartup.

const apiDirectory = fileURLToPath(new URL("../services/api/", import.meta.url));
const flakyDnsPreload = fileURLToPath(new URL("./fixtures/flaky-dns.mjs", import.meta.url));
const FLAKY_HOST = "flaky-db.grogoni.test";
// pg is a services/api dependency, not a root one.
const { Pool } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg") as {
  Pool: new (config: PoolConfig) => PgPool;
};

interface BootResult {
  exitCode: number | null;
  output: string;
  listening: boolean;
  /** Whether the process was still running when `whileListening` finished. */
  aliveAfterWhileListening: boolean;
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function bootApi(
  environment: Record<string, string>,
  timeoutMs: number,
  whileListening: () => Promise<void> = async () => undefined
): Promise<BootResult> {
  const port = String(await freePort());
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(flakyDnsPreload).href, "--import", "tsx", "src/index.ts"],
    {
      cwd: apiDirectory,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "development",
        API_HOST: "127.0.0.1",
        API_PORT: port,
        LOCAL_CACHE_MODE: "memory",
        ...environment
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  let exitCode: number | null = null;
  let exited = false;
  const exit = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      resolve();
    });
  });
  const listening = new Promise<boolean>((resolve) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Server listening")) resolve(true);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    void exit.then(() => resolve(false));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const isListening = await listening;
    let aliveAfterWhileListening = false;
    if (isListening) {
      await whileListening();
      aliveAfterWhileListening = !exited;
      child.kill("SIGTERM");
    }
    await exit;
    return { exitCode, output, listening: isListening, aliveAfterWhileListening };
  } finally {
    clearTimeout(timer);
  }
}

function startupEvents(output: string): Array<Record<string, unknown>> {
  return output
    .split("\n")
    .filter((line) => line.startsWith('{"event":"db.startup_'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("API boot on a flaky database resolver", () => {
  it("retries EAI_AGAIN during boot instead of crashing on the first failed lookup", async () => {
    const result = await bootApi(
      {
        DATABASE_URL: `postgres://grogoni:secret@${FLAKY_HOST}:5432/grogoni`,
        FLAKY_DNS_HOST: FLAKY_HOST,
        DB_STARTUP_MAX_ATTEMPTS: "2"
      },
      60_000
    );

    const events = startupEvents(result.output);
    expect(events, result.output).toContainEqual(
      expect.objectContaining({
        event: "db.startup_retry",
        step: "inference_schema",
        attempt: 1,
        maxAttempts: 2,
        code: "EAI_AGAIN"
      })
    );
    // The resolver never recovers, so after the retry budget boot still fails loudly.
    expect(result.listening).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("getaddrinfo EAI_AGAIN flaky-db.grogoni.test");
  }, 70_000);

  const testDatabaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
  it.skipIf(!testDatabaseUrl)(
    "boots against Postgres once the resolver recovers (CP2_POSTGRES_TEST_DATABASE_URL)",
    async () => {
      const target = new URL(testDatabaseUrl!);
      const realHost = target.hostname;
      target.hostname = FLAKY_HOST;
      const result = await bootApi(
        {
          DATABASE_URL: target.toString(),
          FLAKY_DNS_HOST: FLAKY_HOST,
          FLAKY_DNS_ADDRESS: realHost,
          FLAKY_DNS_FAILURES: "3"
        },
        120_000
      );

      const events = startupEvents(result.output);
      expect(result.listening, result.output).toBe(true);
      expect(result.output.match(/\[flaky-dns\] EAI_AGAIN/g)).toHaveLength(3);
      expect(events.filter((event) => event.event === "db.startup_retry").length).toBeGreaterThan(
        0
      );
      expect(events.some((event) => event.event === "db.startup_recovered")).toBe(true);
    },
    130_000
  );

  it.skipIf(!testDatabaseUrl)(
    "recovers when the flake hits the CP2 store and fulfillment steps after inference passes (CP2_POSTGRES_TEST_DATABASE_URL)",
    async () => {
      const target = new URL(testDatabaseUrl!);
      const realHost = target.hostname;
      target.hostname = FLAKY_HOST;
      const result = await bootApi(
        {
          DATABASE_URL: target.toString(),
          FLAKY_DNS_HOST: FLAKY_HOST,
          FLAKY_DNS_ADDRESS: realHost,
          // inference_schema's single connection resolves; the burst after it lands on the
          // cp2_store pools and the fulfillment schema check, which start together. 12 failures were
          // already enough to make both steps retry in every probe run; 20 leaves margin.
          FLAKY_DNS_SKIP: "1",
          FLAKY_DNS_FAILURES: "20"
        },
        120_000
      );

      const retries = startupEvents(result.output).filter(
        (event) => event.event === "db.startup_retry"
      );
      expect(result.listening, result.output).toBe(true);
      expect(retries.some((event) => event.step === "inference_schema")).toBe(false);
      // The provider refresh runs on the same flaky resolver and must never give up and boot
      // without the DB-configured providers. Since BYOK key rotation was removed, nothing else holds
      // the inference pool's idle connection, so the refresh usually reuses it and needs no retry.
      expect(result.output).not.toContain("inference.provider_refresh_failed");
      for (const step of ["cp2_store", "fulfillment_schema"]) {
        expect(
          retries.some((event) => event.step === step),
          `${step} retried\n${result.output}`
        ).toBe(true);
      }
    },
    130_000
  );

  it.skipIf(!testDatabaseUrl)(
    "survives the database dropping its idle connections after boot (CP2_POSTGRES_TEST_DATABASE_URL)",
    async () => {
      // A network reset or a Neon compute restart kills idle pooled connections; pg-pool then emits
      // "error" on the pool, which crashes the process unless every pool has a listener.
      const applicationName = `grogoni-idle-drop-${process.pid}-${Date.now()}`;
      const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
      try {
        const result = await bootApi(
          { DATABASE_URL: testDatabaseUrl!, DB_APPLICATION_NAME: applicationName },
          120_000,
          async () => {
            const terminated = await admin.query<{ pid: number }>(
              `with targets as materialized (
                 select pid from pg_stat_activity where application_name = $1 and state = 'idle'
               )
               select pid from targets where pg_terminate_backend(pid)`,
              [applicationName]
            );
            expect(terminated.rowCount).toBeGreaterThan(0);
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        );
        expect(result.listening, result.output).toBe(true);
        expect(result.aliveAfterWhileListening, result.output).toBe(true);
      } finally {
        await admin.end();
      }
    },
    130_000
  );
});

describe("API boot wiring", () => {
  // Without CP2_POSTGRES_TEST_DATABASE_URL the child-process tests only reach the first step, so
  // this also pins the rest in the default lane: every boot-time database call in the entrypoint is
  // wrapped.
  const entrypoint = readFileSync(new URL("../services/api/src/index.ts", import.meta.url), "utf8");

  it.each([
    ["inference_schema", "assertInferenceSchema"],
    ["fulfillment_schema", "assertFulfillmentSchema"],
    ["cp2_store", "createPostgresCp2Store"],
    ["inference_refresh", "inferencePlatform\\.refresh"]
  ])("runs %s through retryDatabaseStartup", (step, call) => {
    const wrapped = new RegExp(
      String.raw`retryDatabaseStartup\(\s*"${step}",\s*\(\)\s*=>\s*${call}\(`
    );
    expect(entrypoint).toMatch(wrapped);
    // Every call must sit inside a retry wrapper: the boot retry, or the background retry that
    // takes over for inference_refresh once the boot retries are exhausted.
    const allCalls = entrypoint.match(new RegExp(String.raw`\b${call}\(`, "g")) ?? [];
    const wrappedCalls =
      entrypoint.match(
        new RegExp(
          String.raw`(?:retryDatabaseStartup|retryInBackground)\(\s*"${step}",\s*\(\)\s*=>\s*${call}\(`,
          "g"
        )
      ) ?? [];
    expect(allCalls.length, `every ${call}( call in index.ts must be wrapped`).toBe(
      wrappedCalls.length
    );
  });

  it.each(["inferencePool", "fulfillmentPool"])(
    "attaches an error listener to %s so a dropped idle connection cannot crash the process",
    (pool) => {
      expect(entrypoint).toMatch(new RegExp(String.raw`guardPgPoolErrors\(${pool},`));
    }
  );

  it("no longer rotates BYOK credential keys at boot", () => {
    // BYOK provider keys were removed with the local-first runtime; nothing re-encrypts them.
    expect(entrypoint).not.toContain("rotateCredentialKeys");
    expect(entrypoint).not.toContain("inference_key_rotation");
  });

  it("keeps refreshing inference providers in the background after the boot retries run out", () => {
    expect(entrypoint).toMatch(
      /retryInBackground\(\s*"inference_refresh",\s*\(\)\s*=>\s*inferencePlatform\.refresh\(\)/
    );
    expect(entrypoint).toMatch(
      /onClose", async \(\) => \{\s*backgroundRetriesStopped = true;\s*stopInferenceRefreshRetry\?\.\(\);/
    );
    // The fallback refuses to start once shutdown has begun.
    expect(entrypoint.match(/if \(backgroundRetriesStopped\) return;/g)).toHaveLength(1);
  });
});
