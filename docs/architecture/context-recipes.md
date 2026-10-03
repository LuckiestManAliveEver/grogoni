# Context recipes (MUSE-adoption addendum)

## What existed before

`intentContextTypes` (`services/api/src/cp2/agent-business-runtime.ts`) was a plain lookup table
mapping a recognized `RuntimeParserIntent` to the `AgentContextSourceType[]` it should narrow
retrieval to. It had no version, no grounding policy, and no declared tool list. Separately,
`RuntimeModelTemplateRecipe` (`packages/shared-types`) is a _different_ "recipe" concept scoped to
Model Template prompt compilation (allowed tools, context requirements, output schema, vocabulary
snapshots for one template version) - not evidence requirements.

## What changed

`intentContextTypes` is now derived from a small, versioned `ContextRecipe` registry:

```ts
export interface ContextRecipe {
  id: string; // "grogoni.<taskType>@<version>", e.g. "grogoni.show_products@1"
  taskType: RuntimeParserIntent;
  version: number;
  requiredEvidence: AgentContextSourceType[];
  optionalEvidence: AgentContextSourceType[];
  tools: RuntimeToolName[]; // informational - read by the report card, not an authorization path
  groundingPolicy: GroundingPolicyId; // "none" | "require_evidence"
}
```

`contextRecipeRegistry: Partial<Record<RuntimeParserIntent, ContextRecipe>>`
(`agent-business-runtime.ts`) has one entry per recognized intent except `"unknown"`, which
intentionally has none - no category narrowing and no grounding, matching the documented pre-existing
fallback for unclassified tasks. `resolveAgentContext` reads `requiredEvidence ∪ optionalEvidence` in
place of the old lookup table; behavior is otherwise unchanged.

## Grounding policy is deliberately narrow today

Only four entries set `groundingPolicy: "require_evidence"`: `show_products`, `check_debt`,
`show_invoices`, `show_reports` - the read-oriented intents where an unanswerable question is a real
hallucination risk. Every write-oriented intent (`add_product`, `create_invoice`, `record_payment`,
...) is `"none"`, because a different, already-existing mechanism grounds them instead:
`findRuntimeUnknownEntityReferenceError` (`services/api/src/cp2/domains/agent-runtime/runtime-entity-lookup.ts`)
checks the entity a mutation _references_ exists before a confirmation token is even minted. Applying
the context-recipe grounding gate there too would be redundant, not additive.

Extending grounding to another intent, or adding an entry for a future intent, is a one-line,
reviewable change to the registry - the same "deliberate, reviewable default" pattern the tool
registry's `mcpExposable` field already uses (`governed-tool-runtime.md`).

## Not (yet) part of this recipe

`outputSchema` and `verificationPolicy`, both named in the brief's illustrative interface, were
deliberately left out of `ContextRecipe` in this pass: nothing in this change would consume them, and
adding an unread field is exactly the "disconnected placeholder" the brief warns against.
Structural output validation already exists uniformly (`parseRuntimeModelOutput`,
`validateRuntimeToolInput`) and applies regardless of intent; a per-recipe output schema or
verification policy is a real, separable follow-up, not required to close the gaps this change
targets.
