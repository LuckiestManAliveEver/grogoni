# Canonical inventory procurement

## Implemented Scope

Two capabilities extend runtimeToolRegistry and executeRuntimeCapability:

- procurement.quote.record records an immutable, owner-entered supplier quote
  after the existing exact-action confirmation gate. Existing canonical product
  and supplier identities must belong to the authorized business.
- procurement.prepare prepares durable purchase drafts for one exact compiled
  task action. It never submits to a supplier, acknowledges delivery or changes
  on-hand stock. Every draft explicitly says NOT_SUBMITTED and requires separate
  submission approval.

The native service reads committed inventory, confirmed invoice lines, supplier
identities and quotes in one bounded statement snapshot. A recent observed sales
window of at least a day supplies an estimated daily demand; missing product
sales evidence is never assumed zero. The estimate is not a promise of future
sales or proof that imported history is complete. Supplier prices are owner-entered
offers, not independently confirmed supplier acknowledgements.
The owner must explicitly confirm that the quoted unit price includes tax,
delivery and all other charges. Unknown charges block quote acceptance rather
than being silently treated as zero.
Quotes and drafts snapshot the canonical product quantity unit; changing a
product's unit cannot silently reuse its old quoted price. Forecasting uses the
existing ledger's product-quantity semantics, not an invented unit conversion.

The existing deterministic replenishment planner compares supplier order totals,
minimums, increments, availability and lead time. Native task budgets and the
claimed action identity are authoritative. Task/lifecycle locks serialize
preparation; duplicate calls return the original draft batch without new spend.
All drafts commit together or none do. Partial or blocked recommendations remain
explicitly incomplete rather than being represented as replenishment success.
Sales aggregation and provenance are bounded, as are draft batches and result
size. A failed write acknowledgement stays INCONCLUSIVE even if the canonical
runtime catches the exception; it is never permission to replay a claimed step.

Node uses the existing PostgreSQL pool. Edge uses the existing independent record
transaction connection, so a later snapshot rollback cannot erase an acknowledged
draft or reopen an approval. There is no alternate model registry, agent loop,
business snapshot store or capability dispatcher.

## Verification and Privacy

The existing six-category verifier now supports the inventory replenishment
policy. It rereads native drafts, quote prices, quantities, aggregate task spend
and source evidence, and recomputes the recommendation independently of model
prose. Changed prices, record totals, missing evidence and partial preparation
cannot become completed success. Verification requires the environment's pinned
runtime session, which execution now reuses instead of starting a new session.

Account deletion removes draft graphs atomically with their tasks. Quotes in a
shared business retain business facts but have the deleted creator anonymized;
exclusively owned business quotes are deleted. No personal quote notes or model
reasoning are stored in these tables.

## Validation and Limits

The synthetic KES 15,000 / three-day fixture prepares two supplier drafts totaling
KES 6,000. A PostgreSQL test exercises the real canonical runtime, proves the quote
does not write before confirmation, commits the runtime result, then independently
verifies purchase records. These fixtures are not live-model benchmark results.

No environment is activated yet. Production chat/task orchestration, evaluation,
independent experience promotion, isolated model benchmarks and unified chat cards
remain outstanding. Supplier submission is not implemented or implied; a request
to submit must report incomplete until an approved delivery mechanism exists.
