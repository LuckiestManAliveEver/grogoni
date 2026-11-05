// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRuntimeSelection } from "@grogoni/shared-types";
import type * as HelpersModule from "../apps/web/src/api-helpers";
vi.mock("../apps/web/src/AssistantPermissionsChecklist", () => ({
  AssistantPermissionsChecklist: () => null
}));

vi.mock("../apps/web/src/api-helpers", async () => {
  const actual = await vi.importActual<typeof HelpersModule>("../apps/web/src/api-helpers");
  return { ...actual, fetchFreshJson: vi.fn(), putJson: vi.fn() };
});

const { fetchFreshJson, putJson } = await import("../apps/web/src/api-helpers");
const { AssistantDetailsPanel } = await import("../apps/web/src/AssistantDetailsPanel");
const { conversationTitle, conversationTypeBadge, isAssistantConversation } =
  await import("../apps/web/src/conversation-title");

const conversationId = "6f1c9d8e-1b2a-4c3d-9e8f-0a1b2c3d4e5f";
const selection = (
  overrides: Partial<ConversationRuntimeSelection> = {}
): ConversationRuntimeSelection => ({
  conversationId,
  selectedAgentId: "grogoni",
  agents: [
    { id: "grogoni", label: "Grogoni agent" },
    { id: "pi", label: "Pi agent" }
  ],
  selectedModelId: "gpt-6-luna",
  models: [
    { id: "gpt-6-luna", label: "Luna" },
    { id: "model-b", label: "Model B" }
  ],
  available: true,
  errorCode: null,
  ...overrides
});

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

async function render() {
  await act(async () => {
    root.render(<AssistantDetailsPanel conversationId={conversationId} onClose={onClose} />);
  });
}
const select = (id: string) => document.getElementById(id) as HTMLSelectElement;
async function choose(id: string, value: string) {
  await act(async () => {
    const element = select(id);
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(fetchFreshJson).mockReset();
  vi.mocked(putJson).mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("My Assistant details panel", () => {
  it("shows the ID, the agent and the model it runs on", async () => {
    vi.mocked(fetchFreshJson).mockResolvedValue(selection());
    await render();
    expect(fetchFreshJson).toHaveBeenCalledWith(`/v1/conversations/${conversationId}/model`);
    expect(text()).toContain("My Assistant details");
    expect(text()).toContain(conversationId);
    expect(select("assistant-agent").value).toBe("grogoni");
    expect(select("assistant-model").value).toBe("gpt-6-luna");
    expect([...select("assistant-agent").options].map((o) => o.textContent)).toEqual([
      "Grogoni agent",
      "Pi agent"
    ]);
    expect([...select("assistant-model").options].map((o) => o.textContent)).toEqual([
      "Luna",
      "Model B"
    ]);
  });

  it("switches the agent and the model from the drop-down lists", async () => {
    vi.mocked(fetchFreshJson).mockResolvedValue(selection());
    vi.mocked(putJson)
      .mockResolvedValueOnce(selection({ selectedAgentId: "pi" }))
      .mockResolvedValueOnce(selection({ selectedAgentId: "pi", selectedModelId: "model-b" }));
    await render();

    await choose("assistant-agent", "pi");
    expect(putJson).toHaveBeenLastCalledWith(`/v1/conversations/${conversationId}/model`, {
      agentId: "pi"
    });
    expect(select("assistant-agent").value).toBe("pi");
    expect(text()).toContain("My Assistant now runs on Pi agent.");

    await choose("assistant-model", "model-b");
    expect(putJson).toHaveBeenLastCalledWith(`/v1/conversations/${conversationId}/model`, {
      modelId: "model-b"
    });
    expect(select("assistant-model").value).toBe("model-b");
    expect(select("assistant-agent").value).toBe("pi");
    expect(text()).toContain("My Assistant now runs on Model B.");
  });

  it("keeps the previous choice and shows the error when a switch fails", async () => {
    vi.mocked(fetchFreshJson).mockResolvedValue(selection());
    vi.mocked(putJson).mockRejectedValue(new Error("The selected model is unavailable."));
    await render();
    await choose("assistant-model", "model-b");
    expect(select("assistant-model").value).toBe("gpt-6-luna");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "The selected model is unavailable."
    );
  });

  it("says when a model switch also moved the assistant to another agent", async () => {
    vi.mocked(fetchFreshJson).mockResolvedValue(
      selection({
        selectedAgentId: "pi",
        agents: [{ id: "grogoni", label: "Grogoni agent" }],
        available: false,
        errorCode: "model_unavailable"
      })
    );
    vi.mocked(putJson).mockResolvedValue(
      selection({
        selectedAgentId: "grogoni",
        agents: [{ id: "grogoni", label: "Grogoni agent" }],
        selectedModelId: "model-b"
      })
    );
    await render();
    await choose("assistant-model", "model-b");
    expect(text()).toContain("My Assistant now runs on Model B with the Grogoni agent.");
  });

  it("explains an unavailable current model and an empty model catalogue", async () => {
    vi.mocked(fetchFreshJson).mockResolvedValue(
      selection({
        selectedAgentId: null,
        selectedModelId: null,
        models: [],
        available: false,
        errorCode: "RUNTIME_DEFAULT_MISSING"
      })
    );
    await render();
    expect(text()).toContain("The current model is unavailable. (RUNTIME_DEFAULT_MISSING)");
    // With nothing configured there is no other model to pick: no contradictory advice.
    expect(text()).not.toContain("Pick another model");
    expect(text()).toContain("No models are configured on this server yet.");
    expect(select("assistant-model").disabled).toBe(true);
    expect(select("assistant-agent").value).toBe("");
    expect(select("assistant-agent").disabled).toBe(true);
    const hint = select("assistant-agent").getAttribute("aria-describedby");
    expect(document.getElementById(hint!)?.textContent).toBe(
      "No models are configured on this server yet."
    );
  });

  it("disables the agent while the selected model is no longer configured", async () => {
    vi.mocked(fetchFreshJson).mockResolvedValue(
      selection({
        selectedAgentId: "pi",
        selectedModelId: "retired",
        available: false,
        errorCode: "model_unavailable"
      })
    );
    await render();
    expect(select("assistant-agent").value).toBe("pi");
    expect(select("assistant-agent").disabled).toBe(true);
    expect(select("assistant-model").value).toBe("retired");
    expect(text()).toContain(
      "The current model is unavailable. Pick another model. (model_unavailable)"
    );
  });

  it("asks for a model before the agent when the current runtime is unavailable", async () => {
    vi.mocked(fetchFreshJson).mockResolvedValue(
      selection({ selectedAgentId: null, selectedModelId: null, available: false })
    );
    await render();
    expect(select("assistant-agent").disabled).toBe(true);
    expect(select("assistant-model").disabled).toBe(false);
    expect(text()).toContain("Choose a model first.");
    const hint = select("assistant-agent").getAttribute("aria-describedby");
    expect(document.getElementById(hint!)?.textContent).toContain("Choose a model first.");
    // The placeholder cannot be chosen, so an empty id is never sent.
    const placeholder = select("assistant-model").options[0]!;
    expect(placeholder.value).toBe("");
    expect(placeholder.disabled).toBe(true);
  });
});

describe("My Assistant details panel while saving or failing", () => {
  it("keeps the drop-downs focusable while a switch is saved and ignores input meanwhile", async () => {
    vi.mocked(fetchFreshJson).mockResolvedValue(selection());
    let finish: (value: ConversationRuntimeSelection) => void = () => undefined;
    vi.mocked(putJson).mockReturnValue(
      new Promise<ConversationRuntimeSelection>((resolve) => (finish = resolve))
    );
    await render();
    // The panel takes focus one frame after it opens; the person then tabs to the drop-down.
    await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    select("assistant-agent").focus();
    await choose("assistant-agent", "pi");
    // Not disabled: disabling the focused element would drop keyboard focus to the page.
    expect(select("assistant-agent").disabled).toBe(false);
    expect(select("assistant-agent").getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(select("assistant-agent"));
    expect(text()).toContain("Checking the agent…");
    // The choice being saved stays shown instead of snapping back to the old value.
    expect(select("assistant-agent").value).toBe("pi");
    await choose("assistant-model", "model-b");
    expect(putJson).toHaveBeenCalledTimes(1);
    await act(async () => finish(selection({ selectedAgentId: "pi" })));
    expect(select("assistant-agent").value).toBe("pi");
    expect(select("assistant-model").value).toBe("gpt-6-luna");
  });

  it("offers a retry when the details cannot be loaded", async () => {
    vi.mocked(fetchFreshJson)
      .mockRejectedValueOnce(new Error("Network unavailable."))
      .mockResolvedValueOnce(selection());
    await render();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Network unavailable.");
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again"
    )!;
    await act(async () => retry.click());
    expect(fetchFreshJson).toHaveBeenCalledTimes(2);
    expect(select("assistant-agent").value).toBe("grogoni");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("conversation titles", () => {
  it("always names the daemon conversation My Assistant and leaves other titles alone", () => {
    expect(conversationTitle({ isPermanentDaemon: true, title: "Your daemon" })).toBe(
      "My Assistant"
    );
    // conversationType DAEMON also covers help topics and owner-named agent sessions.
    expect(conversationTitle({ conversationType: "DAEMON", title: "Restock maize" })).toBe(
      "Restock maize"
    );
    expect(isAssistantConversation({ conversationType: "DAEMON" })).toBe(false);
    expect(isAssistantConversation({ isPermanentDaemon: true })).toBe(true);
    expect(conversationTitle({ conversationType: "DIRECT", title: "Mama Njeri" })).toBe(
      "Mama Njeri"
    );
    expect(conversationTitle({ conversationType: "BUSINESS" })).toBeNull();
    expect(conversationTitle(undefined)).toBeNull();
    expect(isAssistantConversation({ conversationType: "DIRECT" })).toBe(false);
    expect(conversationTypeBadge("DAEMON")).toBe("ASSISTANT");
    expect(conversationTypeBadge("BUSINESS")).toBe("BUSINESS");
    expect(conversationTypeBadge(undefined)).toBeNull();
  });
});
