import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { canonicalJson } from "../model-templates/manifest.js";
import type { BusinessTask } from "@grogoni/tool-core";

export function taskExperienceContextKey(task: BusinessTask): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        businessId: task.businessId,
        environmentId: task.environmentId,
        environmentVersion: task.environmentVersion,
        evaluationPolicyId: task.evaluationPolicyId ?? null,
        executionMode: task.executionMode,
        constraints: task.constraints,
        capabilities: task.plan.map((entry) => [entry.capability, entry.verificationPolicyId])
      })
    )
    .digest("hex");
}

export interface ExperienceSourceEvidence {
  fingerprint: string;
  mask: string;
  count: number;
}

/** Collisions can reject independent episodes, never accept overlapping source records. */
export function experienceSourceEvidence(
  businessId: string,
  invoiceIds: Iterable<string>
): ExperienceSourceEvidence {
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.length > 10000 || ids.some((id) => !id || id.length > 200))
    throw new Error("Invalid source evidence.");
  const bytes = Buffer.alloc(1024);
  for (const id of ids) {
    const bit =
      createHash("sha256")
        .update(canonicalJson([businessId, id]))
        .digest()
        .readUInt32BE(0) % 8192;
    bytes[bit >>> 3]! |= 1 << (bit & 7);
  }
  return {
    fingerprint: createHash("sha256")
      .update(canonicalJson([businessId, ids]))
      .digest("hex"),
    mask: bytes.toString("hex"),
    count: ids.length
  };
}

export function independentSourceMasks(left: string, right: string): boolean {
  if (![left, right].every((mask) => /^[0-9a-f]{2048}$/u.test(mask) && /[1-9a-f]/u.test(mask)))
    return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.every((byte, index) => (byte & b[index]!) === 0);
}

export function mergeSourceMasks(left: string, right: string): string {
  if (!independentSourceMasks(left, right)) throw new Error("Source evidence is not independent.");
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  for (let index = 0; index < a.length; index++) a[index]! |= b[index]!;
  return a.toString("hex");
}
