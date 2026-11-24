import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../apps/web/src/lib/api";
import {
  blobToBase64,
  browserSpeechEnvironment,
  DictationError,
  resetServerVoiceAvailability,
  serverTranscriptionAvailable,
  silentWav,
  speakableText,
  speakReply,
  speechChunkMaxCharacters,
  splitForSpeech,
  transcribeRecording,
  type AudioLike,
  type SpeechEnvironment,
  type VoicePost
} from "../apps/web/src/messaging/voice-speech";

// Dictation and read-aloud through the server's speech endpoints, with browser speech as the
// fallback when the server has no speech service (services/api/src/cp2/voice/).

afterEach(() => resetServerVoiceAvailability());

const unavailable = () =>
  new ApiRequestError(503, "Voice is not available on this server.", {
    code: "voice_unavailable"
  });

describe("speakableText", () => {
  it("drops markdown, code and links so only the words are spoken", () => {
    expect(
      speakableText(
        '## Order ready\n- **2 crates** of `soda`\n> note\nSee [the invoice](https://x.test/i/1) or https://grogoni.com/o/9\n```json\n{"a":1}\n```\n| Item | Qty |'
      )
    ).toBe("Order ready 2 crates of soda note See the invoice or Item Qty");
  });

  it("keeps identifiers and in-word marks, and strips stray or unbalanced markup", () => {
    expect(speakableText("Check stock_level and reorder_point today.")).toBe(
      "Check stock_level and reorder_point today."
    );
    expect(speakableText("_stock_level and **bold** and 2*3")).toBe("stock_level and bold and 2*3");
    expect(speakableText("See [the page](http://a.test/b_(c)) now.")).toBe("See the page now.");
    expect(speakableText("Run this:\n```\nunclosed code")).toBe("Run this:");
    expect(speakableText("Salt &amp; sugar &lt;5kg&gt;")).toBe("Salt & sugar <5kg>");
    expect(speakableText("Stray ** marks ~~ and * here")).toBe("Stray marks and here");
    expect(speakableText("**bold**text and ~~old~~new")).toBe("boldtext and oldnew");
    expect(speakableText("| Item | Qty |\n| --- | :---: |\n| Soda | 2 |")).toBe("Item Qty Soda 2");
    expect(speakableText("<b>Hi</b> it&#8217;s &#x2014; ready")).toBe("Hi it’s — ready");
  });

  it("keeps ordinary punctuation, numbers and snake_case words", () => {
    expect(speakableText("Total: KES 1,250.50 for item_code A-12.")).toBe(
      "Total: KES 1,250.50 for item_code A-12."
    );
  });
});

describe("splitForSpeech", () => {
  it("returns nothing for blank text and one chunk for a short reply", () => {
    expect(splitForSpeech("   ")).toEqual([]);
    expect(splitForSpeech("Habari. Your order is ready!")).toEqual([
      "Habari. Your order is ready!"
    ]);
  });

  it("packs sentences into chunks under the limit without losing or repeating words", () => {
    const sentence = (index: number) => `Sentence number ${index} lists some stock levels.`;
    const text = Array.from({ length: 60 }, (_, index) => sentence(index)).join(" ");
    const chunks = splitForSpeech(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(speechChunkMaxCharacters);
    // Every chunk ends at a sentence boundary.
    for (const chunk of chunks) expect(chunk.endsWith(".")).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });

  it("splits a sentence longer than the limit at commas or spaces, then mid-word", () => {
    const long = Array.from({ length: 50 }, (_, index) => `item ${index}, qty ${index}`).join(" ");
    const chunks = splitForSpeech(long, 120);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
    expect(chunks.join(" ").replace(/\s+/gu, " ")).toBe(long);
    // Never a punctuation-only chunk (a paid request for silence), never a split emoji.
    const commaCut = splitForSpeech(`${"a".repeat(20)}, ${"b".repeat(33)}`, 20);
    for (const chunk of commaCut) expect(chunk).toMatch(/[a-z]/u);
    expect(commaCut.join("").replace(/[ ,]/gu, "")).toBe(`${"a".repeat(20)}${"b".repeat(33)}`);
    const emoji = splitForSpeech(`${"a".repeat(19)}😀${"b".repeat(10)}`, 20);
    for (const chunk of emoji) expect(chunk).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
    expect(emoji.join("")).toBe(`${"a".repeat(19)}😀${"b".repeat(10)}`);
    expect(splitForSpeech("... !!! ???")).toEqual([]);
    // Decimals, prices and domains are not sentence ends.
    expect(
      splitForSpeech(
        speakableText("Your total is KSh 1,250.50 for 2.5 kg. Visit grogoni.com today.")
      )
    ).toEqual(["Your total is KSh 1,250.50 for 2.5 kg. Visit grogoni.com today."]);
    expect(splitForSpeech("Version 3.14 is out. Next.", 20)).toEqual([
      "Version 3.14 is out.",
      "Next."
    ]);
    const word = "x".repeat(250);
    expect(splitForSpeech(word, 100)).toEqual(["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
  });
});

describe("transcribeRecording", () => {
  const recording = new Blob([new Uint8Array([1, 2, 3, 250])], { type: "audio/webm" });

  it("posts base64 audio and its type, and returns the trimmed transcript", async () => {
    const post = vi.fn(async () => ({ text: "  sold three loaves  " })) as unknown as VoicePost;
    await expect(transcribeRecording(post, recording, { language: "sw" })).resolves.toBe(
      "sold three loaves"
    );
    expect(post).toHaveBeenCalledWith(
      "/v1/voice/transcribe",
      { audioBase64: await blobToBase64(recording), contentType: "audio/webm", language: "sw" },
      { timeoutMs: 45_000 }
    );
    expect(await blobToBase64(recording)).toBe(Buffer.from([1, 2, 3, 250]).toString("base64"));
  });

  it("does not call the server offline", async () => {
    const post = vi.fn() as unknown as VoicePost;
    await expect(transcribeRecording(post, recording, { online: false })).rejects.toMatchObject({
      reason: "offline"
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("remembers voice_unavailable so the next tap uses browser recognition", async () => {
    const post = vi.fn(async () => {
      throw unavailable();
    }) as unknown as VoicePost;
    expect(serverTranscriptionAvailable()).toBe(true);
    await expect(transcribeRecording(post, recording)).rejects.toMatchObject({
      reason: "unavailable"
    });
    expect(serverTranscriptionAvailable()).toBe(false);
  });

  it.each([
    [
      new ApiRequestError(400, "Recordings over 2 minutes cannot be transcribed.", {
        code: "voice_audio_too_long"
      }),
      "too_long"
    ],
    [new ApiRequestError(502, "Voice could not…", { code: "voice_provider_failed" }), "failed"],
    [new TypeError("network"), "failed"]
  ])("maps %s to %s and keeps server voice on", async (error, reason) => {
    const post = vi.fn(async () => {
      throw error;
    }) as unknown as VoicePost;
    const caught = await transcribeRecording(post, recording).catch((value: unknown) => value);
    expect(caught).toBeInstanceOf(DictationError);
    expect((caught as DictationError).reason).toBe(reason);
    expect(serverTranscriptionAvailable()).toBe(true);
  });

  it("reports silence as empty", async () => {
    const post = vi.fn(async () => ({ text: "  " })) as unknown as VoicePost;
    await expect(transcribeRecording(post, recording)).rejects.toMatchObject({ reason: "empty" });
  });
});

/** A fake browser: audio plays when the test calls end(); every step is recorded. */
function fakeEnvironment(
  options: {
    post?: VoicePost;
    synthesis?: boolean;
    refuseAfterUnlock?: boolean;
    synthesisFails?: boolean;
    synthesisSilent?: boolean;
  } = {}
) {
  const events: string[] = [];
  const players: (AudioLike & { end: () => void })[] = [];
  let urlCount = 0;
  const environment: SpeechEnvironment = {
    post:
      options.post ??
      (vi.fn(async (_path: string, body: Record<string, unknown>) => {
        events.push(`fetch:${String(body.text).slice(0, 12)}`);
        return {
          audioBase64: Buffer.from("ID3audio").toString("base64"),
          contentType: "audio/mpeg"
        };
      }) as unknown as VoicePost),
    createAudio: () => {
      let plays = 0;
      const player = {
        src: "",
        onended: null as (() => void) | null,
        onerror: null as (() => void) | null,
        play: async () => {
          plays += 1;
          events.push(`play:${player.src}`);
          if (options.refuseAfterUnlock && plays > 1) throw new Error("NotAllowedError");
        },
        pause: () => events.push("pause"),
        end: () => player.onended?.()
      };
      players.push(player);
      return player;
    },
    createObjectUrl: () => `blob:${++urlCount}`,
    revokeObjectUrl: (url) => events.push(`revoke:${url}`),
    synthesis: options.synthesis
      ? {
          speak: (text, onEnd) => {
            events.push(`say:${text.slice(0, 12)}`);
            if (options.synthesisSilent) return;
            queueMicrotask(() => onEnd(!options.synthesisFails));
          },
          cancel: () => events.push("cancel"),
          prime: () => events.push("prime")
        }
      : null
  };
  return { environment, events, players };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const twoChunks = `${"First part of the reply. ".repeat(30)}${"Second part here. ".repeat(10)}`;
const revoked = (events: string[]) => events.filter((event) => event.startsWith("revoke:")).sort();

describe("browserSpeechEnvironment", () => {
  it("reports every synthesis error as a failure, and primes with an empty utterance", () => {
    const spoken: { text: string; onerror?: () => void; onend?: () => void }[] = [];
    class FakeUtterance {
      lang = "";
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly text: string) {}
    }
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", {
      speak: (utterance: FakeUtterance) =>
        spoken.push(utterance as unknown as (typeof spoken)[number]),
      cancel: () => {},
      getVoices: () => []
    });
    try {
      const synthesis = browserSpeechEnvironment(vi.fn() as unknown as VoicePost).synthesis!;
      // No voices listed yet (Chrome before voiceschanged) still counts as available.
      expect(synthesis).not.toBeNull();
      synthesis.prime();
      expect(spoken[0]!.text).toBe("");
      const outcomes: boolean[] = [];
      synthesis.speak("Hello.", (ok) => outcomes.push(ok));
      spoken[1]!.onerror!();
      synthesis.speak("Again.", (ok) => outcomes.push(ok));
      spoken[2]!.onend!();
      expect(outcomes).toEqual([false, true]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("speakReply", () => {
  it("unlocks one audio element inside the tap, before any network call", () => {
    const { environment, events, players } = fakeEnvironment();
    speakReply(environment, "Hello there.");
    // Synchronous: still inside the click handler that called speakReply.
    expect(players).toHaveLength(1);
    expect(events[0]).toBe("play:blob:1");
    expect(silentWav().type).toBe("audio/wav");
    expect(silentWav().size).toBe(444);
  });

  it("prefetches the next chunk while the current one plays, on the same element, then frees every URL", async () => {
    const { environment, events, players } = fakeEnvironment();
    expect(splitForSpeech(twoChunks)).toHaveLength(2);
    const playback = speakReply(environment, twoChunks);
    await flush();
    expect(events).toEqual([
      "play:blob:1",
      "fetch:First part o",
      "fetch:Second part ",
      "play:blob:2"
    ]);
    players[0]!.end();
    await flush();
    expect(events.at(-1)).toBe("play:blob:3");
    // Each part is let go as soon as it has played, not at the end of the reply.
    expect(events.indexOf("revoke:blob:2")).toBeLessThan(events.indexOf("play:blob:3"));
    players[0]!.end();
    await expect(playback.done).resolves.toBe("finished");
    expect(players).toHaveLength(1);
    expect(revoked(events)).toEqual(["revoke:blob:1", "revoke:blob:2", "revoke:blob:3"]);
  });

  it("stops mid-reply: pauses audio, plays nothing more, aborts the prefetch", async () => {
    let signal: AbortSignal | undefined;
    const { environment, events } = fakeEnvironment();
    const post = environment.post;
    environment.post = ((
      path: string,
      body: Record<string, unknown>,
      options: { signal?: AbortSignal }
    ) => {
      signal = options.signal;
      return post(path, body, options as never);
    }) as VoicePost;
    const playback = speakReply(environment, twoChunks);
    await flush();
    playback.stop();
    await expect(playback.done).resolves.toBe("stopped");
    expect(events).toContain("pause");
    expect(events.filter((event) => event.startsWith("play:"))).toEqual([
      "play:blob:1",
      "play:blob:2"
    ]);
    expect(signal?.aborted).toBe(true);
  });

  it("aborts the prefetch and revokes a late URL when playback fails", async () => {
    let resolveSecond: ((value: unknown) => void) | undefined;
    let secondSignal: AbortSignal | undefined;
    let call = 0;
    const post = vi.fn(async (_path: string, _body: unknown, options: { signal?: AbortSignal }) => {
      call += 1;
      if (call === 1) return { audioBase64: Buffer.from("a").toString("base64") };
      secondSignal = options.signal;
      return new Promise((resolve) => (resolveSecond = resolve));
    }) as unknown as VoicePost;
    const { environment, events, players } = fakeEnvironment({ post });
    const playback = speakReply(environment, twoChunks);
    await flush();
    players[0]!.onerror?.();
    await expect(playback.done).resolves.toBe("failed");
    expect(secondSignal?.aborted).toBe(true);
    // The prefetch answers after the end anyway: no URL is created for it, none leaks.
    resolveSecond!({ audioBase64: Buffer.from("b").toString("base64") });
    await flush();
    expect(revoked(events)).toEqual(["revoke:blob:1", "revoke:blob:2"]);
    expect(events.filter((event) => event.startsWith("play:"))).toHaveLength(2);
  });

  it("speaks the rest with browser speech when the browser refuses to play", async () => {
    const { environment, events } = fakeEnvironment({ refuseAfterUnlock: true, synthesis: true });
    await expect(speakReply(environment, twoChunks).done).resolves.toBe("finished");
    const said = events.filter((event) => event.startsWith("say:"));
    // In short parts (Chrome drops onend on long utterances), from the very first chunk.
    expect(said.length).toBe(splitForSpeech(twoChunks.trim(), 200).length);
    expect(said[0]).toBe("say:First part o");
  });

  it("falls back to browser speech from the failed chunk when the server has no voice", async () => {
    const post = vi.fn(async () => {
      throw unavailable();
    }) as unknown as VoicePost;
    const { environment, events } = fakeEnvironment({ post, synthesis: true });
    await expect(speakReply(environment, twoChunks).done).resolves.toBe("finished");
    expect(events.filter((event) => event.startsWith("say:"))).toHaveLength(
      splitForSpeech(twoChunks.trim(), 200).length
    );
    // The next reply goes straight to browser speech: no server call, no audio element.
    const again = fakeEnvironment({ post, synthesis: true });
    await expect(speakReply(again.environment, "Short reply.").done).resolves.toBe("finished");
    expect(post).toHaveBeenCalledTimes(1);
    expect(again.players).toHaveLength(0);
  });

  it("fails without browser speech, and on a provider error", async () => {
    const down = fakeEnvironment({
      post: vi.fn(async () => {
        throw new ApiRequestError(502, "x", { code: "voice_provider_failed" });
      }) as unknown as VoicePost,
      synthesis: true
    });
    await expect(speakReply(down.environment, "Hello.").done).resolves.toBe("failed");
    expect(down.events.some((event) => event.startsWith("say:"))).toBe(false);

    const refused = fakeEnvironment({ refuseAfterUnlock: true });
    await expect(speakReply(refused.environment, "Hello.").done).resolves.toBe("failed");

    resetServerVoiceAvailability();
    const none = fakeEnvironment({
      post: vi.fn(async () => {
        throw unavailable();
      }) as unknown as VoicePost
    });
    await expect(speakReply(none.environment, "Hello.").done).resolves.toBe("failed");
  });

  it("primes browser speech inside the tap, before anything is awaited", () => {
    const { environment, events } = fakeEnvironment({ synthesis: true });
    speakReply(environment, "Hello there.");
    expect(events.slice(0, 2)).toEqual(["prime", "play:blob:1"]);
  });

  it("reports a browser speech error as failed, not finished", async () => {
    const post = vi.fn(async () => {
      throw unavailable();
    }) as unknown as VoicePost;
    const { environment, events } = fakeEnvironment({
      post,
      synthesis: true,
      synthesisFails: true
    });
    await expect(speakReply(environment, twoChunks).done).resolves.toBe("failed");
    expect(events.filter((event) => event.startsWith("say:"))).toHaveLength(1);
    expect(events).toContain("cancel");
  });

  it("settles through the watchdog when browser speech never reports back", async () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn(async () => {
        throw unavailable();
      }) as unknown as VoicePost;
      const { environment } = fakeEnvironment({ post, synthesis: true, synthesisSilent: true });
      const playback = speakReply(environment, "Short reply.");
      let outcome: string | undefined;
      void playback.done.then((value) => (outcome = value));
      await vi.advanceTimersByTimeAsync(7_999);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes at once for a reply with nothing speakable", async () => {
    const { environment, events } = fakeEnvironment();
    await expect(speakReply(environment, "```\ncode only\n```").done).resolves.toBe("finished");
    expect(events).toEqual([]);
  });
});
