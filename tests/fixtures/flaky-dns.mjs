// Preloaded (`node --import`) into an API child process by tests/api-boot-database-retry.test.ts.
// Makes lookups of FLAKY_DNS_HOST fail with EAI_AGAIN, the error a flaky hotspot resolver returns:
// after FLAKY_DNS_SKIP successful lookups (default 0), the next FLAKY_DNS_FAILURES lookups fail
// (default: all of them), and the rest resolve to FLAKY_DNS_ADDRESS. Each injected failure is reported on stderr as `[flaky-dns] EAI_AGAIN`.
import dns from "node:dns";
import net from "node:net";

const host = process.env.FLAKY_DNS_HOST;
const address = process.env.FLAKY_DNS_ADDRESS ?? "127.0.0.1";
let remaining = Number(process.env.FLAKY_DNS_FAILURES ?? Number.POSITIVE_INFINITY);
let skip = Number(process.env.FLAKY_DNS_SKIP ?? 0);
if (Number.isNaN(remaining) || Number.isNaN(skip)) {
  throw new Error("FLAKY_DNS_FAILURES and FLAKY_DNS_SKIP must be numbers.");
}
const originalLookup = dns.lookup;

dns.lookup = function lookup(hostname, options, callback, ...rest) {
  const done = typeof options === "function" ? options : callback;
  const settings = typeof options === "object" && options !== null ? options : {};
  if (host === undefined || hostname !== host) {
    return originalLookup.call(this, hostname, options, callback, ...rest);
  }
  if (skip > 0) {
    skip -= 1;
  } else if (remaining > 0) {
    remaining -= 1;
    process.stderr.write(`[flaky-dns] EAI_AGAIN ${hostname}\n`);
    const error = Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), {
      code: "EAI_AGAIN",
      errno: -3001,
      syscall: "getaddrinfo",
      hostname
    });
    return process.nextTick(done, error);
  }
  if (net.isIP(address) === 0) {
    // A hostname target (e.g. a hosted test database) resolves for real once the flake is over.
    return originalLookup.call(this, address, options, callback);
  }
  const family = net.isIP(address);
  if (settings.all) {
    return process.nextTick(done, null, [{ address, family }]);
  }
  return process.nextTick(done, null, address, family);
};
