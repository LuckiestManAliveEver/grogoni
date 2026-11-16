import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { LinkedDriver } from "../connector.js";
import { LinkedSessionVault } from "../vault.js";
import { SidecarHost } from "./host.js";
import { LoopbackServer } from "./loopback.js";
import { sidecarProtocolVersion, validToken } from "./protocol.js";

/**
 * Start-up contract with the Android service (SidecarProcess.kt):
 *
 * 1. The app spawns the sidecar and writes exactly one JSON line to its stdin:
 *    `{"protocol":1,"token":<64 hex>,"key":<64 hex>,"vaultDir":<absolute>,"ownerId":<id>}`.
 *    The vault key is unwrapped from Android Keystore in memory and exists only in that pipe and
 *    in this process. It is never in argv or the environment (both are readable through /proc
 *    by the same uid's tools and crash reporters) and never on disk.
 * 2. The sidecar answers with one stdout line `{"type":"ready","port":<n>,"node":<version>}`.
 * 3. stdin stays open. EOF means the app process died: the sidecar stops and exits, so it never
 *    outlives the app that owns its token.
 */
export interface SidecarConfig {
  token: string;
  key: Buffer;
  vaultDir: string;
  ownerId: string;
}

export function parseSidecarConfig(line: string): SidecarConfig {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error("Sidecar configuration is not JSON.");
  }
  if (value.protocol !== sidecarProtocolVersion) throw new Error("Unsupported sidecar protocol.");
  if (typeof value.token !== "string" || !validToken(value.token))
    throw new Error("Sidecar token must be 64 lowercase hex digits.");
  if (typeof value.key !== "string" || !/^[0-9a-f]{64}$/.test(value.key))
    throw new Error("Sidecar vault key must be 64 lowercase hex digits.");
  if (value.key === value.token) throw new Error("Token and vault key must differ.");
  if (typeof value.vaultDir !== "string" || !isAbsolute(value.vaultDir))
    throw new Error("Sidecar vault directory must be absolute.");
  if (typeof value.ownerId !== "string" || !/^[A-Za-z0-9_:.-]{1,128}$/.test(value.ownerId))
    throw new Error("Sidecar owner id is invalid.");
  return {
    token: value.token,
    key: Buffer.from(value.key, "hex"),
    vaultDir: value.vaultDir,
    ownerId: value.ownerId
  };
}

/** Reads the first line of a stream without consuming more than it needs to decide. */
function firstLine(input: Readable, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", reject);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index >= 0) {
        cleanup();
        input.pause();
        resolve(buffer.slice(0, index));
      } else if (buffer.length > limit) {
        cleanup();
        reject(new Error("Sidecar configuration is too long."));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("Sidecar configuration was not provided."));
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", reject);
  });
}

export interface SidecarHandle {
  port: number;
  host: SidecarHost;
  /** Resolves once the sidecar has fully stopped (shutdown request, stdin EOF or stop()). */
  done: Promise<void>;
  stop(): Promise<void>;
}

export async function runSidecar(options: {
  input: Readable;
  output: Writable;
  driver: LinkedDriver;
  probe?: () => Promise<Record<string, unknown>>;
  recoveryMs?: number;
  ackTimeoutMs?: number;
}): Promise<SidecarHandle> {
  const config = parseSidecarConfig(await firstLine(options.input));
  // The cipher keeps a reference to this Buffer, so it must not be zeroed here.
  const vault = new LinkedSessionVault(config.vaultDir, config.key);
  // Decrypting the index proves the key before anything else runs: a wrong key throws here
  // and the sidecar exits without touching the records. A vault holding another owner's session
  // is refused too. The connector's authorization sweep would otherwise erase that session.
  const index = JSON.parse(vault.read("$index") ?? "{}") as Record<string, string>;
  if (Object.values(index).some((owner) => owner !== config.ownerId))
    throw new Error("This WhatsApp vault belongs to another Grogoni account.");
  let stopping: Promise<void> | undefined;
  let finished: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const server: LoopbackServer = new LoopbackServer({
    token: config.token,
    ...(options.ackTimeoutMs ? { ackTimeoutMs: options.ackTimeoutMs } : {}),
    handle: async (method, params): Promise<unknown> => {
      if (method === "shutdown") {
        setImmediate(() => void stop());
        return { stopping: true };
      }
      // Requests arrive only after listen(), by which time `host` is initialised.
      return host.handle(method, params);
    }
  });
  const host: SidecarHost = new SidecarHost({
    vault,
    driver: options.driver,
    enrollment: { ownerId: config.ownerId },
    relay: server,
    ...(options.probe ? { probe: options.probe } : {}),
    ...(options.recoveryMs ? { recoveryMs: options.recoveryMs } : {})
  });
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await host.stop();
      } finally {
        await server.close();
        finished();
      }
    })());
  const port = await server.listen();
  options.output.write(
    `${JSON.stringify({ type: "ready", port, node: process.version, protocol: sidecarProtocolVersion })}\n`
  );
  options.input.resume();
  options.input.on("data", () => undefined);
  options.input.once("end", () => void stop());
  options.input.once("close", () => void stop());
  // Restoration may open sockets; it never blocks readiness.
  void host.restore().catch(() => undefined);
  return { port, host, done, stop };
}
