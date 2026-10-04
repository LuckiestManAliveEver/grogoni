// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkConnectionSummary } from "@grogoni/shared-types";

const fetchFreshJson = vi.fn();
const postJson = vi.fn();

vi.mock("../apps/web/src/api-helpers", () => ({
  fetchFreshJson: (...args: unknown[]) => fetchFreshJson(...args),
  getJson: (...args: unknown[]) => fetchFreshJson(...args),
  postJson: (...args: unknown[]) => postJson(...args)
}));

const { default: ConnectionRequestsPrompt } =
  await import("../apps/web/src/ConnectionRequestsPrompt");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = "2026-09-26T00:00:00.000Z";
function connection(overrides: Partial<NetworkConnectionSummary>): NetworkConnectionSummary {
  return {
    id: "c1",
    status: "pending",
    direction: "incoming",
    counterpartUserId: "u-eve",
    counterpartDisplayName: "Eve",
    counterpartBusinessName: "Eve Grocers",
    counterpartGrogoniId: null,
    nodeId: null,
    createdAt: at,
    updatedAt: at,
    respondedAt: null,
    ...overrides
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchFreshJson.mockReset();
  postJson.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => root.render(<ConnectionRequestsPrompt accountId="acct" />));
}

describe("ConnectionRequestsPrompt", () => {
  it("shows only requests waiting for this person and accepts one", async () => {
    fetchFreshJson.mockResolvedValue({
      connections: [
        connection({}),
        connection({ id: "c2", direction: "outgoing", counterpartDisplayName: "Mine" }),
        connection({ id: "c3", status: "accepted", counterpartDisplayName: "Friend" })
      ]
    });
    postJson.mockResolvedValue({ connection: connection({ status: "accepted" }) });
    const changed = vi.fn();
    window.addEventListener("grogoni:network-changed", changed);
    await render();

    expect(fetchFreshJson).toHaveBeenCalledWith("/network/connections");
    expect(container.textContent).toContain("Eve wants to connect on Grogoni");
    expect(container.textContent).toContain("Eve Grocers");
    expect(container.textContent).not.toContain("Mine");
    expect(container.textContent).not.toContain("Friend");

    const accept = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Accept"
    )!;
    await act(async () => accept.click());
    expect(postJson).toHaveBeenCalledWith("/network/connections/c1/respond", { accept: true });
    expect(container.textContent).toContain("You are now connected with Eve.");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("wants to connect");
  });

  it("renders nothing when nothing is waiting or the check fails", async () => {
    fetchFreshJson.mockRejectedValue(new Error("pin required"));
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("checks again when the app comes back to the foreground", async () => {
    fetchFreshJson.mockResolvedValue({ connections: [] });
    await render();
    fetchFreshJson.mockResolvedValue({ connections: [connection({})] });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.textContent).toContain("Eve wants to connect");
  });
  it("drops a request answered in the Phone Contacts card", async () => {
    fetchFreshJson.mockResolvedValue({ connections: [connection({})] });
    await render();
    expect(container.textContent).toContain("Eve wants to connect");

    fetchFreshJson.mockResolvedValue({ connections: [] });
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent("grogoni:network-changed", { detail: { source: "network-state" } })
      )
    );
    expect(container.innerHTML).toBe("");
  });
  it("rechecks and tells the network card when the service worker reports a change", async () => {
    const serviceWorker = new EventTarget();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
    fetchFreshJson.mockResolvedValue({ connections: [] });
    await render();
    const changed = vi.fn();
    window.addEventListener("grogoni:network-changed", changed);

    fetchFreshJson.mockResolvedValue({ connections: [connection({})] });
    await act(async () => {
      serviceWorker.dispatchEvent(
        new MessageEvent("message", { data: { type: "network.connection.changed" } })
      );
    });

    expect(changed).toHaveBeenCalled();
    expect(container.textContent).toContain("Eve wants to connect");
    window.removeEventListener("grogoni:network-changed", changed);
    Reflect.deleteProperty(navigator, "serviceWorker");
  });
});
