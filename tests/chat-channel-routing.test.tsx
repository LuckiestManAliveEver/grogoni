// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ChannelEndpointSummary } from "@grogoni/shared-types";
import { useChatComposerState } from "../apps/web/src/hooks/useChatComposerState";
import {
  externalMessagingApps,
  openExternalMessagingApp
} from "../apps/web/src/messaging/external-app-handoff";
import { ExternalMessagingAppPicker } from "../apps/web/src/ExternalMessagingAppPicker";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("explicit messaging routes", () => {
  it("keeps normal and explicit external choices across endpoint refreshes and never falls back silently", async () => {
    const send = vi.fn();
    let hook: ReturnType<typeof useChatComposerState>;
    const endpoint = {
      channelId: "email",
      provider: "email",
      status: "available",
      configured: true,
      authorized: true,
      capabilities: ["CAN_INITIATE"]
    } as ChannelEndpointSummary;
    function Harness({
      endpoints,
      conversation = "first"
    }: {
      endpoints: ChannelEndpointSummary[];
      conversation?: string;
    }) {
      hook = useChatComposerState({
        activeConversationId: conversation,
        channelEndpoints: endpoints,
        chatDraft: "Draft only",
        initialEmailSubject: "Subject",
        nearbyScope: null,
        smsDefaultCountry: "GB",
        onDraftChange: vi.fn(),
        onPlatformHandoff: vi.fn(),
        onSend: send
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(createElement(Harness, { endpoints: [endpoint] })));
      expect(hook!.selectedProvider).toBeNull();
      await act(async () => hook!.setSelectedProvider("email"));
      await act(async () => root.render(createElement(Harness, { endpoints: [{ ...endpoint }] })));
      expect(hook!.selectedProvider).toBe("email");
      await act(async () => hook!.setSelectedProvider(null));
      await act(async () => root.render(createElement(Harness, { endpoints: [{ ...endpoint }] })));
      expect(hook!.selectedProvider).toBeNull();
      await act(async () => hook!.sendLiveDraft());
      expect(send).toHaveBeenLastCalledWith("Draft only", "grogoni", undefined, undefined);
      await act(async () => hook!.setSelectedProvider("telegram"));
      await act(async () => root.render(createElement(Harness, { endpoints: [endpoint] })));
      await act(async () => hook!.sendLiveDraft());
      expect(send.mock.calls.at(-1)?.[1]).toBe("telegram");
      await act(async () =>
        root.render(createElement(Harness, { endpoints: [endpoint], conversation: "second" }))
      );
      expect(hook!.selectedProvider).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
  it.each(externalMessagingApps)(
    "opens only the selected $label destination and copies the draft without sending",
    async (app) => {
      const order: string[] = [];
      const open = vi.fn((url: string) => {
        order.push("open");
        expect(url).toBe(app.url);
        return true;
      });
      const copy = vi.fn(async (text: string) => {
        order.push("copy");
        expect(text).toBe("Private draft");
      });
      expect(await openExternalMessagingApp(app.id, "Private draft", { open, copy })).toEqual({
        opened: true,
        copied: true
      });
      expect(order).toEqual(["open", "copy"]);
      expect(open.mock.calls[0]?.[0]).not.toContain("Private");
    }
  );
  it("keeps a manual-copy path when clipboard access fails and rejects unknown destinations", async () => {
    const open = vi.fn(() => true);
    expect(
      await openExternalMessagingApp("instagram", "Draft", {
        open,
        copy: async () => {
          throw new Error("denied");
        }
      })
    ).toEqual({ opened: true, copied: false });
    expect(await openExternalMessagingApp("untrusted" as "instagram", "Draft", { open })).toEqual({
      opened: false,
      copied: false
    });
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("renders all app handoffs and keeps the full draft available for manual copying", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          createElement(ExternalMessagingAppPicker, {
            open: true,
            text: "Keep this draft",
            onClose: vi.fn(),
            onSystemShare: vi.fn()
          })
        )
      );
      const dialog = document.querySelector(
        '[aria-labelledby="composer-external-app-picker-title"]'
      );
      for (const app of externalMessagingApps)
        expect(dialog?.textContent).toContain(`Open ${app.label}`);
      expect(dialog?.querySelector("textarea")?.value).toBe("Keep this draft");
      expect(dialog?.querySelector("textarea")?.readOnly).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
