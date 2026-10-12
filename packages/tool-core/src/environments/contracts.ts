import type { RuntimeToolName } from "../contracts/runtime.js";

export type BusinessEnvironmentExecutionMode = "READ_ONLY" | "SIMULATION" | "LIVE";
export type BusinessEnvironmentStatus =
  | "CREATED"
  | "READY"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "SUSPENDED"
  | "CANCELLED"
  | "EXPIRED";

/** Metadata only: capability policy remains owned by runtimeToolRegistry. */
export interface BusinessEnvironmentManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  domain: string;
  capabilities: readonly RuntimeToolName[];
  observationSchema: Readonly<Record<string, unknown>>;
  verificationPolicyId: string;
  evaluationPolicyId: string;
  executionMode: BusinessEnvironmentExecutionMode;
  status: "DRAFT" | "ACTIVE" | "DEPRECATED";
}

/** businessId uses the existing CP2 business ownership boundary. */
export interface BusinessEnvironmentInstance {
  id: string;
  businessId: string;
  agentId: string;
  runtimeInstanceId: string;
  runtimeSessionId: string;
  taskId: string;
  environmentId: string;
  environmentVersion: string;
  executionMode: BusinessEnvironmentExecutionMode;
  status: BusinessEnvironmentStatus;
  suspendedFrom: "READY" | "RUNNING" | "AWAITING_APPROVAL" | "VERIFYING" | null;
}

export type EnvironmentVerificationCategory =
  "STRUCTURAL" | "AUTHORIZATION" | "CONSTRAINT" | "EXECUTION" | "PERSISTENCE" | "OUTCOME";

export interface BusinessEnvironmentCompletionEvidence {
  taskId: string;
  environmentInstanceId: string;
  stateVersion: string;
  checks: readonly {
    category: EnvironmentVerificationCategory;
    status: "PASSED" | "FAILED" | "INCONCLUSIVE";
    evidenceRefs: readonly string[];
  }[];
  durability: "COMMITTED" | "NOT_REQUIRED" | "UNCERTAIN";
}
