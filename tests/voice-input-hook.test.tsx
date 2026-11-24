// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Api from "../apps/web/src/lib/api";
import type * as VoiceNote from "../apps/web/src/messaging/voice-note";

// Voice typing in the composer: tap to record, tap to stop; the server's transcript is appended
// to the draft for review (never sent by itself). After voice_unavailable the next tap uses the
// browser's own speech recognition.

const apiFetch = vi.fn();
const recording = { stop: vi.fn(), cancel: vi.fn(), startedAt: new Date() };
const startVoiceNoteRecording = vi.fn<() => Promise<typeof recording>>(async () => recording);

vi.mock("../apps/web/src/lib/api", async (original) => ({
  ...(await original<typeof Api>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args)
}));
vi.mock("../apps/web/src/messaging/voice-note", async (original) => ({
  ...(await original<typeof VoiceNote>()),
  browserVoiceNoteEnvironment: () => ({}),
  startVoiceNoteRecording: () => startVoiceNoteRecording()
}));

const { useComposerVoiceInput } = await import("../apps/web/src/hooks/useVoiceInput");
const { ApiRequestError } = await import("../apps/web/src/lib/api");
const { resetServerVoiceAvailability } = await import("../apps/web/src/messaging/voice-speech");

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Voice = ReturnType<typeof useComposerVoiceInput>;
let voice: Voice;
let draft = "";

function Harness() {
  voice = useComposerVoiceInput(draft, (next) => {
    draft = next;
  });
  return null;
}

let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  draft = "Order:";
  apiFetch.mockReset();
  recording.stop.mockReset();
  recording.cancel.mockReset();
  recording.stop.mockResolvedValue(
    Object.assign(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), {
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    })
  );
  startVoiceNoteRecording.mockClear();
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () =>
    root.render(
      <StrictMode>
        <Harness />
      </StrictMode>
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  resetServerVoiceAvailability();
  delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

const tap = () => act(async () => voice.toggle());

describe("composer voice typing", () => {
  it("records, transcribes on the server and appends the text to the draft", async () => {
    apiFetch.mockResolvedValue({ text: "two crates of soda", model: "openai/gpt-4o-transcribe" });
    await tap();
    expect(startVoiceNoteRecording).toHaveBeenCalledOnce();
    expect(voice.listening).toBe(true);
    await tap();
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/voice/transcribe",
      expect.objectContaining({
        method: "POST",
        urgent: true,
        body: { audioBase64: "AQID", contentType: "audio/webm" }
      })
    );
    expect(draft).toBe("Order: two crates of soda");
    expect(voice.listening).toBe(false);
    expect(voice.transcribing).toBe(false);
    expect(voice.error).toBeNull();
  });

  it("shows why a transcription failed and leaves the draft alone", async () => {
    apiFetch.mockRejectedValue(new ApiRequestError(502, "x", { code: "voice_provider_failed" }));
    await tap();
    await tap();
    expect(draft).toBe("Order:");
    expect(voice.error).toBe("Your recording could not be turned into text. Please try again.");
  });

  it("switches to the browser's recognition after the server says voice is unavailable", async () => {
    apiFetch.mockRejectedValue(
      new ApiRequestError(503, "Voice is not available on this server.", {
        code: "voice_unavailable"
      })
    );
    await tap();
    await tap();
    expect(voice.error).toMatch(/Tap the microphone again/u);
    const started = vi.fn();
    class FakeRecognition {
      lang = "";
      interimResults = true;
      onresult: ((event: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onend: (() => void) | null = null;
      start = started;
      stop = vi.fn();
    }
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    await tap();
    expect(started).toHaveBeenCalledOnce();
    expect(startVoiceNoteRecording).toHaveBeenCalledOnce();
    expect(voice.listening).toBe(true);
  });

  it("ignores a second tap while the microphone is still opening", async () => {
    let open: (value: typeof recording) => void = () => {};
    startVoiceNoteRecording.mockImplementationOnce(
      () => new Promise((resolve) => (open = resolve))
    );
    await tap();
    await tap();
    expect(startVoiceNoteRecording).toHaveBeenCalledOnce();
    await act(async () => open(recording));
    expect(voice.listening).toBe(true);
  });

  it("releases the microphone and uploads nothing when unmounted while it opens", async () => {
    vi.useFakeTimers();
    try {
      let open: (value: typeof recording) => void = () => {};
      startVoiceNoteRecording.mockImplementationOnce(
        () => new Promise((resolve) => (open = resolve))
      );
      await tap();
      await act(async () => root.unmount());
      await act(async () => open(recording));
      expect(recording.cancel).toHaveBeenCalledOnce();
      await act(async () => vi.advanceTimersByTime(61_000));
      expect(apiFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      root = createRoot(document.createElement("div"));
    }
  });

  it("stops by itself at 60 seconds, once, even if the person taps as it stops", async () => {
    vi.useFakeTimers();
    try {
      apiFetch.mockResolvedValue({ text: "hello" });
      await tap();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        voice.toggle();
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(recording.stop).toHaveBeenCalledOnce();
      expect(apiFetch).toHaveBeenCalledOnce();
      expect(draft).toBe("Order: hello");
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers nothing when unmounted during transcription", async () => {
    let answer: (value: unknown) => void = () => {};
    apiFetch.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await tap();
    await tap();
    const signal = (apiFetch.mock.calls[0]![1] as { signal: AbortSignal }).signal;
    await act(async () => root.unmount());
    expect(signal.aborted).toBe(true);
    answer({ text: "too late" });
    await act(async () => {});
    expect(draft).toBe("Order:");
    root = createRoot(document.createElement("div"));
  });

  it("keeps a failed recording and sends the same audio again on Try again", async () => {
    apiFetch
      .mockRejectedValueOnce(new ApiRequestError(502, "x", { code: "voice_provider_failed" }))
      .mockResolvedValueOnce({ text: "second time lucky" });
    await tap();
    await tap();
    expect(voice.canRetry).toBe(true);
    await act(async () => voice.retry());
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[1]![1]).toMatchObject({ body: { audioBase64: "AQID" } });
    expect(draft).toBe("Order: second time lucky");
    expect(voice.canRetry).toBe(false);
    expect(startVoiceNoteRecording).toHaveBeenCalledOnce();
  });

  it("offers no retry when retrying cannot help (silence)", async () => {
    apiFetch.mockResolvedValue({ text: "  " });
    await tap();
    await tap();
    expect(voice.error).toBe("No speech was heard. Please try again.");
    expect(voice.canRetry).toBe(false);
  });

  it("uses browser recognition when the device turns out unable to record", async () => {
    const { VoiceNoteUnavailableError } = await import("../apps/web/src/messaging/voice-note");
    startVoiceNoteRecording.mockRejectedValueOnce(new VoiceNoteUnavailableError("unsupported"));
    const started = vi.fn();
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = class {
      lang = "";
      interimResults = true;
      onresult = null;
      onerror = null;
      onend = null;
      start = started;
      stop = vi.fn();
    };
    await tap();
    expect(started).toHaveBeenCalledOnce();
    expect(voice.listening).toBe(true);
    expect(voice.error).toBeNull();
  });

  it("explains a denied microphone", async () => {
    const { VoiceNoteUnavailableError } = await import("../apps/web/src/messaging/voice-note");
    startVoiceNoteRecording.mockRejectedValueOnce(new VoiceNoteUnavailableError("denied"));
    await tap();
    expect(voice.error).toBe("Allow microphone access to use voice typing.");
    expect(voice.listening).toBe(false);
  });
});
