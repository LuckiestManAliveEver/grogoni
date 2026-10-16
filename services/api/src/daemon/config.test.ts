import { describe, expect, it } from "vitest";
import { readDaemonNetworkConfig } from "./config.js";

describe("native daemon network configuration", () => {
  it("uses a host's PORT, with an explicit daemon override and safe local defaults", () => {
    expect(readDaemonNetworkConfig({})).toEqual({ port: 42700, host: "127.0.0.1", pollMs: 1000 });
    expect(
      readDaemonNetworkConfig({ PORT: "8080", DAEMON_HOST: "0.0.0.0", DAEMON_POLL_MS: "10000" })
    ).toEqual({ port: 8080, host: "0.0.0.0", pollMs: 10000 });
    expect(readDaemonNetworkConfig({ PORT: "invalid", DAEMON_PORT: "9000" }).port).toBe(9000);
    expect(readDaemonNetworkConfig({ PORT: "8080", DAEMON_PORT: " " }).port).toBe(8080);
    // Blank means default: "DAEMON_HOST=" must never bind all interfaces.
    expect(readDaemonNetworkConfig({ DAEMON_HOST: " " }).host).toBe("127.0.0.1");
  });
  it("rejects invalid polling and port settings", () => {
    for (const value of ["0", "249", "60001", "NaN", "1e3", "0x1000"])
      expect(() => readDaemonNetworkConfig({ DAEMON_POLL_MS: value })).toThrow("DAEMON_POLL_MS");
    expect(() => readDaemonNetworkConfig({ PORT: "65536" })).toThrow("PORT");
  });
});
