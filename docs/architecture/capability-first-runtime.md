# Capability-first runtime

## Invariant

Every business module is an independently addressable capability, and Chat is the universal
composition interface over those capabilities. A capability is identified by the canonical
`RuntimeToolName`, accepts validated structured input, and delegates to an authoritative domain
operation. It is not a second service, persistence layer, tool registry, or runtime.

```text
Chat / MCP / external channel / native client
                    |
                    v
             createRuntimeTurn
                    |
     context -> plan -> policy -> confirmation
                    |
                    v
       executeRuntimeCapability(name, input)
                    |
                    v
       canonical Cp2Store domain operation
```

Conventional UI routes call those same canonical domain operations. They may collect input with a
form, but the form is not the business operation and Chat never writes form state to perform an
action. Generated management cards and navigation are optional result presentation.

## Ownership

- `packages/tool-core/src/contracts/runtime.ts` owns tool contracts.
- `packages/tool-core/src/domains/*.ts` owns domain tool metadata. Every entry defaults to
  `mcpExposable: false`.
- `packages/tool-core/src/registry/index.ts` is the only registry composition root.
- `services/api/src/cp2/domains/agent-runtime/store.ts` owns the only `createRuntimeTurn` pipeline.
- `capabilities.ts` owns post-policy dispatch and delegates to injected domain APIs;
  receipt, network, commerce, core-read, and input modules keep adapters and coercion helpers
  bounded.
- `planning.ts` owns deterministic document-import and messaging proposal construction.
- `model-catalog.ts` owns model catalogue/configuration data.
- `runtime-turn-request.ts` owns runtime-turn HTTP input parsing.
- `services/api/src/cp2/domains/*` and their `Cp2Store` delegators remain authoritative for
  validation, persistence, idempotency, events, and business invariants.

The capability dispatcher is deliberately not an externally callable bypass. Authorization,
audience selection, semantic context retrieval, model-aware budgeting, instruction precedence,
untrusted-context sanitization, structured output parsing, policy, confirmation, and telemetry
all remain ahead of it in `createRuntimeTurn`. Confirmed actions re-enter the same dispatcher.

## Caller paths

- **Chat:** posts a message to `/businesses/:id/runtime/turns`; successful mutations refresh or
  render optional management cards. If the authorized runtime is unavailable, Chat fails closed
  with retry guidance instead of interpreting the business request against cached domain state.
- **UI:** posts typed form data to the existing domain route. The route invokes the same domain
  method used by the capability dispatcher.
- **MCP:** `grogoni.runtime_turn` and confirmation call `store.createRuntimeTurn`; MCP does not invoke
  domain mutations directly. Registry entries do not become public MCP tools automatically.
- **External channels:** canonical agent conversation processing injects `createRuntimeTurn` into
  Messaging. Channel delivery itself is the confirmed `messaging.send` capability.
- **Future native clients:** use the runtime-turn endpoint for composed natural-language actions or
  existing typed domain endpoints for conventional UI; neither path moves authority client-side.

## Current capabilities

The registry covers every substantive business domain: Sales (products, customers, invoices,
payments, and reports), Suppliers/receipts, Logistics, Document imports, Messaging, Notifications,
Network, Commerce, and Compliance. For example, `Add 20 crates of tomatoes at KSh 1,800`
deterministically proposes `product.create`, requires confirmation, then calls the canonical
sales-domain `createProduct`. `Who owes me money?` invokes the read-only `payments.debtors`
capability under `payment:read` authorization. Network discovery creates `network.route` through
the server runtime instead of a frontend phrase-match side effect. Commerce search and confirmed
checkout call the same `CommerceDomain` methods as the Buy UI, and `compliance.review` calls the
same security-review operation as the Compliance UI.

Every registered mutation has an executable canonical adapter. Structured `invoice.draft`,
`payment.record`, product-field, and receipt scan/review/correct/confirm/cancel inputs call the
same Sales or Supplier domain methods as conventional UI routes. Incomplete free-text commands
still clarify rather than guessing a product ID, invoice ID, payment method, OCR text, or supplier
match. A generated composer remains presentation metadata, not a substitute mutation.

Identity and runtime infrastructure (`oauth`, `otp`, `passkeys`, `device-bootstrap`, `mcp-tokens`,
and `agent-runtime`) are intentionally not classified as business modules. They provide the
authenticated invocation boundary rather than merchant operations. Sync is transport machinery;
it has no standalone business mutation and continues to move the outputs of canonical domain
operations.

## Adding a capability

1. Add or reuse a `RuntimeToolName` in shared/tool contracts.
2. Add metadata to the owning `packages/tool-core/src/domains/*.ts` module. Keep
   `mcpExposable: false` unless a separate MCP security review approves direct exposure.
3. Add deterministic parsing/planning only when evidence supports it; otherwise use structured
   model output followed by `validateRuntimeToolInput`.
4. Add one dispatcher case that calls an existing authorized domain operation. If no canonical
   domain operation exists, build that operation first rather than writing persistence in the
   runtime.
5. Add authorization, confirmation, idempotency, tenant-isolation, and real-message regression
   tests. Update the frozen registry order/metadata tests.

Adding a business module follows the same rule: own state and invariants in one CP2 domain, expose
an explicit injected API at the composition root, then register its capabilities. Do not deep
import another domain's private store implementation.

## Audit classification and retained coupling

| Dependency around `useChatRuntimeState`                | Classification  | State                            |
| ------------------------------------------------------ | --------------- | -------------------------------- |
| messages, drafts, attachments, reply state             | chat-owned      | retained                         |
| runtime session creation/history/model routing         | runtime-owned   | retained                         |
| domain refresh functions after executed results        | navigation/UI   | retained as presentation refresh |
| network route request                                  | capability      | moved to `network.route`         |
| network view navigation                                | navigation/UI   | retained after execution         |
| product/customer/invoice/payment form setters          | legacy coupling | removed                          |
| document-import refresh and generated management cards | navigation/UI   | retained                         |

Product, customer, supplier, invoice, and debt snapshots are no longer injected into Chat for
local interpretation, and browser conversational inference receives no parallel cached catalogue.
The remaining getter/setter escape hatches in other owner-domain hooks are hook-order bridges for
conventional UI workflows. They are not used to execute Chat capabilities and were not removed in
this phase because doing so would be an unrelated owner-shell rewrite.

## Architectural rules

`scripts/check-boundaries.mjs`, run by `pnpm check:boundaries` and the root `ci` script, enforces:

- no business form setter in Chat and no Chat import of domain UI implementation;
- no sibling hook private implementation import;
- no frontend import from tool-core;
- no API domain import of a sibling domain's private `store.ts` or `shared.ts` (zero exemptions);
- exactly one `runtimeToolRegistry` and one `createRuntimeTurn` implementation;
- MCP presence on the canonical runtime turn and no direct MCP business mutation;
- no capability-dispatch call outside agent-runtime's canonical store pipeline;
- bounded sizes for the newly modularized hotspots.

The static guard complements runtime tests; it does not replace domain authorization or tenant
isolation tests.

## Hotspot decomposition

The public parser entry point is now a small facade over focused merchant-command, product-context,
receipt-context, runtime-proposal, and model-output modules. Agent-runtime's composition root now
delegates runtime-context assembly and model/client-inference routing to dedicated modules while
retaining the single `createRuntimeTurn` pipeline. These splits preserve existing exports and
execution semantics; the boundary check gives each module an explicit size budget.
