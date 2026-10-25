import { describe, expect, it, vi } from "vitest";
import {
  createGuestIntentClassifier,
  type GuestIntentClassifier,
  type GuestIntentOutcome
} from "./classifier.js";
import { createMemoryGuestIntentLimiter, guestIntentRateKey } from "./rate-limit.js";
import {
  createEdgeGuestIntentRoutes,
  createGuestIntentService,
  guestIntentMinModelWindowMs,
  guestIntentRequestDeadlineMs,
  readGuestIntentConfiguration,
  type GuestIntentLogLine
} from "./service.js";

function fakeClassifier(outcome: GuestIntentOutcome): GuestIntentClassifier {
  return { modelId: "gpt-6-luna", timeoutMs: 4_000, classify: vi.fn(async () => outcome) };
}

const searchSugar: GuestIntentOutcome = {
  ok: true,
  intent: "search",
  query: "sugar",
  modelId: "gpt-6-luna",
  latencyMs: 321
};

function service(outcome: GuestIntentOutcome | null, max = 20) {
  const lines: GuestIntentLogLine[] = [];
  const classifier = outcome === null ? null : fakeClassifier(outcome);
  return {
    lines,
    classifier,
    service: createGuestIntentService({
      classifier,
      limiter: createMemoryGuestIntentLimiter({ max, windowMs: 60_000 }, () => 1_000),
      report: (line) => lines.push(line)
    })
  };
}

const session = { sessionId: "session-1" };

describe("guest intent service", () => {
  it("answers the model's intent and logs it as a model decision", async () => {
    const { service: subject, lines } = service(searchSugar);
    const reply = await subject.handle({ session, body: { message: "do you have sugar" } });
    expect(reply).toEqual({
      status: 200,
      body: { intent: "search", query: "sugar", modelId: "gpt-6-luna", latencyMs: 321 }
    });
    expect(lines).toEqual([
      {
        event: "guest_intent_classified",
        source: "model",
        intent: "search",
        reason: null,
        latencyMs: 321,
        modelId: "gpt-6-luna"
      }
    ]);
  });

  it("requires a session and never calls the model without one", async () => {
    const { service: subject, classifier } = service(searchSugar);
    expect((await subject.handle({ session: null, body: { message: "sugar" } })).status).toBe(401);
    expect(classifier!.classify).not.toHaveBeenCalled();
  });

  it.each([null, "sugar", [], {}, { message: 4 }, { message: "   " }])(
    "refuses the body %j",
    async (body) => {
      const { service: subject, classifier } = service(searchSugar);
      const reply = await subject.handle({ session, body });
      expect(reply.status).toBe(400);
      expect(classifier!.classify).not.toHaveBeenCalled();
    }
  );

  it("refuses a message over 500 characters before the model", async () => {
    const { service: subject, classifier, lines } = service(searchSugar);
    const reply = await subject.handle({ session, body: { message: "a".repeat(501) } });
    expect(reply).toMatchObject({ status: 413, body: { code: "message_too_long" } });
    expect(classifier!.classify).not.toHaveBeenCalled();
    expect(lines[0]).toMatchObject({ source: "rules", reason: "message_too_long" });
    expect((await subject.handle({ session, body: { message: "a".repeat(500) } })).status).toBe(
      200
    );
  });

  it("answers 503 at once when no model is configured", async () => {
    const { service: subject, lines } = service(null);
    const reply = await subject.handle({ session, body: { message: "sugar" } });
    expect(reply).toMatchObject({ status: 503, body: { code: "guest_intent_unavailable" } });
    expect(lines[0]).toMatchObject({ source: "rules", reason: "unavailable" });
  });

  it("answers 503 and logs a rules fallback when the model fails", async () => {
    const { service: subject, lines } = service({
      ok: false,
      reason: "model_timeout",
      latencyMs: 2_500
    });
    const reply = await subject.handle({ session, body: { message: "sugar" } });
    expect(reply).toMatchObject({ status: 503, body: { code: "guest_intent_failed" } });
    expect(lines[0]).toMatchObject({ source: "rules", reason: "model_timeout", latencyMs: 2_500 });
  });

  it("limits each session separately and says when to retry", async () => {
    const { service: subject, classifier } = service(searchSugar, 3);
    const send = (sessionId: string) =>
      subject.handle({ session: { sessionId }, body: { message: "sugar" } });
    for (let call = 0; call < 3; call++) expect((await send("a")).status).toBe(200);
    const refused = await send("a");
    expect(refused).toMatchObject({ status: 429, body: { code: "rate_limited" } });
    expect(refused.headers?.["retry-after"]).toBe("59");
    expect((await send("b")).status).toBe(200);
    expect(classifier!.classify).toHaveBeenCalledTimes(4);
  });
});

describe("memory guest intent limiter", () => {
  it("opens a new window when the old one ends", async () => {
    let now = 0;
    const limiter = createMemoryGuestIntentLimiter({ max: 1, windowMs: 1_000 }, () => now);
    expect((await limiter.consume("s")).allowed).toBe(true);
    expect((await limiter.consume("s")).allowed).toBe(false);
    now = 1_000;
    expect((await limiter.consume("s")).allowed).toBe(true);
  });

  it("keys the counter by a digest, never the session ID itself", () => {
    expect(guestIntentRateKey("secret-session")).toMatch(/^guest-intent:[0-9a-f]{32}$/u);
    expect(guestIntentRateKey("secret-session")).not.toContain("secret");
  });
});

describe("edge guest intent route", () => {
  const routes = (
    findSession = vi.fn<(request: Request) => Promise<{ sessionId: string } | null>>(
      async () => session
    )
  ) => {
    const { service: subject, classifier } = service(searchSugar);
    return {
      handle: createEdgeGuestIntentRoutes({ service: subject, findSession }),
      classifier,
      findSession
    };
  };
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://edge.test/v1/guest/intent", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body
    });

  it("serves only its own path", async () => {
    const { handle } = routes();
    expect(await handle(post("{}"), "/v1/guest/other")).toBeNull();
  });

  it("classifies a posted message without caching the answer", async () => {
    const { handle } = routes();
    const response = await handle(post('{"message":"sugar"}'), "/v1/guest/intent");
    expect(response!.status).toBe(200);
    expect(response!.headers.get("cache-control")).toBe("no-store");
    expect(await response!.json()).toMatchObject({ intent: "search", query: "sugar" });
  });

  it("refuses other methods, bad JSON and oversized bodies", async () => {
    const { handle, classifier } = routes();
    expect(
      (await handle(new Request("https://edge.test/v1/guest/intent"), "/v1/guest/intent"))!.status
    ).toBe(405);
    expect((await handle(post("{not json"), "/v1/guest/intent"))!.status).toBe(400);
    expect(
      (await handle(post(JSON.stringify({ message: "a".repeat(9_000) })), "/v1/guest/intent"))!
        .status
    ).toBe(413);
    expect(classifier!.classify).not.toHaveBeenCalled();
  });

  it("answers 401 when the session lookup finds no one", async () => {
    const { handle } = routes(vi.fn(async () => null));
    expect((await handle(post('{"message":"sugar"}'), "/v1/guest/intent"))!.status).toBe(401);
  });
});

describe("guest intent configuration", () => {
  it("uses the platform default model through OpenRouter when a key is set", () => {
    const configuration = readGuestIntentConfiguration({ OPENROUTER_API_KEY: "test-key" });
    expect(configuration.disabledReason).toBeNull();
    expect(configuration.classifier?.modelId).toBe("gpt-6-luna");
    expect(configuration.ratePolicy).toEqual({ max: 20, windowMs: 60_000 });
  });

  it("honours PLATFORM_DEFAULT_MODEL_ID and refuses one OPENROUTER_MODELS does not map", () => {
    expect(
      readGuestIntentConfiguration({
        OPENROUTER_API_KEY: "k",
        PLATFORM_DEFAULT_MODEL_ID: "other",
        OPENROUTER_MODELS: '{"other":"vendor/other"}'
      }).classifier?.modelId
    ).toBe("other");
    expect(
      readGuestIntentConfiguration({ OPENROUTER_API_KEY: "k", PLATFORM_DEFAULT_MODEL_ID: "nope" })
        .disabledReason
    ).toMatch(/not mapped/u);
  });

  it("is off without a key or when disabled", () => {
    expect(readGuestIntentConfiguration({}).classifier).toBeNull();
    expect(
      readGuestIntentConfiguration({ OPENROUTER_API_KEY: "k", GUEST_INTENT_ENABLED: "false" })
        .classifier
    ).toBeNull();
  });

  it("refuses a model timeout past the client's budget and a bad rate limit", () => {
    expect(() =>
      readGuestIntentConfiguration({
        OPENROUTER_API_KEY: "k",
        GUEST_INTENT_MODEL_TIMEOUT_MS: "5000"
      })
    ).toThrow();
    expect(() =>
      readGuestIntentConfiguration({ GUEST_INTENT_RATE_LIMIT_PER_MINUTE: "0" })
    ).toThrow();
    expect(
      readGuestIntentConfiguration({ GUEST_INTENT_RATE_LIMIT_PER_MINUTE: "5" }).ratePolicy.max
    ).toBe(5);
  });
});

describe("guest intent request deadline", () => {
  const post = (message: string) =>
    new Request("https://api.test/v1/guest/intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message })
    });

  it("commits the session transaction before the model is called (as index.ts wires it)", async () => {
    const order: string[] = [];
    // index.ts: findSession = (request) => transaction((client) => findSessionUser(client, request))
    const transaction = async <T>(work: () => Promise<T>) => {
      order.push("begin");
      const result = await work();
      order.push("commit");
      return result;
    };
    const routes = createEdgeGuestIntentRoutes({
      service: createGuestIntentService({
        classifier: createGuestIntentClassifier({
          modelId: "gpt-6-luna",
          complete: async () => {
            order.push("model");
            return { text: '{"intent":"search","query":"rice"}', modelId: "gpt-6-luna" };
          }
        }),
        limiter: createMemoryGuestIntentLimiter(),
        report: () => undefined
      }),
      findSession: () => transaction(async () => ({ sessionId: "s1" }))
    });
    const response = await routes(post("rice please"), "/v1/guest/intent");
    expect(response?.status).toBe(200);
    expect(order).toEqual(["begin", "commit", "model"]);
  });

  it("counts a slow session lookup against the deadline and skips the model when too little is left", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { service: subject, classifier, lines } = service(searchSugar);
      const routes = createEdgeGuestIntentRoutes({
        service: subject,
        // A cold isolate or a busy pool: the lookup alone took most of the budget.
        findSession: async () => {
          vi.setSystemTime(
            Date.now() + guestIntentRequestDeadlineMs - guestIntentMinModelWindowMs + 1
          );
          return session;
        }
      });
      const response = await routes(post("sugar"), "/v1/guest/intent");
      expect(response?.status).toBe(503);
      expect(classifier!.classify).not.toHaveBeenCalled();
      expect(lines).toEqual([expect.objectContaining({ source: "rules", reason: "deadline" })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the model only what is left of the deadline", async () => {
    let clock = 10_000;
    const { classifier } = service(searchSugar);
    const subject = createGuestIntentService({
      classifier,
      limiter: createMemoryGuestIntentLimiter(),
      report: () => undefined,
      now: () => clock
    });
    clock += 2_200;
    await subject.handle({ session, body: { message: "sugar" }, startedAt: 10_000 });
    expect(classifier!.classify).toHaveBeenCalledWith(
      "sugar",
      undefined,
      guestIntentRequestDeadlineMs - 2_200
    );
  });
});
