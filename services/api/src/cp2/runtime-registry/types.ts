import type {
  RuntimeRegistryContext,
  RuntimeRegistryProviderId,
  RuntimeRegistryResourceDetails,
  RuntimeRegistryResourceRef,
  RuntimeRegistrySearchItem,
  RuntimeRegistrySearchQuery
} from "@grogoni/shared-types";

/**
 * One normalized, read-only view onto a runtime-asset source (Grogoni's own catalog, GitHub, Hugging
 * Face). `search` must stay metadata-only -- it must never download a model artifact or repository
 * source file merely to produce a result list. `inspect` may read a little more (a README excerpt, a
 * root file listing, a small manifest file) but must never fetch anything as executable code.
 */
export interface RuntimeRegistryAdapter {
  readonly id: RuntimeRegistryProviderId;
  readonly displayName: string;
  search(
    query: RuntimeRegistrySearchQuery,
    context: RuntimeRegistryContext
  ): Promise<RuntimeRegistrySearchItem[]>;
  inspect(
    ref: RuntimeRegistryResourceRef,
    context: RuntimeRegistryContext
  ): Promise<RuntimeRegistryResourceDetails>;
}

export class RuntimeRegistryResourceNotFoundError extends Error {
  constructor(ref: RuntimeRegistryResourceRef) {
    super(`Runtime registry resource ${ref.provider}:${ref.kind}:${ref.externalId} was not found.`);
    this.name = "RuntimeRegistryResourceNotFoundError";
  }
}

/**
 * Thrown instead of RuntimeRegistryResourceNotFoundError only when the provider's own response
 * distinguishes "exists but access is denied" from "does not exist" (e.g. Hugging Face's 403 on a
 * gated/private repo, as opposed to its 404 for a nonexistent one). GitHub intentionally returns 404
 * for both cases on a private repo to avoid confirming existence to an unauthorized caller, so this
 * is never thrown by the GitHub adapter - only Hugging Face's gated-model flow distinguishes the two
 * states in its API responses. Maps to the import state machine's ACCESS_REQUIRED, never an attempt
 * to circumvent the restriction.
 */
export class RuntimeRegistryAccessRequiredError extends Error {
  constructor(ref: RuntimeRegistryResourceRef) {
    super(
      `Runtime registry resource ${ref.provider}:${ref.kind}:${ref.externalId} requires access ` +
        "this caller's connected account does not have."
    );
    this.name = "RuntimeRegistryAccessRequiredError";
  }
}
