// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposerActions } from "../apps/web/src/ChatComposerActions";
import { ConversationAttachmentCard } from "../apps/web/src/ConversationAttachmentCard";
import { useComposerVoiceNote } from "../apps/web/src/VoiceNoteBar";
import { useVoiceNoteRecorder } from "../apps/web/src/hooks/useVoiceNoteRecorder";
import {
  dataUrlToBlob,
  formatRecordingTime,
  startVoiceNoteRecording,
  VoiceNoteUnavailableError,
  voiceNoteFileName,
  voiceNoteMimeType,
  type VoiceNoteEnvironment
} from "../apps/web/src/messaging/voice-note";

// A voice note is recorded in the composer and becomes an ordinary audio attachment: sent with
// the next send (end-to-end encrypted to people like any file) and played inline in the thread.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom's Blob has no text(); FileReader reads it.
const readText = (blob: Blob | null | undefined) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob!);
  });

function fakeMicrophone(options: { deny?: string; supported?: string[] } = {}) {
  const tracks = [{ stop: vi.fn() }];
  const recorders: Array<{
    state: string;
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null;
    onstop: (() => void) | null;
    onerror: ((event: unknown) => void) | null;
    start: ReturnType<typeof vi.fn>;
    stop: () => void;
  }> = [];
  const environment: VoiceNoteEnvironment = {
    getUserMedia: async () => {
      if (options.deny) throw Object.assign(new Error("no"), { name: options.deny });
      return { getTracks: () => tracks } as unknown as MediaStream;
    },
    createRecorder: (_stream, mimeType) => {
      const recorder = {
        state: "inactive",
        mimeType,
        ondataavailable: null as ((event: { data: Blob }) => void) | null,
        onstop: null as (() => void) | null,
        onerror: null as ((event: unknown) => void) | null,
        start: vi.fn(() => {
          recorder.state = "recording";
        }),
        stop: () => {
          recorder.state = "inactive";
          recorder.ondataavailable?.({ data: new Blob(["opus-bytes"], { type: mimeType }) });
          recorder.onstop?.();
        }
      };
      recorders.push(recorder);
      return recorder;
    },
    isTypeSupported: (type) => (options.supported ?? ["audio/webm;codecs=opus"]).includes(type),
    now: () => new Date(2026, 10, 22, 14, 3, 9)
  };
  return { environment, tracks, recorders };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("voice note recording", () => {
  it("prefers Opus and falls back to MP4 for Safari", () => {
    expect(voiceNoteMimeType((type) => type === "audio/webm;codecs=opus")).toBe(
      "audio/webm;codecs=opus"
    );
    expect(voiceNoteMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
    expect(voiceNoteMimeType(() => false)).toBeNull();
  });

  it("names the file after when it was recorded, with the container's extension", () => {
    const at = new Date(2026, 10, 22, 14, 3, 9);
    expect(voiceNoteFileName("audio/webm", at)).toBe("Voice note 2026-11-22 14.03.09.webm");
    expect(voiceNoteFileName("audio/mp4", at)).toBe("Voice note 2026-11-22 14.03.09.m4a");
    expect(voiceNoteFileName("audio/ogg", at)).toBe("Voice note 2026-11-22 14.03.09.ogg");
    expect(formatRecordingTime(7_400)).toBe("0:07");
    expect(formatRecordingTime(299_999)).toBe("4:59");
  });

  it("records an audio file and releases the microphone when it stops", async () => {
    const { environment, tracks } = fakeMicrophone();
    const recording = await startVoiceNoteRecording(environment);
    const file = await recording.stop();
    expect(file).toBeInstanceOf(File);
    expect(file?.type).toBe("audio/webm");
    expect(file?.name).toBe("Voice note 2026-11-22 14.03.09.webm");
    expect(await readText(file)).toBe("opus-bytes");
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
  });

  it("throws a cancelled recording away and still releases the microphone", async () => {
    const { environment, tracks, recorders } = fakeMicrophone();
    const recording = await startVoiceNoteRecording(environment);
    recording.cancel();
    expect(recorders[0]!.state).toBe("inactive");
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
    await expect(recording.stop()).resolves.toBeNull();
  });

  it.each([
    ["NotAllowedError", "denied", /Allow microphone access/u],
    ["NotFoundError", "failed", /could not be recorded/u]
  ])("explains a %s from the microphone", async (name, reason, message) => {
    const { environment } = fakeMicrophone({ deny: name });
    const attempt = startVoiceNoteRecording(environment);
    await expect(attempt).rejects.toMatchObject({ reason });
    await expect(attempt).rejects.toThrow(message);
  });

  it("reports a browser without recording support", async () => {
    await expect(startVoiceNoteRecording(null)).rejects.toBeInstanceOf(VoiceNoteUnavailableError);
    const { environment } = fakeMicrophone({ supported: [] });
    await expect(startVoiceNoteRecording(environment)).rejects.toMatchObject({
      reason: "unsupported"
    });
  });

  it("the composer hook hands the recording over as a file", async () => {
    const { environment } = fakeMicrophone();
    const recorded: File[] = [];
    let api: ReturnType<typeof useVoiceNoteRecorder> | null = null;
    function Harness() {
      api = useVoiceNoteRecorder((file) => recorded.push(file), environment);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    await act(async () => api!.start());
    expect(api!.state).toBe("recording");
    await act(async () => api!.stop());
    expect(api!.state).toBe("idle");
    expect(recorded.map((file) => file.type)).toEqual(["audio/webm"]);
    act(() => root.unmount());
  });

  it("releases the microphone when the composer goes away while the prompt is up", async () => {
    const { environment, tracks } = fakeMicrophone();
    let grant!: () => void;
    const prompt = new Promise<void>((resolve) => {
      grant = resolve;
    });
    const slow = {
      ...environment,
      getUserMedia: async (constraints: { audio: boolean }) => {
        await prompt;
        return environment.getUserMedia(constraints);
      }
    };
    let api: ReturnType<typeof useVoiceNoteRecorder> | null = null;
    function Harness() {
      api = useVoiceNoteRecorder(() => undefined, slow);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    let started!: Promise<void>;
    act(() => {
      started = api!.start();
    });
    act(() => root.unmount());
    grant();
    await started;
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
  });

  it("the composer hook says why it cannot record", async () => {
    const { environment } = fakeMicrophone({ deny: "NotAllowedError" });
    let api: ReturnType<typeof useVoiceNoteRecorder> | null = null;
    function Harness() {
      api = useVoiceNoteRecorder(() => undefined, environment);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    await act(async () => api!.start());
    expect(api!.state).toBe("idle");
    expect(api!.error).toMatch(/Allow microphone access/u);
    act(() => root.unmount());
  });
});

describe("voice note playback", () => {
  it("decodes a data URL into a blob of the same type", async () => {
    const blob = dataUrlToBlob(`data:audio/webm;base64,${btoa("opus-bytes")}`);
    expect(blob?.type).toBe("audio/webm");
    expect(await readText(blob)).toBe("opus-bytes");
    expect(dataUrlToBlob("https://example.test/a.webm")).toBeNull();
  });

  it("plays a data-URL audio attachment through a blob URL (the CSP allows no data: media)", async () => {
    const created = vi.fn(() => "blob:https://grogoni.com/voice-1");
    const revoked = vi.fn();
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <ConversationAttachmentCard
          attachment={{
            id: "v1",
            name: "Voice note 2026-11-22 14.03.09.webm",
            type: "audio/webm",
            size: 10,
            category: "audio",
            dataUrl: `data:audio/webm;base64,${btoa("opus-bytes")}`
          }}
        />
      )
    );
    const audio = container.querySelector("audio");
    expect(audio?.getAttribute("src")).toBe("blob:https://grogoni.com/voice-1");
    expect(audio?.getAttribute("aria-label")).toBe("Play Voice note 2026-11-22 14.03.09.webm");
    act(() => root.unmount());
    expect(revoked).toHaveBeenCalledWith("blob:https://grogoni.com/voice-1");
  });

  it("plays a stored audio attachment from its download URL", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <ConversationAttachmentCard
          attachment={{
            id: "v2",
            name: "note.m4a",
            type: "audio/mp4",
            size: 10,
            category: "audio",
            downloadUrl: "/v1/conversations/c1/attachments/v2/download"
          }}
        />
      )
    );
    expect(container.querySelector("audio")?.getAttribute("src")).toBe(
      "/v1/conversations/c1/attachments/v2/download"
    );
    act(() => root.unmount());
  });

  it("does not put a player on a document", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <ConversationAttachmentCard
          attachment={{
            id: "d1",
            name: "receipt.pdf",
            type: "application/pdf",
            size: 10,
            category: "document",
            dataUrl: "data:application/pdf;base64,AAAA"
          }}
        />
      )
    );
    expect(container.querySelector("audio")).toBeNull();
    act(() => root.unmount());
  });
});

describe("voice note action", () => {
  it("the composer offers it only when a recording can become an attachment", async () => {
    vi.stubGlobal(
      "MediaRecorder",
      Object.assign(function () {}, { isTypeSupported: () => true })
    );
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: async () => ({}) } });
    const results: Array<Record<string, unknown>> = [];
    function Harness({ attach }: { attach?: (files: File[]) => void }) {
      results.push(useComposerVoiceNote(attach).actionProps((action) => action()));
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(<Harness attach={() => undefined} />));
    expect(Object.keys(results[0]!)).toEqual([]);
    expect(Object.keys(results.at(-1)!)).toEqual(["onRecordVoiceNote"]);
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  const props = {
    draftHasText: false,
    mode: "buyer" as const,
    open: true,
    sendViaLabel: "Grogoni",
    onAttachFiles: () => undefined,
    onClose: () => undefined,
    onSendSms: () => undefined,
    onSendVia: () => undefined,
    onShareApps: () => undefined,
    onTakePhoto: () => undefined
  };

  it("is offered only when the composer can record and attach", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<ChatComposerActions {...props} />));
    expect(document.querySelector('[aria-label="Record voice note"]')).toBeNull();
    const record = vi.fn();
    await act(async () =>
      root.render(<ChatComposerActions {...props} onRecordVoiceNote={record} />)
    );
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Record voice note"]');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(record).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });
});
