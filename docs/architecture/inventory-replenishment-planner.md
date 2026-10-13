# Inventory replenishment planner

## Scope

The business-core planner is a deterministic advisory component, not a new agent
or execution runtime. It accepts business-scoped inventory, demand evidence and
supplier offers. The production observation adapter must obtain these from
committed records; the planner does not authenticate arbitrary supplied evidence.

It prioritizes nearer stockouts, compares actual supplier order totals including
minimum quantities and increments, and allocates only complete product orders
within the task budget. Money uses integer minor units, quantities use integer
thousandths, and arithmetic uses BigInt before conversion back to safe integers.
Missing demand is never treated as zero. Empty inventory, stale observations,
missing suppliers and budget shortfalls are explicit issues. Expired,
cross-currency, inactive, unavailable and too-late offers cannot be selected.

The KES 15,000 / three-day fixture compares suppliers for two products, chooses
five units of each and spends KES 6,000. This is a synthetic unit-test fixture,
not a live business result or benchmark claim.

## Remaining Integration

This component does not create purchase drafts, reserve supplier inventory,
contact suppliers or submit orders. READY describes a plan, not verified task
success. It must be composed with the existing canonical capability dispatcher,
durable task constraints, exact-action approval, independent committed-state
verification and reconciliation before any environment can be activated.

Outstanding work includes authoritative demand coverage, native quote and order
storage, transactionally enforced task budgets, approval-bound submission,
interruption recovery, evaluation, experience corroboration and chat cards.
No environment is activated by this change.
