import { describe, expect, it, vi } from "vitest";
import {
  buildJoinLink,
  captureJoinLink,
  clearPendingJoin,
  emailLink,
  readPendingJoin,
  smsLink,
  whatsAppLink
} from "../apps/web/src/staff-join-link";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  };
}

describe("staff join links", () => {
  it("builds a root link that needs no server route", () => {
    expect(buildJoinLink("https://grogoni.com", "inv 1", "a+b/c")).toBe(
      "https://grogoni.com/?staffInvite=inv+1&t=a%2Bb%2Fc"
    );
  });

  it("addresses SMS, WhatsApp and email to the exact invitee with the text encoded", () => {
    const body = "Join Shop & Co: https://grogoni.com/?staffInvite=1&t=x";
    expect(smsLink("+254712345678", body)).toBe(
      `sms:+254712345678?&body=${encodeURIComponent(body)}`
    );
    expect(whatsAppLink("+254712345678", body)).toBe(
      `https://wa.me/254712345678?text=${encodeURIComponent(body)}`
    );
    expect(emailLink("rider@example.com", "Join", body)).toBe(
      `mailto:rider@example.com?subject=Join&body=${encodeURIComponent(body)}`
    );
    // A crafted address cannot inject extra mailto fields.
    expect(emailLink("x@y.co?bcc=evil@z.co", "Join", "b")).toBe(
      "mailto:x@y.co%3Fbcc%3Devil@z.co?subject=Join&body=b"
    );
  });

  it("remembers an opened link and removes the secret from the address bar", () => {
    const storage = memoryStorage();
    const history = { state: { keep: true }, replaceState: vi.fn() };
    const captured = captureJoinLink(
      { href: "https://grogoni.com/?staffInvite=inv-1&t=secret&utm=x#top" },
      storage,
      history,
      1_000
    );
    expect(captured).toEqual({ invitationId: "inv-1", joinToken: "secret", savedAt: 1_000 });
    expect(history.replaceState).toHaveBeenCalledWith({ keep: true }, "", "/?utm=x#top");
    expect(readPendingJoin(storage, 2_000)).toEqual(captured);
    clearPendingJoin(storage);
    expect(readPendingJoin(storage, 2_000)).toBeNull();
  });

  it("ignores pages without a complete link, and forgets a link after a week", () => {
    const storage = memoryStorage();
    const history = { state: null, replaceState: vi.fn() };
    expect(
      captureJoinLink({ href: "https://grogoni.com/?staffInvite=inv-1" }, storage, history)
    ).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
    captureJoinLink({ href: "https://grogoni.com/?staffInvite=i&t=s" }, storage, history, 0);
    expect(readPendingJoin(storage, 8 * 24 * 60 * 60 * 1000)).toBeNull();
    expect(storage.getItem("grogoni.staffInvite.pending")).toBeNull();
  });
});
