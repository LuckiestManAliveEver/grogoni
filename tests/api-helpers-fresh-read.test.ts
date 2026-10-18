// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the network edge is replaced; the shared response cache and api-helpers are the real ones.
const apiFetch = vi.fn();
vi.mock("../apps/web/src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args)
}));

const { fetchFreshJson, getJson } = await import("../apps/web/src/api-helpers");

describe("fetchFreshJson", () => {
  beforeEach(() => apiFetch.mockReset());

  it("always asks the server, even while the shared cache holds a fresh copy", async () => {
    const path = "/businesses/shop-fresh/fulfillment/default-policy";
    apiFetch.mockResolvedValueOnce({ version: 1 });
    expect(await getJson(path)).toEqual({ version: 1 });
    // Within the cache's stale time a cached GET serves the old copy without a request...
    expect(await getJson(path)).toEqual({ version: 1 });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    // ...so a form that edits this value must not use it: an agent changed it meanwhile.
    apiFetch.mockResolvedValueOnce({ version: 2 });
    expect(await fetchFreshJson(path)).toEqual({ version: 2 });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenLastCalledWith(path, { priority: true });
  });
});
