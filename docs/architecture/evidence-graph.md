# Evidence graph (MUSE-adoption addendum)

Grogoni does not have, and this change does not add, a graph database. Evidence lives in Postgres
JSONB envelope tables exactly as it did before ([`context-semantic-runtime.md`](context-semantic-runtime.md)),
via `AgentContextSource` (`packages/shared-types`, persisted as `cp2_agent_context_sources`). This
document covers the one thing this change added to that existing type: typed **provenance** and
**confidence**.

## Why

Before this change, `AgentContextSource`/`RetrievedAgentContextItem` had no field distinguishing "I
read this straight from a canonical business record" from "an owner typed this as free text" from "a
model extracted this from an OCR pass." A model-generated statement is not automatically evidence -
the brief's own non-negotiable - and there was no field to record which one a given piece of context
actually was.

## What changed

```ts
export type EvidenceProvenanceResolver =
  | "canonical_record" // read directly from a product/customer/order/... row
  | "owner_authored" // a context_script or owner_note the merchant wrote
  | "ocr_extraction" // derived from a receipt scan
  | "model_recall" // a validated RuntimeExperience (see experience-memory.md)
  | "context_script" // an authored automation script
  | "unknown";

export interface EvidenceProvenance {
  resolver: EvidenceProvenanceResolver;
  sourceType: AgentContextSourceType;
  sourceId: string | null; // the canonical record this evidence was read from, when one exists
}
```

Both `AgentContextSource.retrievalMetadata` and `RetrievedAgentContextItem` gained `confidence:
number | null` and (on the source) an optional `provenance: EvidenceProvenance`. The fields are
**optional on the persisted source** (`AgentContextSource`) so no migration or backfill was needed -
every source built before this change round-trips unchanged - and **derived automatically** by
`resolveAgentContext` for every retrieved item:

- A source with `retrievalMetadata.sourceRecordId !== null` (every catalogue/inventory/customer/
  supplier/receipt/order source `contextSourcesForRuntime` synthesizes already sets this to the real
  record's id) gets `resolver: "canonical_record"` and `confidence: 1` automatically - reading a
  live business record is unambiguous.
- `recall`, `context_script`, `owner_note`, and `receipt` sources default to `model_recall`/
  `context_script`/`owner_authored`/`ocr_extraction` respectively when no `sourceRecordId` is
  present, with `confidence: null` (unassessed) unless the constructor explicitly sets one - which
  only the recall synthesis path does today (see [`experience-memory.md`](experience-memory.md)).
- Anything else defaults to `resolver: "unknown"`, `confidence: null` - never guessed.

`contextSourceRecord` (`services/api/src/cp2/domains/agent-runtime/shared.ts`), the one shared
constructor every synthesized source goes through, gained optional `confidence`/`provenance`
parameters so a caller that needs to override the default (recall) can, without every other call
site changing.

## What this is not

This is not a second copy of business data. `retrievalMetadata.sourceRecordId`/`provenance.sourceId`
are pointers back to the canonical record (`contextSourcesForRuntime` never duplicates a product,
customer, or order - it references it). This is also not a scoring/ranking change: relevance scoring
and character-budget packing are unchanged; provenance/confidence are additional metadata on the
same items, read by the grounding gate and available for future use (e.g. surfacing "how sure is the
agent" in a UI), not a new selection mechanism.
