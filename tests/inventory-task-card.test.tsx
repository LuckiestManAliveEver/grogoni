// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusinessExecutionTaskView } from "@grogoni/shared-types";
import InventoryTaskCard from "../apps/web/src/InventoryTaskCard";
import { requestRequiresServerTool } from "../apps/web/src/chat-message-plumbing";

const api = vi.hoisted(() => ({ fetchFreshJson: vi.fn(), postJson: vi.fn() }));
vi.mock("../apps/web/src/api-helpers", () => api);
const fixture = (
  overrides: Partial<BusinessExecutionTaskView> = {}
): BusinessExecutionTaskView => ({
  taskId: "task",
  businessId: "business",
  environmentName: "Inventory",
  objective: "Prepare stock replenishment",
  status: "COMPLETED",
  revision: 4,
  verificationStatus: "PASSED",
  budgetMinor: 1500000,
  currency: "KES",
  horizonDays: 3,
  reason: null,
  issues: [],
  steps: [],
  evaluation: null,
  experienceRetained: null,
  orders: [
    {
      id: "draft",
      supplierName: "Jane's wholesale",
      totalMinor: 125000,
      currency: "KES",
      submissionStatus: "NOT_SUBMITTED",
      requiresSubmissionApproval: true,
      items: [{ productName: "Rice", quantityMilli: 2500, unit: "kg", totalMinor: 125000 }]
    }
  ],
  ...overrides
});

describe("verified inventory task card", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    api.fetchFreshJson.mockResolvedValue(fixture());
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  async function render() {
    await act(async () => {
      root.render(<InventoryTaskCard businessId="business" taskId="task" />);
    });
  }
  async function click(label: string) {
    const button = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === label || item.getAttribute("aria-label") === label
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
  }
  it("reads fresh native results, showing drafts and never offering supplier submission", async () => {
    await render();
    expect(api.fetchFreshJson).toHaveBeenCalledWith("/businesses/business/runtime/tasks/task/view");
    expect(host.textContent).toContain("Drafts verified");
    expect(host.textContent).toContain("Jane's wholesale");
    expect(host.textContent).toContain("2.5 kg");
    expect(host.textContent).toContain("Not submitted");
    expect(host.textContent).not.toContain("Approve");
    expect(host.textContent).not.toContain("Cancel task");
  });
  it("resumes only with the displayed revision and shows the authoritative response", async () => {
    api.fetchFreshJson.mockResolvedValue(
      fixture({ status: "INCOMPLETE", verificationStatus: "INCONCLUSIVE", orders: [] })
    );
    api.postJson.mockResolvedValue(fixture());
    await render();
    await click("Resume");
    expect(api.postJson).toHaveBeenCalledWith("/businesses/business/runtime/tasks/task/control", {
      command: "RESUME",
      revision: 4
    });
    expect(host.textContent).toContain("Drafts verified");
  });
  it("shows journal steps without treating recorded execution as verified success", async () => {
    api.fetchFreshJson.mockResolvedValue(
      fixture({
        status: "VERIFYING",
        verificationStatus: "NOT_VERIFIED",
        steps: [
          { id: "prepare", label: "Prepare purchase drafts", status: "VERIFYING" },
          { id: "reconcile", label: "Reconcile interrupted execution", status: "INCONCLUSIVE" }
        ]
      })
    );
    await render();
    expect(host.textContent).toContain("Execution steps");
    expect(host.textContent).toContain("Prepare purchase drafts");
    expect(host.textContent).toContain("Execution recorded");
    expect(host.textContent).toContain("Needs reconciliation");
    expect(host.textContent).not.toContain("Drafts verified");
  });
  it("requires cancellation confirmation", async () => {
    api.fetchFreshJson.mockResolvedValue(fixture({ status: "RUNNING" }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await render();
    await click("Cancel task");
    expect(api.postJson).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
  it("fails closed on a stale revision instead of leaving actionable cached controls", async () => {
    api.fetchFreshJson.mockResolvedValue(fixture({ status: "SUSPENDED" }));
    api.postJson.mockRejectedValue(new Error("Revision conflict"));
    await render();
    await click("Resume");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Resume");
    expect(host.querySelector('[aria-label="Refresh task"]')).not.toBeNull();
  });
  it("does not render a response belonging to another business", async () => {
    api.fetchFreshJson.mockResolvedValue(fixture({ businessId: "other" }));
    await render();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Jane's wholesale");
  });
  it("routes inventory goals and clarification through the server, not owner-device inference", () => {
    expect(
      requestRequiresServerTool(
        "Check my inventory, identify products likely to run out within three days, compare available suppliers, and prepare purchase orders within a KES 15,000 budget."
      )
    ).toBe(true);
    expect(requestRequiresServerTool("Restock my inventory within three days")).toBe(true);
    expect(requestRequiresServerTool("Hello there")).toBe(false);
  });
});
