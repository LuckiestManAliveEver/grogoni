import { afterEach, describe, expect, it } from "vitest";
import { keepDeviceOnlyMessages } from "../apps/web/src/chat-device-only-messages";
import {
  acceptedSendsMissingFrom,
  applyThreadRead,
  noteBubbleAccepted,
  forgetAcceptedSends,
  noteAcceptedSend,
  notePendingSend
} from "../apps/web/src/messaging/recent-sends";

const sent = (id: string, clientMessageId = `client-${id}`) =>
  ({ id, clientMessageId, author: "merchant", body: id, status: "sent" }) as never;

afterEach(() => forgetAcceptedSends());

describe("accepted sends survive a thread read that started before them", () => {
  it("keeps an accepted send the server answer does not have yet, marked as this device's copy", () => {
    noteAcceptedSend("c1", sent("m1"), 1_000);
    expect(acceptedSendsMissingFrom("c1", [], 2_000)).toEqual([
      expect.objectContaining({ id: "m1", deviceOnlyIn: "c1" })
    ]);
  });

  it("forgets it once a read includes it, by server id or clientMessageId", () => {
    noteAcceptedSend("c1", sent("m1"), 1_000);
    noteAcceptedSend("c1", sent("m2"), 1_000);
    const server = [sent("m1"), { id: "server-x", clientMessageId: "client-m2" } as never];
    expect(acceptedSendsMissingFrom("c1", server, 2_000)).toEqual([]);
    expect(acceptedSendsMissingFrom("c1", [], 3_000)).toEqual([]);
  });

  it("expires after two minutes and keeps conversations apart", () => {
    noteAcceptedSend("c1", sent("m1"), 0);
    noteAcceptedSend("c2", sent("m2"), 0);
    expect(acceptedSendsMissingFrom("c2", [], 1_000).map((m) => (m as { id: string }).id)).toEqual([
      "m2"
    ]);
    expect(acceptedSendsMissingFrom("c1", [], 120_001)).toEqual([]);
  });

  it("forgets everything when the account changes", () => {
    noteAcceptedSend("c1", sent("m1"), 0);
    forgetAcceptedSends();
    expect(acceptedSendsMissingFrom("c1", [], 1)).toEqual([]);
  });

  it("keeps a typed send that has not reached the outbox, in its on-screen state", () => {
    // The send awaits the agent runtime session first: a read landing then has no copy of it.
    notePendingSend("c1", { ...sent("client-1"), status: "pending" } as never, 1_000);
    const onScreen = [{ ...sent("client-1"), status: "sending" }] as never[];
    expect(acceptedSendsMissingFrom("c1", [], 2_000, onScreen)).toEqual([
      expect.objectContaining({ id: "client-1", status: "sending", deviceOnlyIn: "c1" })
    ]);
  });

  it("never brings back a pending send whose bubble left the screen (cancelled: text back in the box)", () => {
    notePendingSend("c1", sent("client-1"), 1_000);
    // Off screen: not kept, by every read that sees it off screen.
    expect(acceptedSendsMissingFrom("c1", [], 2_000, [])).toEqual([]);
    expect(acceptedSendsMissingFrom("c1", [], 3_000, [sent("other")] as never[])).toEqual([]);
    // Gone for good after the window, whatever the screen shows.
    expect(acceptedSendsMissingFrom("c1", [], 121_001, [sent("client-1")] as never[])).toEqual([]);
  });

  it("does not lose a send in progress to a view of the screen taken before it rendered", () => {
    notePendingSend("c1", sent("client-1"), 1_000);
    // A stale view without the bubble, then the real one with it.
    expect(acceptedSendsMissingFrom("c1", [], 1_100, [])).toEqual([]);
    expect(
      acceptedSendsMissingFrom("c1", [], 1_200, [sent("client-1")] as never[]).map(
        (message) => (message as { id: string }).id
      )
    ).toEqual(["client-1"]);
  });

  it("forgets a pending send once a read has it under its client id", () => {
    notePendingSend("c1", sent("client-1"), 1_000);
    const server = [{ id: "server-1", clientMessageId: "client-1" } as never];
    expect(acceptedSendsMissingFrom("c1", server, 2_000, [sent("client-1")] as never[])).toEqual(
      []
    );
  });

  it("is not matched by a read's messages that have no client id (greeting, agent replies)", () => {
    // The typed bubble has no clientMessageId field; neither has the greeting. They must not match.
    const typed = { id: "client-1", author: "merchant", body: "hi", status: "queued" } as never;
    notePendingSend("c1", typed, 1_000);
    noteAcceptedSend("c1", { id: "server-2", author: "merchant", body: "yo" } as never, 1_000);
    const greeting = [{ id: "welcome", author: "assistant", body: "Karibu" } as never];
    expect(
      acceptedSendsMissingFrom("c1", greeting, 2_000, [typed]).map((m) => (m as { id: string }).id)
    ).toEqual(["client-1", "server-2"]);
  });

  it("places a kept send after everything the server has, not at the top of the thread", () => {
    noteAcceptedSend("c1", sent("srv-9"), 1_000);
    const server = ["a", "b", "c"].map((id) => sent(id));
    const shown = keepDeviceOnlyMessages(
      server,
      server,
      "c1",
      acceptedSendsMissingFrom("c1", server, 2_000)
    );
    expect(shown.map((message) => message.id)).toEqual(["a", "b", "c", "srv-9"]);
  });

  it("shows a send once when a read lands between its acceptance and the next render", () => {
    const bubble = { id: "client-1", author: "merchant", body: "hi", status: "sending" } as never;
    notePendingSend("c1", bubble, 1_000);
    noteBubbleAccepted("c1", bubble, "server-1", 1_500);
    // The screen still has the client-id bubble (no render yet); the read has neither.
    const kept = acceptedSendsMissingFrom("c1", [], 2_000, [bubble]);
    expect(kept.map((message) => [message.id, message.clientMessageId, message.status])).toEqual([
      ["server-1", "client-1", "sent"]
    ]);
  });

  it("does not keep a resent message marked as waiting once it is accepted", () => {
    noteAcceptedSend("c1", { ...sent("server-1"), outboxState: "retrying" } as never, 1_000);
    expect(acceptedSendsMissingFrom("c1", [], 2_000)[0]).not.toHaveProperty("outboxState");
  });

  it("drops expired sends of conversations that are never read again", () => {
    noteAcceptedSend("old", sent("m1"), 0);
    noteAcceptedSend("new", sent("m2"), 120_001);
    // Back inside the window for "old": it was already pruned when "new" was noted.
    expect(acceptedSendsMissingFrom("old", [], 1_000)).toEqual([]);
  });

  it("applies a read to the thread as it is then: a send cancelled before it lands stays gone", () => {
    const greeting = { id: "welcome", author: "assistant", body: "Karibu" } as never;
    const typed = { id: "client-1", author: "merchant", body: "hi", status: "pending" } as never;
    notePendingSend("c1", typed, 1_000);
    // The read's answer arrives (it does not have the send) while the bubble is on screen...
    const apply = applyThreadRead({
      conversationId: "c1",
      serverMessages: [greeting],
      known: [],
      waiting: [],
      now: 1_100
    });
    // ...and the user cancels (text back in the box) before the update runs.
    expect(apply([greeting]).map((m) => m.id)).toEqual(["welcome"]);
    // Applied while the bubble is still there instead, it keeps it, after the server's messages.
    expect(apply([greeting, typed]).map((m) => m.id)).toEqual(["welcome", "client-1"]);
    // Idempotent: running the updater twice (React may) gives the same thread.
    expect(apply(apply([greeting, typed])).map((m) => m.id)).toEqual(["welcome", "client-1"]);
  });
});
