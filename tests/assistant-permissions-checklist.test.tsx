// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { defaultAssistantPermissions } from "../packages/shared-types/src";
import { AssistantPermissionsChecklist } from "../apps/web/src/AssistantPermissionsChecklist";
import { fetchFreshJson, putJson } from "../apps/web/src/api-helpers";
vi.mock("../apps/web/src/api-helpers", () => ({ fetchFreshJson: vi.fn(), putJson: vi.fn() }));
it("shows the defaults and saves a grant only after the server accepts it", async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const view = {
    conversationId: "assistant",
    permissions: defaultAssistantPermissions(),
    functions: [
      { id: "commerce.checkout", action: "buy", label: "Marketplace checkout", storeRelated: false }
    ]
  };
  vi.mocked(fetchFreshJson).mockResolvedValue(view);
  vi.mocked(putJson).mockResolvedValue({
    ...view,
    permissions: { ...view.permissions, buy: false }
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<AssistantPermissionsChecklist conversationId="assistant" />)
    );
    const labels = Array.from(host.querySelectorAll("label"));
    const checkbox = (name: string) =>
      labels
        .find((label) => label.querySelector("strong")?.textContent === name)!
        .querySelector("input")!;
    for (const name of ["Read", "Edit", "Buy and order", "Set up a store"])
      expect(checkbox(name).checked).toBe(true);
    await act(async () => checkbox("Buy and order").click());
    expect(putJson).toHaveBeenCalledWith("/v1/conversations/assistant/permissions", { buy: false });
    expect(checkbox("Buy and order").checked).toBe(false);
    expect(host.textContent).toContain("Marketplace checkout");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
