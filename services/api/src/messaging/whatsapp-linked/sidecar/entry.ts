import { createBaileysLinkedDriver } from "../baileys-driver.js";
import { runSidecar } from "./main.js";

/**
 * Bundled entry for the Android sidecar (apps/android/scripts/build-whatsapp-sidecar.mjs).
 * Output on stdout is protocol only. stderr carries one-word diagnostic codes, never message
 * text, phone numbers, pairing codes or credentials.
 */
const fatal = (code: string, error?: unknown) => {
  process.stderr.write(`sidecar_${code}${error instanceof Error ? `: ${error.name}` : ""}\n`);
  process.exit(70);
};
process.on("uncaughtException", (error) => fatal("uncaught", error));
process.on("unhandledRejection", (error) => fatal("unhandled_rejection", error));

try {
  const sidecar = await runSidecar({
    input: process.stdin,
    output: process.stdout,
    driver: createBaileysLinkedDriver(),
    probe: async () => {
      // Loads the protocol stack (protobuf schema, libsignal, Rust/WASM bridge) and generates
      // fresh device keys, all without a network connection.
      const baileys = await import("baileys");
      const creds = baileys.initAuthCreds();
      return {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        protocolLoaded: typeof baileys.default === "function",
        keyGeneration: creds.signedIdentityKey.public.length === 32,
        rssBytes: process.memoryUsage().rss
      };
    }
  });
  const exit = () => void sidecar.stop();
  process.once("SIGTERM", exit);
  process.once("SIGINT", exit);
  await sidecar.done;
  process.exit(0);
} catch (error) {
  fatal("start_failed", error);
}
