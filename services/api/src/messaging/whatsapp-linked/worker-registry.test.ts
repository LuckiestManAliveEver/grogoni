import { describe, expect, it } from "vitest";
import { MemoryLinkedWorkerRegistry, linkedWorkerCredentialTtlMs } from "./worker-registry.js";
import { describeLinkedWorkerRegistryContract } from "./worker-registry-conformance.test-support.js";

let sequence = 0;
describeLinkedWorkerRegistryContract("in-memory", () => {
  let clock = 1_000_000;
  return {
    registry: new MemoryLinkedWorkerRegistry(() => clock),
    ttlMs: 1_000,
    expire: async () => {
      clock += 1_001;
    },
    business: () => `business-${++sequence}`
  };
});

describe("worker credential settings", () => {
  it("defaults to 30 days and refuses values outside 1 to 90 days", () => {
    expect(linkedWorkerCredentialTtlMs({})).toBe(30 * 86_400_000);
    expect(linkedWorkerCredentialTtlMs({ WHATSAPP_LINKED_WORKER_CREDENTIAL_DAYS: "7" })).toBe(
      7 * 86_400_000
    );
    for (const bad of ["0", "91", "7d", "-1"])
      expect(() =>
        linkedWorkerCredentialTtlMs({ WHATSAPP_LINKED_WORKER_CREDENTIAL_DAYS: bad })
      ).toThrow("CREDENTIAL_DAYS");
  });
});
