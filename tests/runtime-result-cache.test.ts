import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  invalidate: vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
}));
vi.mock("../apps/web/src/lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../apps/web/src/api-request-cache", () => ({
  getCachedJson: vi.fn(),
  invalidateApiCacheForMutation: mocks.invalidate
}));
import { postJson } from "../apps/web/src/api-helpers";

beforeEach(() => vi.clearAllMocks());
describe("runtime results refresh inline business controls", () => {
  it.each([false, true])(
    "invalidates the affected shop after execution (message envelope: %s)",
    async (envelope) => {
      const runtime = {
        session: { businessId: "shop-1" },
        turn: {
          status: "completed",
          plan: { toolName: "product.create", executedAt: "2026-10-18T00:00:00Z" }
        }
      };
      mocks.fetch.mockResolvedValueOnce(envelope ? { runtime } : runtime);
      await postJson(envelope ? "/v1/messages" : "/businesses/shop-1/runtime/turns", {});
      expect(mocks.invalidate.mock.calls.map(([path]) => path)).toEqual([
        envelope ? "/v1/messages" : "/businesses/shop-1/runtime/turns",
        "/businesses/shop-1"
      ]);
    }
  );

  it.each(["needs_confirmation", "clarifying", "blocked", "rate_limited"])(
    "keeps existing controls during %s",
    async (status) => {
      mocks.fetch.mockResolvedValueOnce({
        session: { businessId: "shop-1" },
        turn: { status, plan: { executedAt: null } }
      });
      await postJson("/v1/messages", {});
      expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    }
  );
});
