# Experience extraction replay safety

Fallback experience extraction uses the existing RuntimeExperience store. Each
new record carries a durable, bounded list of corroborating turn identifiers.
Replaying a turn, even after another turn or snapshot rehydration, does not add
corroboration or refresh retention. The list freezes at 64 identifiers rather
than evicting old identifiers that could later be replayed.

Corroborations must match business, agent, recipe version and canonical tool.
Older records without the ledger can prove only their last source turn; their
untracked historical count is not treated as new evidence. Existing validated
legacy records are not automatically reclassified by this narrow change.

This closes replay inflation only. Distinct turn identifiers do not prove
independent business outcomes. Environment evaluation and independent committed
verification still need to gate business-task experience promotion; the existing
fallback trigger records model-routing reliability, not verified replenishment
success. This is not completion of implementation Phase 6.
