# Inventory Task Review

The existing text-message generated-surface registry renders a lazy task card when the server
attaches a business-scoped task reference. The standard message mapper already preserves typed
content; no second message format or task state store is introduced. A reference for a different
active business is not rendered.

The card reads the authenticated, uncached native task view. It shows verification independently
of lifecycle status, exact minor-unit budgets, milli-unit quantities, supplier/product names,
source issues and purchase drafts. Drafts are explicitly not submitted. Pending measured business
outcomes do not become claims of stockout reduction or forecast accuracy.

Pause, resume and cancel send the last observed revision. Controls are disabled during a request,
cancellation requires confirmation, and errors remove actionable stale state until refreshed.
Responses with mismatched task/business scope are rejected. Terminal tasks expose no mutation
controls. There is no supplier submission approval button because submission is not connected.

The shared objective parser forces recognized replenishment goals, including clarification cases,
through server inference rather than an owner-device route. Server authorization and the canonical
dispatcher remain authoritative. Internal task conversations stay out of the ordinary inbox,
including after business switching.

Validation includes component tests for verified drafts, cancellation, revision conflicts and scope
mismatch, plus real Chrome checks at 320px and 1440px for layout overflow, accessibility and resume.
Browser fixtures test presentation and controls, not live supplier delivery or model performance.
