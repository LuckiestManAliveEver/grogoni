# ADR: Model Templates are portable expertise artifacts

Status: accepted, 2026-09-02.

## Decision

Grogoni treats domain expertise as the persistent portable asset and foundation models as swappable
execution dependencies. The asset is a versioned `.grogoni.com` template containing source expertise,
runtime contracts, evaluation evidence, compiled artifacts, and lineage.

## Context

Narrow systems improve when expert examples, evaluated failures, corrections, and repeated prompt
context are compiled into a specialized artifact. Tying that work to one provider or model loses
the accumulated business specification when the base is replaced.

## Alternatives

1. Marketplace of complete fine-tuned models. Simple to download, but duplicates large binaries,
   hides evaluation provenance, and couples value to a base architecture.
2. Prompt-template marketplace. Portable and cheap, but cannot represent datasets, tools,
   structured outputs, compiled artifacts, evaluation, or recursive improvement.
3. Agent marketplace. Useful for harness behavior and tools, but conflates orchestration with a
   business's accumulated task expertise.
4. Provider-specific assistants. Fast initial integration, but makes a proprietary API, identity,
   and lifecycle an architectural dependency.
5. Portable expertise artifact with swappable base. Preserves the domain specification and
   evidence, supports recompilation, and fits Grogoni's existing agent/model/host separation.

Option 5 is selected.

## Consequences

- Template, template version, source expertise, compiled artifact, base model, runtime binding, and
  execution host are distinct records.
- Adapters and deltas are only portable to declared compatible architectures. Source expertise is
  the migration input when direct transfer is impossible.
- Evaluation, corrections, datasets, improvement, promotion, and rollback are runtime lifecycle
  concerns.
- Existing native routing and inference adapters remain authoritative. No provider or new
  execution fabric becomes mandatory.
- Marketplace capability claims can be backed by report-card evidence.
