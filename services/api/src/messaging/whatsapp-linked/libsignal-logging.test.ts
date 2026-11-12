import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

interface Session {
  indexInfo: { closed: number; used: number };
  privateSessionMaterial: string;
}

describe("installed Signal dependency logging", () => {
  it("never logs session material when closing, reopening or pruning sessions", () => {
    const require = createRequire(import.meta.url);
    const protocolRequire = createRequire(require.resolve("baileys"));
    const { SessionRecord } = protocolRequire("libsignal") as {
      SessionRecord: new () => {
        sessions: Record<string, Session>;
        closeSession: (session: Session) => void;
        openSession: (session: Session) => void;
        removeOldSessions: () => void;
      };
    };
    const spies = ["info", "warn", "error", "log"].map((method) =>
      vi.spyOn(console, method as "info").mockImplementation(() => undefined)
    );
    try {
      const record = new SessionRecord();
      const session = {
        indexInfo: { closed: -1, used: 1 },
        privateSessionMaterial: "SECRET_CANARY"
      };
      record.closeSession(session);
      record.closeSession(session);
      record.openSession(session);
      record.openSession(session);
      for (let index = 0; index < 45; index++)
        record.sessions[String(index)] = {
          indexInfo: { closed: 1, used: index },
          privateSessionMaterial: "SECRET_CANARY"
        };
      record.removeOldSessions();
      expect(Object.keys(record.sessions)).toHaveLength(40);
      expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
