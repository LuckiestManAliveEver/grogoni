import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const apiHelpers = readFileSync("apps/web/src/api-helpers.ts", "utf8");
const apiCache = readFileSync("apps/web/src/api-request-cache.ts", "utf8");
const application = readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8");

const generatedManagementCards = [
  "ProductManagementCard.tsx",
  "SupplierManagementCard.tsx",
  "CustomerManagementCard.tsx",
  "InvoiceManagementCard.tsx",
  "LogisticsManagementCard.tsx",
  "PaymentManagementCard.tsx",
  "ImportManagementCard.tsx"
];

describe("end-to-end CRUD consistency", () => {
  it("invalidates caches before every shared JSON mutation resolves", () => {
    expect(apiHelpers.match(/await invalidateApiCacheForMutation\(path\);/g)).toHaveLength(4);
    expect(apiCache).toContain("subscribeToApiMutations");
    expect(apiCache).toContain("clearForLogout");
  });

  it("refreshes the central domain state after successful business mutations", () => {
    expect(application).toContain("subscribeToApiMutations");
    expect(application).toContain("allRefreshers().map");
    expect(application).toContain("shouldRefreshBusinessDomains");
  });

  it("refreshes independently mounted CRUD cards when their resources change", () => {
    for (const file of generatedManagementCards) {
      const source = readFileSync(`apps/web/src/${file}`, "utf8");
      expect(source, file).toContain("useApiMutationRevision");
      expect(source, file).toContain("mutationRevision");
    }
  });
});
