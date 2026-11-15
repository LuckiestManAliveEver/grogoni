import { describe, expect, it } from "vitest";
import { Cp2Error } from "../../cp2/cp2-error.js";
import {
  hashLinkedWorkerSecret,
  linkedWorkerSummary,
  type LinkedWorkerRegistry
} from "./worker-registry.js";

/**
 * Test support only. One behavioural contract for worker enrollment storage, run against the
 * in-memory registry and against PostgreSQL (migration 139), so both keep the same semantics.
 */
export interface WorkerRegistryHarness {
  registry: LinkedWorkerRegistry;
  /** Credential lifetime for these cases; `expire()` lets it pass by the registry's own clock. */
  ttlMs: number;
  expire(): Promise<void>;
  business(): string;
}

export function describeLinkedWorkerRegistryContract(
  name: string,
  make: () => Promise<WorkerRegistryHarness> | WorkerRegistryHarness,
  timeout = 10_000
): void {
  describe(`${name} worker registry contract`, () => {
    const long = 86_400_000;
    it(
      "issues a credential once, stores only its hash, and allows one active worker per business",
      async () => {
        const h = await make();
        const business = h.business();
        const { record, secret } = await h.registry.enroll({
          businessId: business,
          ownerId: "owner-1",
          label: "back office",
          ttlMs: long
        });
        expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(record.secretHash).toBe(hashLinkedWorkerSecret(secret));
        expect(JSON.stringify(record)).not.toContain(secret);
        expect(JSON.stringify(linkedWorkerSummary(record))).not.toContain(record.secretHash);
        expect(linkedWorkerSummary(record)).toMatchObject({
          status: "active",
          credentialVersion: 1,
          attached: false
        });
        const second = h.registry.enroll({
          businessId: business,
          ownerId: "owner-1",
          label: "another",
          ttlMs: long
        });
        await expect(second).rejects.toBeInstanceOf(Cp2Error);
        await expect(second).rejects.toMatchObject({ statusCode: 409 });
        expect(await h.registry.list(business)).toHaveLength(1);
        expect(await h.registry.list(h.business())).toEqual([]);
      },
      timeout
    );

    it(
      "authenticates only the current secret; rotation invalidates the old one at once",
      async () => {
        const h = await make();
        const business = h.business();
        const { record, secret } = await h.registry.enroll({
          businessId: business,
          ownerId: "owner-1",
          label: "w",
          ttlMs: long
        });
        expect("record" in (await h.registry.authenticate(record.id, secret))).toBe(true);
        expect(await h.registry.authenticate(record.id, "x".repeat(43))).toEqual({
          refusal: "credential_invalid"
        });
        expect(
          await h.registry.authenticate("00000000-0000-4000-8000-000000000000", secret)
        ).toEqual({ refusal: "credential_invalid" });
        const rotated = (await h.registry.rotate({
          businessId: business,
          workerId: record.id,
          ownerId: "owner-1",
          ttlMs: long
        }))!;
        expect(rotated.secret).not.toBe(secret);
        expect(rotated.record.credentialVersion).toBe(2);
        expect(await h.registry.authenticate(record.id, secret)).toEqual({
          refusal: "credential_invalid"
        });
        expect("record" in (await h.registry.authenticate(record.id, rotated.secret))).toBe(true);
        expect(await h.registry.stillValid(record.id, 1)).toBe(false);
        expect(await h.registry.stillValid(record.id, 2)).toBe(true);
        // A worker id from another business cannot be rotated through this one.
        expect(
          await h.registry.rotate({
            businessId: h.business(),
            workerId: record.id,
            ownerId: "owner-1",
            ttlMs: long
          })
        ).toBeNull();
      },
      timeout
    );

    it(
      "revocation is permanent and frees the business for a new enrollment",
      async () => {
        const h = await make();
        const business = h.business();
        const { record, secret } = await h.registry.enroll({
          businessId: business,
          ownerId: "owner-1",
          label: "w",
          ttlMs: long
        });
        expect(await h.registry.revoke(h.business(), record.id)).toBeNull();
        const revoked = (await h.registry.revoke(business, record.id))!;
        expect(linkedWorkerSummary(revoked).status).toBe("revoked");
        expect(revoked.revokedAt).not.toBeNull();
        expect(await h.registry.authenticate(record.id, secret)).toEqual({
          refusal: "credential_revoked"
        });
        expect(await h.registry.stillValid(record.id, 1)).toBe(false);
        expect(await h.registry.activeForBusiness(business)).toBeNull();
        expect(
          await h.registry.rotate({
            businessId: business,
            workerId: record.id,
            ownerId: "owner-1",
            ttlMs: long
          })
        ).toBeNull();
        await h.registry.enroll({
          businessId: business,
          ownerId: "owner-1",
          label: "w2",
          ttlMs: long
        });
        expect(await h.registry.list(business)).toHaveLength(2);
      },
      timeout
    );

    it(
      "expires credentials by the registry clock; rotation renews them",
      async () => {
        const h = await make();
        const business = h.business();
        const { record, secret } = await h.registry.enroll({
          businessId: business,
          ownerId: "owner-1",
          label: "w",
          ttlMs: h.ttlMs
        });
        await h.expire();
        expect(await h.registry.authenticate(record.id, secret)).toEqual({
          refusal: "credential_expired"
        });
        expect(await h.registry.activeForBusiness(business)).toBeNull();
        expect(linkedWorkerSummary((await h.registry.list(business))[0]!).status).toBe("expired");
        const renewed = (await h.registry.rotate({
          businessId: business,
          workerId: record.id,
          ownerId: "owner-1",
          ttlMs: long
        }))!;
        expect("record" in (await h.registry.authenticate(record.id, renewed.secret))).toBe(true);
      },
      timeout
    );

    it(
      "lets one host at a time hold a worker's attachment, for the current credential only",
      async () => {
        const h = await make();
        const business = h.business();
        const { record } = await h.registry.enroll({
          businessId: business,
          ownerId: "owner-1",
          label: "w",
          ttlMs: long
        });
        expect(await h.registry.attachment(business)).toBeNull();
        expect(await h.registry.attach(record.id, 1, "api-a", "http://a:4000", 60_000)).toBe(true);
        expect(await h.registry.attach(record.id, 1, "api-b", "http://b:4000", 60_000)).toBe(false);
        expect(await h.registry.attach(record.id, 1, "api-a", "http://a:4000", 60_000)).toBe(true);
        expect(await h.registry.attach(record.id, 2, "api-a", "http://a:4000", 60_000)).toBe(false);
        expect(await h.registry.attachment(business)).toEqual({
          holderId: "api-a",
          url: "http://a:4000"
        });
        expect(linkedWorkerSummary((await h.registry.list(business))[0]!).attached).toBe(true);
        await h.registry.detach(record.id, "api-b"); // not the holder: no effect
        expect(await h.registry.attachment(business)).not.toBeNull();
        await h.registry.detach(record.id, "api-a");
        expect(await h.registry.attachment(business)).toBeNull();
        expect(await h.registry.attach(record.id, 1, "api-b", null, 60_000)).toBe(true);
        expect(await h.registry.attachment(business)).toEqual({ holderId: "api-b", url: null });
        await h.registry.revoke(business, record.id);
        expect(await h.registry.attachment(business)).toBeNull();
        expect(await h.registry.attach(record.id, 1, "api-b", null, 60_000)).toBe(false);
      },
      timeout
    );
  });
}
