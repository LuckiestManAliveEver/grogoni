import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Cp2Store } from "../store.js";
import {
  createVoiceRateLimiter,
  registerVoiceRoutes,
  voiceSpeakPath,
  voiceTranscribePath
} from "./voice-routes.js";
import { normalizeWords, wordErrorRate } from "./word-error-rate.js";
import {
  createVoiceServices,
  defaultVoiceSpeechModel,
  defaultVoiceTranscriptionModel,
  parseSpeechRequest,
  parseTranscriptionRequest,
  voiceAudioFormat,
  voiceDictationMaxBytes,
  voiceSpeechMaxCharacters,
  type VoiceServices
} from "./voice-speech.js";

const key = "sk-or-server-secret";
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
const mp3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 9]);

function wav(seconds: number): Buffer {
  const byteRate = 1000;
  const data = Buffer.alloc(Math.round(seconds * byteRate));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(500, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function provider(answer: (url: string) => Response) {
  return vi.fn<typeof fetch>(async (url) => answer(String(url)));
}

const defaultAnswer = (url: string) =>
  url.endsWith("/audio/transcriptions")
    ? Response.json({ text: "  two crates of soda for Mama Wanjiru  " })
    : new Response(mp3, { headers: { "content-type": "audio/mpeg" } });

async function fixture(
  options: {
    signedIn?: boolean;
    services?: VoiceServices;
    environment?: NodeJS.ProcessEnv;
    answer?: (url: string) => Response;
  } = {}
) {
  const request = provider(options.answer ?? defaultAnswer);
  const services =
    options.services ??
    createVoiceServices({ OPENROUTER_API_KEY: key, ...options.environment }, request);
  const app = Fastify();
  registerVoiceRoutes(app, {
    store: {
      getSession: () => (options.signedIn === false ? null : { account: { id: "owner" } })
    } as unknown as Cp2Store,
    services: () => services
  });
  await app.ready();
  return { app, request };
}

const dictation = (bytes: Buffer = webm, contentType = "audio/webm;codecs=opus") => ({
  audioBase64: bytes.toString("base64"),
  contentType
});

describe("voice transcription route", () => {
  it("sends the recording to the configured OpenRouter model and returns the trimmed transcript", async () => {
    const { app, request } = await fixture();
    try {
      const result = await app.inject({
        method: "POST",
        url: voiceTranscribePath,
        payload: { ...dictation(), language: "SW" }
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({
        text: "two crates of soda for Mama Wanjiru",
        model: defaultVoiceTranscriptionModel
      });
      expect(result.headers["cache-control"]).toBe("no-store");
      const [url, init] = request.mock.calls[0]!;
      expect(String(url)).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
      expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`);
      expect(init!.credentials).toBe("omit");
      expect(JSON.parse(init!.body as string)).toEqual({
        model: defaultVoiceTranscriptionModel,
        input_audio: { data: webm.toString("base64"), format: "webm" },
        language: "sw",
        temperature: 0,
        provider: { allow_fallbacks: true, sort: "latency" }
      });
      expect(result.body).not.toContain(key);
    } finally {
      await app.close();
    }
  });

  it("refuses a signed-out caller before any provider call", async () => {
    const { app, request } = await fixture({ signedIn: false });
    try {
      const result = await app.inject({
        method: "POST",
        url: voiceTranscribePath,
        payload: dictation()
      });
      expect(result.statusCode).toBe(401);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("answers voice_unavailable when the host has no speech service", async () => {
    const { app } = await fixture({ services: {} });
    try {
      for (const url of [voiceTranscribePath, voiceSpeakPath]) {
        const result = await app.inject({
          method: "POST",
          url,
          payload: { ...dictation(), text: "Hello" }
        });
        expect(result.statusCode).toBe(503);
        expect(result.json()).toMatchObject({ code: "voice_unavailable", retryable: false });
      }
    } finally {
      await app.close();
    }
  });

  it.each([
    [{ audioBase64: "", contentType: "audio/webm" }, "voice_audio_invalid"],
    [{ audioBase64: "AAAA" }, "voice_audio_invalid"],
    [{ audioBase64: "AAAA", contentType: "video/mp4" }, "voice_audio_unsupported"],
    [{ audioBase64: "not base64!", contentType: "audio/webm" }, "voice_audio_invalid"],
    [{ audioBase64: "AAA", contentType: "audio/webm" }, "voice_audio_invalid"],
    [{ ...dictation(), language: "english" }, "voice_audio_invalid"],
    [dictation(wav(121), "audio/wav"), "voice_audio_too_long"]
  ])("rejects a bad upload %# as %s without calling the provider", async (payload, code) => {
    const { app, request } = await fixture();
    try {
      const result = await app.inject({ method: "POST", url: voiceTranscribePath, payload });
      expect(result.statusCode).toBe(400);
      expect(result.json().code).toBe(code);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("accepts a two-minute WAV and rejects anything over the byte limit", async () => {
    expect(parseTranscriptionRequest(dictation(wav(120), "audio/wav")).format).toBe("wav");
    expect(() =>
      parseTranscriptionRequest(dictation(Buffer.alloc(voiceDictationMaxBytes + 1), "audio/webm"))
    ).toThrow(expect.objectContaining({ code: "voice_audio_too_large" }));
  });

  it.each([
    [new Response("upstream", { status: 500 }), true],
    [new Response("limited", { status: 429 }), true],
    [Response.json({ error: "no text" }), false]
  ])(
    "maps a provider failure %# to a redacted voice_provider_failed",
    async (answer, retryable) => {
      const { app } = await fixture({ answer: () => answer });
      try {
        const result = await app.inject({
          method: "POST",
          url: voiceTranscribePath,
          payload: dictation()
        });
        expect(result.statusCode).toBe(502);
        expect(result.json()).toEqual({
          code: "voice_provider_failed",
          message: "Voice could not transcribe this recording right now. Please try again.",
          retryable
        });
      } finally {
        await app.close();
      }
    }
  );
});

/** undici's shape for a request that never connected. */
const connectTimeout = () =>
  new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });

describe("voice connection retry", () => {
  it("repeats a call once when the connection drops, and never on an HTTP error", async () => {
    let calls = 0;
    const flaky = vi.fn<typeof fetch>(async (url) => {
      calls += 1;
      if (calls === 1) throw connectTimeout();
      return defaultAnswer(String(url));
    });
    const services = createVoiceServices({ OPENROUTER_API_KEY: key }, flaky);
    await expect(services.transcriber!({ bytes: webm, format: "webm" })).resolves.toMatchObject({
      text: "two crates of soda for Mama Wanjiru"
    });
    expect(flaky).toHaveBeenCalledTimes(2);

    const down = vi.fn<typeof fetch>(async () => new Response("no", { status: 503 }));
    await expect(
      createVoiceServices({ OPENROUTER_API_KEY: key }, down).speaker!({ text: "Hi." })
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(down).toHaveBeenCalledTimes(1);

    const dead = vi.fn<typeof fetch>(async () => {
      throw connectTimeout();
    });
    await expect(
      createVoiceServices({ OPENROUTER_API_KEY: key }, dead).speaker!({ text: "Hi." })
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(dead).toHaveBeenCalledTimes(2);
  });
});

describe("voice limits and retry safety", () => {
  it("limits each account on its own, sliding over the window", () => {
    let now = 0;
    const allow = createVoiceRateLimiter({ max: 2, windowMs: 60_000, now: () => now });
    expect([allow("a"), allow("a"), allow("a"), allow("b")]).toEqual([true, true, false, true]);
    now = 59_999;
    expect(allow("a")).toBe(false);
    now = 60_000;
    expect(allow("a")).toBe(true);
  });

  it("keeps a limited account's count while other accounts flood in", () => {
    const allow = createVoiceRateLimiter({ max: 1, windowMs: 60_000, maxAccounts: 2 });
    expect(allow("a")).toBe(true);
    expect(allow("b")).toBe(true);
    expect(allow("a")).toBe(false);
    expect(allow("c")).toBe(true);
    expect(allow("a")).toBe(false);
  });

  it("adds no per-IP limit of its own: one shop Wi-Fi is not limited as one person", async () => {
    const rateLimit = (await import("@fastify/rate-limit")).default;
    const app = Fastify();
    // global: false, so only a route's own config.rateLimit would limit it.
    await app.register(rateLimit, { global: false });
    let account = 0;
    registerVoiceRoutes(app, {
      store: {
        getSession: () => ({ account: { id: `staff-${(account += 1)}` } })
      } as unknown as Cp2Store,
      services: () => createVoiceServices({ OPENROUTER_API_KEY: key }, provider(defaultAnswer))
    });
    try {
      for (let call = 0; call < 45; call += 1)
        expect(
          (await app.inject({ method: "POST", url: voiceSpeakPath, payload: { text: "Hi." } }))
            .statusCode
        ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("forgets the oldest accounts past its size bound", () => {
    const allow = createVoiceRateLimiter({ max: 1, windowMs: 60_000, maxAccounts: 2 });
    expect([allow("a"), allow("b"), allow("c")]).toEqual([true, true, true]);
    expect(allow("a")).toBe(true);
    expect(allow("c")).toBe(false);
  });

  it("answers 429 voice_rate_limited past the account's limit, before any provider call", async () => {
    const request = provider(defaultAnswer);
    const app = Fastify();
    registerVoiceRoutes(app, {
      store: { getSession: () => ({ account: { id: "owner" } }) } as unknown as Cp2Store,
      services: () => createVoiceServices({ OPENROUTER_API_KEY: key }, request),
      limits: {
        transcribe: () => true,
        speak: createVoiceRateLimiter({ max: 1, windowMs: 60_000 })
      }
    });
    try {
      const say = () =>
        app.inject({ method: "POST", url: voiceSpeakPath, payload: { text: "Hi." } });
      expect((await say()).statusCode).toBe(200);
      const limited = await say();
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: "voice_rate_limited", retryable: true });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("never retries once a response arrived, even if its body then fails (no double billing)", async () => {
    const broken = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"te'));
              controller.error(new TypeError("socket reset"));
            }
          }),
          { headers: { "content-type": "application/json" } }
        )
    );
    await expect(
      createVoiceServices({ OPENROUTER_API_KEY: key }, broken).transcriber!({
        bytes: webm,
        format: "webm"
      })
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ECONNRESET", 1],
    ["UND_ERR_SOCKET", 1],
    [undefined, 1],
    ["ECONNREFUSED", 2],
    ["ENOTFOUND", 2]
  ])(
    "retries a fetch failure caused by %s only if the request never left (%i calls)",
    async (code, expected) => {
      const failing = vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed", code ? { cause: { code } } : undefined);
      });
      await expect(
        createVoiceServices({ OPENROUTER_API_KEY: key }, failing).speaker!({ text: "Hi." })
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      expect(failing).toHaveBeenCalledTimes(expected);
    }
  );

  it("aborts the provider call when the client disconnects", async () => {
    const { request: httpRequest } = await import("node:http");
    let providerSignal: AbortSignal | undefined;
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          providerSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        })
    );
    const app = Fastify();
    registerVoiceRoutes(app, {
      store: { getSession: () => ({ account: { id: "owner" } }) } as unknown as Cp2Store,
      services: () => createVoiceServices({ OPENROUTER_API_KEY: key }, hanging)
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const client = httpRequest(`${address}${voiceSpeakPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      client.on("error", () => {});
      client.end(JSON.stringify({ text: "Hello." }));
      await vi.waitFor(() => expect(hanging).toHaveBeenCalledOnce());
      expect(providerSignal?.aborted).toBe(false);
      client.destroy();
      await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
    } finally {
      await app.close();
    }
  });

  it("does not retry a cancelled call", async () => {
    const controller = new AbortController();
    const hanging = vi.fn<typeof fetch>(async (_url, init) => {
      controller.abort();
      throw init?.signal?.reason ?? new Error("aborted");
    });
    await expect(
      createVoiceServices({ OPENROUTER_API_KEY: key }, hanging).speaker!({
        text: "Hi.",
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: "INFERENCE_CANCELLED" });
    expect(hanging).toHaveBeenCalledTimes(1);
  });
});

describe("voice speech route", () => {
  it("asks OpenRouter for MP3 speech in the configured voice and returns it as base64", async () => {
    const { app, request } = await fixture({ environment: { VOICE_SPEECH_VOICE: "nova" } });
    try {
      const result = await app.inject({
        method: "POST",
        url: voiceSpeakPath,
        payload: { text: "  Your order of two crates is ready.  " }
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({
        audioBase64: mp3.toString("base64"),
        contentType: "audio/mpeg",
        model: defaultVoiceSpeechModel,
        voice: "nova"
      });
      expect(result.headers["cache-control"]).toBe("no-store");
      const [url, init] = request.mock.calls[0]!;
      expect(String(url)).toBe("https://openrouter.ai/api/v1/audio/speech");
      expect(JSON.parse(init!.body as string)).toEqual({
        model: defaultVoiceSpeechModel,
        input: "Your order of two crates is ready.",
        voice: "nova",
        response_format: "mp3",
        provider: { allow_fallbacks: true, sort: "latency" }
      });
    } finally {
      await app.close();
    }
  });

  it("rejects empty or over-long text before any provider call", async () => {
    const { app, request } = await fixture();
    try {
      for (const [text, code] of [
        ["   ", "voice_text_invalid"],
        ["a".repeat(voiceSpeechMaxCharacters + 1), "voice_text_too_long"]
      ] as const) {
        const result = await app.inject({ method: "POST", url: voiceSpeakPath, payload: { text } });
        expect(result.statusCode).toBe(400);
        expect(result.json().code).toBe(code);
      }
      expect(request).not.toHaveBeenCalled();
      expect(parseSpeechRequest({ text: "a".repeat(voiceSpeechMaxCharacters) }).text).toHaveLength(
        voiceSpeechMaxCharacters
      );
    } finally {
      await app.close();
    }
  });

  it("treats a JSON or empty 200 from the speech endpoint as a provider failure", async () => {
    for (const answer of [
      () => Response.json({ error: { message: "voice not found" } }),
      () => new Response(new Uint8Array(), { headers: { "content-type": "audio/mpeg" } })
    ]) {
      const { app } = await fixture({ answer });
      try {
        const result = await app.inject({
          method: "POST",
          url: voiceSpeakPath,
          payload: { text: "Hello" }
        });
        expect(result.statusCode).toBe(502);
        expect(result.json().code).toBe("voice_provider_failed");
      } finally {
        await app.close();
      }
    }
  });
});

describe("voice configuration", () => {
  it("offers nothing without an OpenRouter key", () => {
    expect(createVoiceServices({})).toEqual({});
    expect(createVoiceServices({ OPENROUTER_API_KEY: "  " })).toEqual({});
  });

  it("turns one direction off with `off` and keeps the other", () => {
    const services = createVoiceServices({
      OPENROUTER_API_KEY: key,
      VOICE_TRANSCRIPTION_MODEL: "off"
    });
    expect(services.transcriber).toBeUndefined();
    expect(services.speaker).toBeTypeOf("function");
    expect(services.speechModel).toBe(defaultVoiceSpeechModel);
  });

  it.each([
    [{ VOICE_TRANSCRIPTION_MODEL: "whisper" }, /VOICE_TRANSCRIPTION_MODEL/],
    [{ VOICE_SPEECH_MODEL: "openai/tts 1" }, /VOICE_SPEECH_MODEL/],
    [{ VOICE_SPEECH_VOICE: "a voice" }, /VOICE_SPEECH_VOICE/],
    [{ VOICE_TIMEOUT_MS: "500" }, /VOICE_TIMEOUT_MS/],
    [{ VOICE_TIMEOUT_MS: "40000" }, /VOICE_TIMEOUT_MS/],
    [{ VOICE_TIMEOUT_MS: "soon" }, /VOICE_TIMEOUT_MS/]
  ])("rejects invalid configuration %#", (environment, message) => {
    expect(() => createVoiceServices({ OPENROUTER_API_KEY: key, ...environment })).toThrow(message);
  });

  it("maps browser recording types to provider formats", () => {
    expect(voiceAudioFormat("audio/webm;codecs=opus")).toBe("webm");
    expect(voiceAudioFormat("audio/ogg; codecs=opus")).toBe("ogg");
    expect(voiceAudioFormat("audio/mp4")).toBe("m4a");
    expect(voiceAudioFormat("AUDIO/MPEG")).toBe("mp3");
    expect(voiceAudioFormat("audio/flac")).toBeUndefined();
    expect(voiceAudioFormat("__proto__")).toBeUndefined();
  });
});

describe("word error rate (voice eval scorer)", () => {
  it("is 0 for the same words regardless of case, punctuation and thousands separators", () => {
    expect(wordErrorRate("Two crates, KES 1,250!", "two crates kes 1250")).toBe(0);
    expect(wordErrorRate("Habari ya asubuhi.", "habari ya asubuhi")).toBe(0);
  });

  it("scores number words and numerals as the same words", () => {
    expect(
      wordErrorRate(
        "The invoice total is one thousand two hundred and fifty shillings.",
        "The invoice total is 1,250 shillings."
      )
    ).toBe(0);
    expect(wordErrorRate("Add twenty kilograms", "Add 20 kilograms")).toBe(0);
    expect(wordErrorRate("twenty one bags and two crates", "21 bags and 2 crates")).toBe(0);
    expect(wordErrorRate("three hundred", "300")).toBe(0);
    expect(wordErrorRate("bread and milk", "bread and milk")).toBe(0);
    expect(wordErrorRate("two crates", "3 crates")).toBe(0.5);
    // Separate numbers stay separate: a list, a spoken phone number, "and" between numbers.
    expect(normalizeWords("two and three")).toEqual(["2", "and", "3"]);
    expect(normalizeWords("one two three")).toEqual(["1", "2", "3"]);
    expect(normalizeWords("one hundred one hundred")).toEqual(["100", "100"]);
    expect(normalizeWords("two thousand three thousand")).toEqual(["2000", "3000"]);
    // Years said as two pairs, decimals, and separators only where the number is grouped.
    expect(normalizeWords("twenty twenty")).toEqual(["2020"]);
    expect(normalizeWords("nineteen eighty four")).toEqual(["1984"]);
    expect(normalizeWords("nineteen oh five")).toEqual(["1905"]);
    expect(normalizeWords("one point five litres")).toEqual(["1.5", "litres"]);
    expect(normalizeWords("1.5 litres.")).toEqual(["1.5", "litres"]);
    expect(normalizeWords("KES 12,500,000 and 1,2,3")).toEqual([
      "kes",
      "12500000",
      "and",
      "1",
      "2",
      "3"
    ]);
    expect(normalizeWords("two hundred thousand five hundred")).toEqual(["200500"]);
    expect(normalizeWords("two thousand and five")).toEqual(["2005"]);
    expect(normalizeWords("five hundred thousand")).toEqual(["500000"]);
    expect(normalizeWords("one hundred and twenty three")).toEqual(["123"]);
  });

  it("counts substitutions, deletions and insertions against the reference length", () => {
    expect(wordErrorRate("sold three loaves today", "sold tree loaves today")).toBe(0.25);
    expect(wordErrorRate("sold three loaves today", "sold loaves today")).toBe(0.25);
    expect(wordErrorRate("sold three loaves", "we sold three loaves")).toBeCloseTo(1 / 3);
    expect(wordErrorRate("sold three", "")).toBe(1);
    expect(wordErrorRate("", "")).toBe(0);
  });
});
