# API boot fails on a flaky database lookup

## Symptom

- `pnpm dev:local` (or a deploy) dies during boot with
  `Error: getaddrinfo EAI_AGAIN <host>.neon.tech`, usually from `assertInferenceSchema`,
  `assertFulfillmentSchema` or the CP2 snapshot load, before `Server listening` appears.
- `pnpm db:health` succeeds moments earlier or later, so the database itself is up.
- Typical on a phone hotspot or a congested Wi-Fi network: `/etc/resolv.conf` points at the
  hotspot gateway (for example `nameserver 172.26.215.28`) and `systemd-resolved` is inactive, so
  every lookup goes to an unreliable DNS proxy with no local cache.

## What the API does now

Each boot-time database step runs through `retryDatabaseStartup`
(`services/api/src/db-startup-retry.ts`). Steps, in order: `inference_schema`, then
`inference_refresh` (loads the DB-configured inference providers; if it still fails after its
retries, boot continues without them, logs `inference.provider_refresh_failed`, and keeps
retrying the refresh in the background (full-jitter backoff from 5 s, capped at 60 s) until it
succeeds, logging
`db.background_retry` per failure and `db.startup_recovered` with `"background": true` on
success), then
`cp2_store` with `fulfillment_schema` running alongside it.

Transient failures are retried with full-jitter exponential backoff, 6 attempts per step (500 ms
doubling, capped at 8 s):

- resolver and socket codes: `EAI_AGAIN`, `ECONNREFUSED`, `ECONNRESET`, `ECONNABORTED`,
  `EHOSTUNREACH`, `ENETDOWN`, `ENETUNREACH`, `EPIPE`, `ETIMEDOUT`
- PostgreSQL SQLSTATEs `08000`, `08001`, `08003`, `08006` (connection lost or not established),
  `57P01`, `57P02` (server shut down or restarted), `57P03` (Neon compute still
  waking), `53300` (too many connections)
- these messages, whatever their code: node-postgres connect timeouts,
  `Connection terminated unexpectedly`, `Query read timeout`; PgBouncer's transient errors (sent
  as `08P01` by Neon's `-pooler` endpoint): `query_wait_timeout`, `query_timeout`,
  `no more connections allowed`, `client connections exceeded`, `server shutting down`,
  `pooler is shutting down`, `client_login_timeout (server down)` and `(server_login_retry)`; and
  Neon's proxy `Couldn't connect to compute node` and
  `Failed to acquire permit to connect to the database` (`XX000`)

`(server_login_retry)` is PgBouncer replaying a cached server-login failure
(`server login has been failing, cached error: <cause> (server_login_retry)`). The cause is almost
always the pooler failing to resolve or reach Postgres, so it is retried, unless the cached cause is
an authentication failure or an unknown database, which fails fast.

`Query read timeout` is retried because a network stall mid-query looks the same. A query that is
always slower than `DB_QUERY_TIMEOUT_MS` (for example a snapshot load on a very large database)
therefore costs the full retry window before failing; raise `DB_QUERY_TIMEOUT_MS` for that, not the
attempt count.

Everything else fails on the first attempt: `ENOTFOUND` (a wrong hostname), `08004` (connection
rejected), any other `08P01` or `XX000` (protocol errors, unknown database, disabled endpoint,
cached authentication or unknown-database causes), TLS
certificate errors, authentication errors, missing tables and migration mismatches still surface
immediately.

### Time to a real failure

When the network stays down, a failing boot now takes longer to report it. Per step:

- Backoff between attempts adds up to 15.5 s (0.5 + 1 + 2 + 4 + 8), about 8 s on average.
- An attempt that fails fast (a resolver answering `EAI_AGAIN`, a refused connection) costs almost
  nothing, so the step gives up after at most about 15.5 s. Local development with Postgres not
  running (`ECONNREFUSED`) therefore reports the error after up to 15.5 s instead of instantly. A
  resolver that times out instead of answering is the hanging case below: pg gives up after
  `DB_CONNECTION_TIMEOUT_MS` and the attempt is retried.
- An attempt can also hang: up to `DB_CONNECTION_TIMEOUT_MS` (5 s) to connect, then, if the
  connection opened and the network black-holes, up to `DB_QUERY_TIMEOUT_MS` (15 s) before
  `Query read timeout`. That is about 20 s per stall, which ends the attempt; queries that are
  slow but succeed before it (a `cp2_store` attempt runs several in sequence) can stretch an attempt
  further. Roughly 20 s per attempt and about 135 s per step
  (6 x 20 s + 15.5 s) in the worst case.

A lasting outage exhausts `inference_schema` first and stops boot there, so the worst case for a
boot that fails is about the same 135 s. A network that drops right after `inference_schema`
passes costs the later windows in turn: `inference_refresh` (up to about 135 s, after which boot
continues and the refresh retries in the background) and then `cp2_store`, about 270 s. The theoretical
maximum, about 405 s, needs `inference_schema` itself to use almost all of its attempts before
succeeding and the network to stay bad through both later steps. Size platform boot and
health-check grace periods with that in mind, or lower `DB_STARTUP_MAX_ATTEMPTS`. To fail fast
while debugging, set `DB_STARTUP_MAX_ATTEMPTS=1`.

### Background recovery

Two boot tasks may finish after startup instead of blocking it: the inference provider refresh
(after its startup retries) and the BYOK credential key rotation (never retried at boot, it runs
off the boot path). If either still fails, it is retried in the background with full-jitter
backoff from 5 s, capped at 60 s, until it succeeds, logging one JSON line per failure:

```json
{
  "event": "db.background_retry",
  "step": "inference_key_rotation",
  "attempt": 1,
  "code": "EAI_AGAIN",
  "delayMs": 7310
}
```

and `{"event":"db.startup_recovered","step":"...","failedAttempts":N,"background":true}` on
success. The background loop retries every error, not only transient ones, so a step that fails
for another reason (for example a migration applied while the API runs) still recovers; a
permanent failure keeps logging `db.background_retry` lines: once the backoff is capped, the delay
is drawn uniformly between 0 and 60 s, so about one line every 30 s on average and never more than 60 s
apart plus the attempt's own duration (up to about 20 s when it hangs), and occasionally two close
together. Alert on the line repeating, not on its rate. Both loops stop
when the server shuts down.

### Logs

Each retry prints one JSON line, and a step that needed retries prints a recovery line:

```json
{"event":"db.startup_retry","step":"inference_schema","attempt":1,"maxAttempts":6,"code":"EAI_AGAIN","delayMs":412}
{"event":"db.startup_recovered","step":"inference_schema","failedAttempts":1}
```

`DB_STARTUP_MAX_ATTEMPTS` (default `6`) changes the attempt count. `1` disables retries.

### Tests

- `services/api/src/db-startup-retry.test.ts`: classifier and retry behavior; with
  `CP2_POSTGRES_TEST_DATABASE_URL` set, also proves a failed `createPostgresCp2Store` attempt closes
  every pool it opened, so retries leak no connections. Also covers the background refresh retry
  (capped backoff, recovery, stop on shutdown, including while an attempt is in flight).
- `tests/api-boot-database-retry.test.ts`: boots the real entrypoint with
  `tests/fixtures/flaky-dns.mjs` injecting `EAI_AGAIN`. Always on: boot retries `inference_schema`
  before failing, and static checks pin that all four steps are wrapped, the background retries for the provider refresh and
  the key rotation and their shutdown stop, and the pool `error` listeners. With
  `CP2_POSTGRES_TEST_DATABASE_URL` set (picked up by `pnpm test:postgres`): boot recovers from a
  flake on `inference_schema`; from one that starts after it and hits `inference_refresh`,
  `cp2_store` and `fulfillment_schema`; and the booted API survives Postgres terminating its idle
  connections.

## If boot still fails after the retries

The network is down for longer than the retry window. Fix the resolver instead of raising the
attempt count:

```bash
nmcli con mod "<connection name>" ipv4.dns "1.1.1.1 8.8.8.8" ipv4.ignore-auto-dns yes
nmcli con up "<connection name>"
for i in $(seq 20); do getent ahostsv4 <host>.neon.tech >/dev/null && echo ok || echo FAIL; done
```

Undo with `nmcli con mod "<connection name>" ipv4.dns "" ipv4.ignore-auto-dns no`.

## Scope

Only boot is retried. A lookup failure after boot fails that one request or save; the CP2
persistence queue already retries saves with backoff, and the process keeps running. Every pool,
including `inference` and `fulfillment`, has an `error` listener, so a dropped idle connection (a
network reset, a Neon compute restart) is logged as `Unexpected PostgreSQL ... pool error.`
instead of crashing the process.
