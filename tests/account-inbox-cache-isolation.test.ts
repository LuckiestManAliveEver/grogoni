// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../apps/web/src/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("../apps/web/src/offline-runtime", () => ({ isExplicitOfflineMode: () => false }));
import { apiFetch } from "../apps/web/src/lib/api";
import { clearApiRequestCache, getCachedJson } from "../apps/web/src/api-request-cache";
function account(id: string) {
  localStorage.setItem(
    "grogoni.auth-bootstrap.v1",
    JSON.stringify({
      account: { id },
      user: { id },
      session: { id, expiresAt: "2099-01-01T00:00:00Z" },
      cachedAt: "2026-10-23T00:00:00Z"
    })
  );
}
beforeEach(() => {
  clearApiRequestCache();
  localStorage.clear();
  vi.mocked(apiFetch).mockReset();
});
afterEach(() => localStorage.clear());
it("does not reuse another account's in-memory private conversation or network response", async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ conversations: ["private-a"] })
    .mockResolvedValueOnce({ conversations: ["private-b"] });
  account("a");
  expect(await getCachedJson("/v1/conversations")).toEqual({ conversations: ["private-a"] });
  account("b");
  expect(await getCachedJson("/v1/conversations")).toEqual({ conversations: ["private-b"] });
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it("drops an old account's in-flight result after a switch", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  account("a");
  const update = vi.fn();
  const pending = getCachedJson("/network", { onBackgroundUpdate: update });
  await vi.waitFor(() => expect(finish).toBeDefined());
  account("b");
  finish({ ownerUserId: "private-a" });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(update).not.toHaveBeenCalled();
});
