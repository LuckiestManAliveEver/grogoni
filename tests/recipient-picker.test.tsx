// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
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

  async function renderPicker(recent: unknown[] = []) {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const calls = { choose: vi.fn(), sms: vi.fn(), open: vi.fn() };
    await act(async () =>
      root.render(
        <RecipientPicker
          contacts={[]}
          recent={recent as never}
          onChoose={calls.choose}
          onOpen={calls.open}
          onSms={calls.sms}
          onClose={() => undefined}
        />
      )
    );
    const type = async (value: string) => {
      const input = host.querySelector("input[type='search']") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const button = (text: string) =>
      Array.from(host.querySelectorAll("button")).find((item) => item.textContent === text);
    return { host, root, calls, type, button };
  }

  it("keeps Grogoni chat and SMS as separate, explicit choices", async () => {
    const picker = await renderPicker();
    try {
      await picker.type("0712 345678");
      expect(picker.host.textContent).toContain("+254712345678");
      expect(picker.host.textContent).toContain("end-to-end encryption");
      await act(async () => picker.button("Open Grogoni chat")!.click());
      expect(picker.calls.choose).toHaveBeenCalledWith("+254712345678", "");
      expect(picker.calls.sms).not.toHaveBeenCalled();
      await act(async () => picker.button("Send as SMS")!.click());
      expect(picker.calls.sms).toHaveBeenCalledWith("+254712345678", "");
      // An email address can only be a Grogoni chat: no SMS option at all.
      await picker.type("Amina@Example.com");
      expect(picker.button("Open Grogoni chat")).toBeDefined();
      expect(picker.button("Send as SMS")).toBeUndefined();
    } finally {
      act(() => picker.root.unmount());
    }
  });

  it("lists recent conversations, searchable, without help topics, and opens the existing thread", async () => {
    const conversation = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
      id,
      title,
      kind: "personal",
      helpTopic: null,
      ...extra
    });
    const picker = await renderPicker([
      conversation("c-amina", "Amina Wanjiku"),
      conversation("c-otieno", "Otieno Hardware"),
      conversation("c-help", "Billing help", { helpTopic: "billing" })
    ]);
    try {
      const recents = () =>
        Array.from(picker.host.querySelectorAll("button"))
          .map((item) => item.textContent)
          .filter((text) => ["Amina Wanjiku", "Otieno Hardware", "Billing help"].includes(text!));
      expect(recents()).toEqual(["Amina Wanjiku", "Otieno Hardware"]);
      await picker.type("otie");
      expect(recents()).toEqual(["Otieno Hardware"]);
      await act(async () => picker.button("Otieno Hardware")!.click());
      expect(picker.calls.open).toHaveBeenCalledWith("c-otieno");
    } finally {
      act(() => picker.root.unmount());
    }
  });
});
