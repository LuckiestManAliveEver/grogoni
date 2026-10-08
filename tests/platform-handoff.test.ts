import { describe, expect, it, vi } from "vitest";
import {
  formatExternalShareText,
  shareMessageExternally
} from "../apps/web/src/messaging/platform-handoff";

describe("cross-platform message handoff", () => {
  it("uses the operating-system share sheet for installed messaging and device targets", async () => {
    const share = vi.fn().mockResolvedValue(undefined);

    const result = await shareMessageExternally(
      { text: "Hello from Grogoni", title: "Message for Jane" },
      { share }
    );

    expect(share).toHaveBeenCalledWith({
      text: "Hello from Grogoni",
      title: "Message for Jane"
    });
    expect(result).toEqual({
      channel: "platform_share_sheet",
      status: "share_completed",
      errorCode: null,
      usedShareSheet: true
    });
  });

  it("does not report a cancelled share as sent", async () => {
    const result = await shareMessageExternally(
      { text: "Hello" },
      { share: vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError")) }
    );

    expect(result).toMatchObject({
      status: "share_cancelled",
      errorCode: null,
      usedShareSheet: true
    });
  });

  it("copies text when a share sheet is unavailable", async () => {
    const writeClipboard = vi.fn().mockResolvedValue(undefined);

    const result = await shareMessageExternally(
      { text: "Hello", url: "https://grogoni.com/shop/example" },
      { writeClipboard }
    );

    expect(writeClipboard).toHaveBeenCalledWith("Hello\nhttps://grogoni.com/shop/example");
    expect(result).toMatchObject({
      status: "copied_to_clipboard",
      errorCode: null,
      usedShareSheet: false
    });
  });

  it("returns a controlled unavailable state without a share or clipboard capability", async () => {
    await expect(shareMessageExternally({ text: "Hello" }, {})).resolves.toMatchObject({
      status: "share_unavailable",
      errorCode: "external_share_unavailable"
    });
  });

  it("rejects an empty handoff and keeps URLs on a separate line", async () => {
    expect(formatExternalShareText({ text: " Hello ", url: " https://example.com " })).toBe(
      "Hello\nhttps://example.com"
    );
    await expect(shareMessageExternally({ text: "  " }, {})).resolves.toMatchObject({
      status: "share_unavailable",
      errorCode: "empty_share_message"
    });
  });
});
