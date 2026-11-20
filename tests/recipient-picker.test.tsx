// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ConversationInboxItem } from "@grogoni/shared-types";
import { RecipientPicker, normalizedRecipient } from "../apps/web/src/RecipientPicker";

describe("new message recipient picker", () => {
  it.each([
    ["0712 345678", "+254712345678"],
    ["0112-345-678", "+254112345678"],
    ["+254733123456", "+254733123456"],
    ["254770123456", "+254770123456"],
    ["+44 20 7946 0000", "+442079460000"],
    ["+1 202 555 0123", "+12025550123"],
    [" Person@Example.com ", "person@example.com"],
    ["123", null],
    ["*144#", null],
    ["garbage", null]
  ])("normalizes %s", (input, expected) => {
    expect(normalizedRecipient(input)).toBe(expected);
  });
  it("lets the user choose either number returned by the browser contact picker", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    const root = createRoot(host);
    const choose = vi.fn();
    const adapter = {
      source: "browser" as const,
      isSupported: () => true,
      select: vi.fn(async () => [{ name: ["Amina"], tel: ["0712 345678", "+442079460000"] }])
    };
    try {
      await act(async () =>
        root.render(
          <RecipientPicker
            contacts={[]}
            recent={[]}
            onChoose={choose}
            onOpen={() => undefined}
            onSms={() => undefined}
            onClose={() => undefined}
            adapter={adapter}
          />
        )
      );
      await act(async () =>
        Array.from(host.querySelectorAll("button"))
          .find((button) => button.textContent === "Choose from contacts")!
          .click()
      );
      expect(host.textContent).toContain("+254712345678");
      expect(host.textContent).toContain("+442079460000");
      await act(async () =>
        Array.from(host.querySelectorAll("button"))
          .find((button) => button.textContent === "Phone: +442079460000")!
          .click()
      );
      expect(choose).toHaveBeenCalledWith("+442079460000", "Amina");
    } finally {
      act(() => root.unmount());
    }
  });
  it("keeps manual entry usable after denied contacts access and shows every saved number", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const choose = vi.fn();
    const adapter = {
      source: "browser" as const,
      isSupported: () => true,
      select: vi.fn(async () => {
        throw new Error("denied");
      })
    };
    try {
      await act(async () =>
        root.render(
          <RecipientPicker
            contacts={[
              {
                name: "Amina",
                phone: "+254712345678",
                phones: [
                  { e164: "+254712345678", label: "Mobile" },
                  { e164: "+442079460000", label: "Work" }
                ],
                email: null,
                nodeId: null
              }
            ]}
            recent={[]}
            onChoose={choose}
            onOpen={() => undefined}
            onSms={() => undefined}
            onClose={() => undefined}
            adapter={adapter}
          />
        )
      );
      expect(adapter.select).not.toHaveBeenCalled();
      await act(async () =>
        Array.from(host.querySelectorAll("button"))
          .find((button) => button.textContent === "Choose from contacts")!
          .click()
      );
      expect(host.textContent).toContain("enable contacts access");
      expect(host.querySelector("input")?.disabled).toBe(false);
      await act(async () =>
        Array.from(host.querySelectorAll("button"))
          .find((button) => button.textContent?.includes("Work:"))!
          .click()
      );
      expect(choose).toHaveBeenCalledWith("+442079460000", "Amina");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  function renderPicker(
    recent: Array<{
      id: string;
      title: string | null;
      helpTopic?: string | null;
      isPermanentDaemon?: boolean;
    }>,
    handlers: { choose?: () => void; open?: (id: string) => void; sms?: () => void } = {}
  ) {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <RecipientPicker
          contacts={[]}
          recent={
            recent.map((item) => ({
              helpTopic: null,
              isPermanentDaemon: false,
              ...item
            })) as unknown as ConversationInboxItem[]
          }
          onChoose={handlers.choose ?? (() => undefined)}
          onOpen={handlers.open ?? (() => undefined)}
          onSms={handlers.sms ?? (() => undefined)}
          onClose={() => undefined}
          adapter={{ source: "browser", isSupported: () => false, select: vi.fn() }}
        />
      )
    );
    const buttons = () => Array.from(host.querySelectorAll("button")).map((b) => b.textContent);
    const type = (value: string) =>
      act(() => {
        const input = host.querySelector("input")!;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const click = (label: string) =>
      act(() =>
        Array.from(host.querySelectorAll("button"))
          .find((button) => button.textContent === label)!
          .click()
      );
    const cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    return { host, buttons, type, click, cleanup };
  }

  it("lists recent conversations by title, skips help topics, filters by the search and caps at 12", () => {
    const open = vi.fn();
    const recent = [
      { id: "help", title: "How do I add stock?", helpTopic: "stock" },
      { id: "assistant", title: "Your daemon", isPermanentDaemon: true },
      ...Array.from({ length: 14 }, (_, index) => ({ id: `c${index}`, title: `Jane ${index}` }))
    ];
    const picker = renderPicker(recent, { open });
    try {
      const listed = picker.buttons();
      expect(listed).not.toContain("How do I add stock?");
      expect(listed).toContain("My Assistant");
      expect(listed).not.toContain("Your daemon");
      // My Assistant plus the first 11 others: twelve recents at most.
      expect(
        listed.filter((label) => label === "My Assistant" || /^Jane \d+$/u.test(label!))
      ).toHaveLength(12);
      picker.type("jane 13");
      expect(picker.buttons().filter((label) => /^Jane/u.test(label!))).toEqual(["Jane 13"]);
      picker.click("Jane 13");
      expect(open).toHaveBeenCalledWith("c13");
    } finally {
      picker.cleanup();
    }
  });

  it("makes the transport an explicit choice: Grogoni chat or SMS for a number, Grogoni only for email", () => {
    const choose = vi.fn();
    const sms = vi.fn();
    const picker = renderPicker([], { choose, sms });
    try {
      picker.type("0712 345678");
      expect(picker.host.textContent).toContain(
        "Grogoni messages use end-to-end encryption. SMS uses your carrier."
      );
      expect(picker.buttons()).toEqual(
        expect.arrayContaining(["Open Grogoni chat", "Send as SMS"])
      );
      picker.click("Send as SMS");
      expect(sms).toHaveBeenCalledWith("+254712345678", "");
      expect(choose).not.toHaveBeenCalled();
      picker.click("Open Grogoni chat");
      expect(choose).toHaveBeenCalledWith("+254712345678", "");

      picker.type("Person@Example.com");
      expect(picker.buttons()).toContain("Open Grogoni chat");
      expect(picker.buttons()).not.toContain("Send as SMS");

      picker.type("12345");
      expect(picker.buttons()).not.toContain("Open Grogoni chat");
      expect(picker.host.textContent).toContain("enter a valid full phone number or email");
    } finally {
      picker.cleanup();
    }
  });
});
