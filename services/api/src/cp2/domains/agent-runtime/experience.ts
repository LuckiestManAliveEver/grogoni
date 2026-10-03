import { randomUUID } from "node:crypto";
import type {
  ContextRecipe,
  RuntimeExperience,
  RuntimeParserIntent,
  RuntimePlannedAction,
  RuntimeTelemetryEvent,
  RuntimeToolName
} from "@grogoni/shared-types";

import {
  hydrateBusinessAgentProfile,
  nextRuntimeExperienceState,
  type BusinessAgentProfileSummary
} from "./shared.js";

type AppendTelemetry = (
  state: RuntimeTelemetryEvent["state"],
  status: RuntimeTelemetryEvent["status"],
  toolName: RuntimeToolName | null,
  risk: RuntimePlannedAction["risk"] | null,
  metadata?: RuntimeTelemetryEvent["metadata"]
) => void;

/**
 * Structured experience extraction (brief-adoption §8/§9/§15), scoped to the one deterministic,
 * already-documented trigger: `context/agent/recall.md`'s own spec ("small, validated, shop-scoped
 * lessons distilled after an attempted local inference failed and an authorized cloud fallback
 * succeeded"). Never stores the model's raw reasoning or conversation content - only the structured
 * fact that this task type, at this shop, needed a fallback for this reason, and that the fallback
 * succeeded. A new lesson starts as "candidate" and is never surfaced into a prompt;
 * `runtimeExperienceValidationThreshold` (shared.ts) independent corroborations promote it to
 * "validated" (see docs/architecture/experience-memory.md), so one execution can never poison
 * recall. Split out of store.ts purely for the file's modularity budget (check-boundaries.mjs),
 * same reasoning as report-card.ts/runtime-context.ts.
 */
export function recordFallbackExperience(
  runtimeExperiences: Map<string, RuntimeExperience>,
  input: {
    businessId: string;
    agentId: string;
    turnId: string;
    intent: RuntimeParserIntent;
    recipe: ContextRecipe | undefined;
    evidenceRefs: string[];
    toolName: RuntimeToolName;
    fallbackReason: string;
    now: Date;
    appendTelemetry: AppendTelemetry;
  }
): void {
  const lessonKey = `fallback:${input.intent}:${input.fallbackReason}`;
  const existing =
    [...runtimeExperiences.values()].find(
      (experience) =>
        experience.shopId === input.businessId &&
        experience.lessonKey === lessonKey &&
        experience.validationState !== "deprecated"
    ) ?? null;
  const { experience, telemetryEvents } = nextRuntimeExperienceState(existing, {
    id: existing?.id ?? randomUUID(),
    businessId: input.businessId,
    agentId: input.agentId,
    turnId: input.turnId,
    intent: input.intent,
    recipeId: input.recipe?.id ?? null,
    recipeVersion: input.recipe?.version ?? null,
    evidenceRefs: input.evidenceRefs,
    toolName: input.toolName,
    fallbackReason: input.fallbackReason,
    now: input.now
  });
  runtimeExperiences.set(experience.id, experience);
  for (const event of telemetryEvents) {
    input.appendTelemetry(event.state, "completed", null, null, event.metadata);
  }
}

/** Recall-eligible experiences for a business: validated only, per the brief's "prevent one bad
 *  execution from poisoning memory" requirement - a "candidate" is never surfaced into a prompt. */
export function validatedRuntimeExperiencesForBusiness(
  runtimeExperiences: Map<string, RuntimeExperience>,
  businessId: string
): RuntimeExperience[] {
  return [...runtimeExperiences.values()]
    .filter(
      (experience) => experience.shopId === businessId && experience.validationState === "validated"
    )
    .map((experience) => ({ ...experience }));
}

/**
 * Automatic counterpart to an explicit disable (not yet exposed as an owner action - this pass
 * scopes the lifecycle to automatic promotion/retention only, per the audit's bounded-scope
 * decision). Deprecates (never hard-deletes, matching purgeExpiredAgentOwnerCorrections' own
 * audit-preserving contract) every experience older than its business's configured
 * memoryPolicy.retentionDays, whatever its validation state.
 */
export function purgeExpiredRuntimeExperiences(
  runtimeExperiences: Map<string, RuntimeExperience>,
  agentProfiles: Map<string, BusinessAgentProfileSummary>,
  now: Date
): number {
  let deprecatedCount = 0;
  for (const experience of runtimeExperiences.values()) {
    if (experience.validationState === "deprecated") continue;
    const stored = agentProfiles.get(experience.shopId);
    if (stored === undefined) continue;
    const retentionMs =
      hydrateBusinessAgentProfile(stored).memoryPolicy.retentionDays * 24 * 60 * 60 * 1000;
    const ageMs = now.getTime() - Date.parse(experience.updatedAt);
    if (ageMs <= retentionMs) continue;
    runtimeExperiences.set(experience.id, {
      ...experience,
      validationState: "deprecated",
      deprecatedAt: now.toISOString()
    });
    deprecatedCount += 1;
  }
  return deprecatedCount;
}
