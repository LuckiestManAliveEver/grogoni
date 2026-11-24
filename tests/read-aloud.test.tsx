// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadAloudButton } from "../apps/web/src/ReadAloudButton";
import { useReadAloud } from "../apps/web/src/hooks/useReadAloud";
import { agentPreviewIdPrefix } from "../apps/web/src/inference/agent-turn-preview";
import {
  resetServerVoiceAvailability,
  type AudioLike,
  type SpeechEnvironment,
  type VoicePost
} from "../apps/web/src/messaging/voice-speech";

// Listen on agent replies: one reply at a time, Stop stops, a double tap never restarts it.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let posts = 0;
let pauses = 0;
let failNext = false;
const environment: SpeechEnvironment = {
  post: (async () => {
    posts += 1;
    if (failNext) throw new Error("down");
    return { audioBase64: btoa("ID3"), contentType: "audio/mpeg" };
  }) as unknown as VoicePost,
  createAudio: () =>
    ({
      src: "",
      onended: null,
      onerror: null,
      play: async () => {},
      pause: () => {
        pauses += 1;
      }
    }) as AudioLike,
  createObjectUrl: () => "blob:x",
  revokeObjectUrl: () => {},
  synthesis: null
};

let readAloud: ReturnType<typeof useReadAloud>;
function Harness() {
  readAloud = useReadAloud(environment);
  return (
    <>
      <ReadAloudButton readAloud={readAloud} messageId="m1" text="First reply." />
      <ReadAloudButton readAloud={readAloud} messageId="m2" text="Second reply." />
      <ReadAloudButton readAloud={readAloud} messageId="m3" text="   " />
      <ReadAloudButton
        readAloud={readAloud}
        messageId={`${agentPreviewIdPrefix}live`}
        text="Half of a reply that is still"
      />
    </>
  );
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  posts = 0;
  pauses = 0;
  failNext = false;
  container = document.createElement("div");
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
});

const buttons = () => [...container.querySelectorAll("button")];

describe("Listen on agent replies", () => {
  // The harness renders under StrictMode: mount, cleanup and mount again must not break playback.
  it("shows Listen only for finished replies with words, and Stop on the one playing", async () => {
    expect(buttons().map((button) => button.textContent)).toEqual(["Listen", "Listen"]);
    await act(async () => buttons()[0]!.click());
    expect(buttons().map((button) => button.textContent)).toEqual(["Stop", "Listen"]);
    expect(buttons()[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(buttons()[0]!.getAttribute("aria-label")).toBe("Stop reading this reply aloud");
  });

  it("stops on a double tap before any re-render, instead of restarting", async () => {
    await act(async () => {
      readAloud.toggle("m1", "First reply.");
      readAloud.toggle("m1", "First reply.");
    });
    expect(readAloud.speakingId).toBeNull();
    expect(pauses).toBeGreaterThan(0);
  });

  it("switching replies stops the first and plays the second", async () => {
    await act(async () => buttons()[0]!.click());
    await act(async () => buttons()[1]!.click());
    expect(readAloud.speakingId).toBe("m2");
    expect(pauses).toBe(1);
  });

  it("shows the failure under the reply that failed", async () => {
    failNext = true;
    await act(async () => buttons()[1]!.click());
    await act(async () => {});
    expect(container.textContent).toContain("This reply could not be read aloud.");
    expect(readAloud.error?.messageId).toBe("m2");
    expect(posts).toBe(1);
  });

  it("stops playback when the chat goes away", async () => {
    await act(async () => buttons()[0]!.click());
    await act(async () => root.unmount());
    expect(pauses).toBe(1);
    root = createRoot(document.createElement("div"));
  });
});
