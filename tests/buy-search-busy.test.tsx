// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type * as ApiHelpers from "../apps/web/src/api-helpers";

vi.mock("../apps/web/src/api-helpers", async () => {
  const actual = await vi.importActual<typeof ApiHelpers>("../apps/web/src/api-helpers");
  return { ...actual, getJson: vi.fn() };
});

const { getJson } = await import("../apps/web/src/api-helpers");
const { useBuyCartState } = await import("../apps/web/src/hooks/useBuyCartState");

/**
 * A chat search made while another search is running (the marketplace sheet's) used to come back
 * as null, and the chat told the buyer to check their connection. It runs on its own instead.
 */
describe("buy search while another is running", () => {
  it("still searches, and returns the result", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const feed = { query: "sugar", results: [], marketplaceConnectorAvailable: true };
    vi.mocked(getJson).mockResolvedValue(feed);
    const statuses: string[] = [];
    let search: ((query: string) => Promise<unknown>) | null = null;
    function Harness() {
      const state = useBuyCartState({
        // The key is already taken: runAction does not run the action.
        runAction: async () => undefined,
        setStatusMessage: (message) => statuses.push(message),
        buyCart: [],
        setBuyCart: () => undefined,
        setBuyFeed: () => undefined,
        setChatMessages: () => undefined
      });
      search = state.handleSearchBuyFeed;
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Harness />));
    let result: unknown;
    await act(async () => {
      result = await search!("sugar");
    });
    expect(result).toEqual(feed);
    expect(getJson).toHaveBeenCalledWith("/buy/search?query=sugar");
    expect(statuses).toEqual([]);
    act(() => root.unmount());
  });
});
