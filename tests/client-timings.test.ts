import { describe, expect, it, vi } from "vitest";
import {
  clientTimingMaxMs,
  clientTimingsMaxBytes,
  clientTimingsMaxEntries,
  createClientTimingsRoute,
  parseClientTimings
} from "../supabase/functions/api/client-timings";
import {
  clientTimingsBatchSize,
  reportedTimingNames,
  startClientTimings
} from "../apps/web/src/messaging/client-timings";
import { clientTimingNames } from "../supabase/functions/api/client-timings";

// Send and reply timings measured on real phones: the web app beacons its performance measures,
// the Edge API logs one `client_timing` line each. Nothing stored, never message text.

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://grogoni.com/v1/client-timings", { method: "POST", body, headers });

describe("client timing lines (Edge)", () => {
  it("keeps known measures with a duration, a random id and the network class only", () => {
    expect(
      parseClientTimings({
        timings: [
          {
            name: "message.send.ack_ms",
            ms: 812.6,
            clientMessageId: "message-3f2c",
            network: "3g",
            text: "my secret message",
            accountId: "acc-1"
          },
          { name: "agent.turn.reply_ms", ms: 4200, clientMessageId: "bad id with spaces" },
          { name: "message.send.accepted_ms", ms: 4, network: "wifi" }
        ]
      })
    ).toEqual([
      {
        event: "client_timing",
        name: "message.send.ack_ms",
        ms: 813,
        clientMessageId: "message-3f2c",
        network: "3g"
      },
      {
        event: "client_timing",
        name: "agent.turn.reply_ms",
        ms: 4200,
        clientMessageId: null,
        network: null
      },
      {
        event: "client_timing",
        name: "message.send.accepted_ms",
        ms: 4,
        clientMessageId: null,
        network: null
      }
    ]);
  });

  it.each([
    [{ name: "page.load_ms", ms: 10 }],
    [{ name: "message.send.ack_ms", ms: -1 }],
    [{ name: "message.send.ack_ms", ms: clientTimingMaxMs + 1 }],
    [{ name: "message.send.ack_ms", ms: "12" }],
    [{ name: "message.send.ack_ms", ms: Number.NaN }],
    [null]
  ])("drops %j", (entry) => {
    expect(parseClientTimings({ timings: [entry] })).toEqual([]);
  });

  it("reads at most 30 entries a beacon", () => {
    const timings = Array.from({ length: 50 }, () => ({ name: "message.send.ack_ms", ms: 1 }));
    expect(parseClientTimings({ timings })).toHaveLength(clientTimingsMaxEntries);
    expect(parseClientTimings({})).toEqual([]);
  });

  it("logs each line and answers 204, without a database", async () => {
    const log = vi.fn();
    const route = createClientTimingsRoute({ log });
    const response = await route(
      post(JSON.stringify({ timings: [{ name: "message.send.ack_ms", ms: 900 }] })),
      "/v1/client-timings"
    );
    expect(response?.status).toBe(204);
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: "client_timing", name: "message.send.ack_ms", ms: 900 })
    ]);
  });

  it("refuses oversized and malformed bodies, and ignores other paths and methods", async () => {
    const log = vi.fn();
    const route = createClientTimingsRoute({ log });
    expect(
      (await route(post("x".repeat(clientTimingsMaxBytes + 1)), "/v1/client-timings"))?.status
    ).toBe(413);
    expect(
      (
        await route(
          post("{}", { "content-length": String(clientTimingsMaxBytes + 1) }),
          "/v1/client-timings"
        )
      )?.status
    ).toBe(413);
    expect((await route(post("{not json"), "/v1/client-timings"))?.status).toBe(400);
    expect(await route(post("{}"), "/v1/other")).toBeNull();
    expect(
      await route(new Request("https://grogoni.com/v1/client-timings"), "/v1/client-timings")
    ).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it("caps its log lines per minute, and starts again in the next minute", async () => {
    const log = vi.fn();
    let now = 0;
    const route = createClientTimingsRoute({ log, now: () => now, perMinute: 3 });
    const beacon = () =>
      route(
        post(
          JSON.stringify({
            timings: Array.from({ length: 2 }, () => ({ name: "message.send.ack_ms", ms: 1 }))
          })
        ),
        "/v1/client-timings"
      );
    expect((await beacon())?.status).toBe(204);
    expect((await beacon())?.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(3);
    now = 60_000;
    await beacon();
    expect(log).toHaveBeenCalledTimes(5);
  });

  it("the web app reports exactly the measures the Edge API accepts", () => {
    expect([...reportedTimingNames].sort()).toEqual([...clientTimingNames].sort());
  });
});

describe("client timing reporter (web)", () => {
  function fakeEnvironment(network?: string) {
    let onEntry!: (entry: { name: string; duration: number; detail?: unknown }) => void;
    let onHidden!: () => void;
    const sent: unknown[] = [];
    const flush = startClientTimings({
      observe: (callback) => {
        onEntry = callback;
      },
      network: () => network,
      send: (body) => {
        sent.push(JSON.parse(body));
        return true;
      },
      onHidden: (callback) => {
        onHidden = callback;
      }
    });
    return {
      entry: (e: Parameters<typeof onEntry>[0]) => onEntry(e),
      hide: () => onHidden(),
      sent,
      flush
    };
  }

  it("sends what waited when the page is hidden, with the message id and network", () => {
    const env = fakeEnvironment("3g");
    env.entry({
      name: "message.send.ack_ms",
      duration: 812.4,
      detail: { clientMessageId: "message-1" }
    });
    env.entry({ name: "some.other.measure", duration: 5 });
    expect(env.sent).toEqual([]);
    env.hide();
    expect(env.sent).toEqual([
      {
        timings: [
          { name: "message.send.ack_ms", ms: 812, clientMessageId: "message-1", network: "3g" }
        ]
      }
    ]);
    env.hide();
    expect(env.sent).toHaveLength(1);
  });

  it("sends a full batch without waiting for the page to hide", () => {
    const env = fakeEnvironment();
    for (let index = 0; index < clientTimingsBatchSize; index += 1)
      env.entry({ name: "agent.turn.reply_ms", duration: 1000 + index });
    expect(env.sent).toHaveLength(1);
    expect((env.sent[0] as { timings: unknown[] }).timings).toHaveLength(clientTimingsBatchSize);
    expect((env.sent[0] as { timings: Array<Record<string, unknown>> }).timings[0]).toEqual({
      name: "agent.turn.reply_ms",
      ms: 1000
    });
  });
});
