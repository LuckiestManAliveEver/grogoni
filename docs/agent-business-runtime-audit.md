# Agent business runtime audit

Date: 2026-07-26
Revision audited: `3d8d577`

## Executive finding

Grogoni already has the beginnings of a model-independent business runtime. The API owns a
business-scoped agent profile, runtime sessions and turns, deterministic context-script routing,
tool validation, role checks, confirmation gates, business-record access, model-provider adapters,
runtime telemetry, and audit events. The browser has a separate bounded context builder for local
models and a settings surface for the profile and model.

The implementation is not yet a complete shop-agent runtime. The saved profile is a flat JSON
record, important policies are free text, the active runtime is not versioned, prompt construction
is duplicated, context files are not represented as access-controlled sources, and there are no
durable owner corrections, skill bindings, memory policies, evaluation events, or rollback/readiness
contracts. Server chat also accepts an optional client-constructed `agentProfile`, which lets an
authenticated client influence trusted prompt material instead of always compiling from the saved
server profile.

The correct approach is to extend the existing profile/runtime/store and normalized JSON persistence
patterns. Replacing the runtime, database, model registry, tool registry, chat pipeline, or settings
surface would duplicate working controls.

## Current architecture

### Agent profiles

- `Cp2Store.agentProfiles` stores one `BusinessAgentProfileSummary` per `businessId`.
- `GET/PUT /businesses/:businessId/agent-profile` require an authenticated business membership.
  Reads require `business:read`; updates require `membership:manage`.
- The profile includes name, description, model ID, role, language, one personality string, one
  instruction string, one knowledge string, tool/integration labels, Markdown context scripts,
  active/draft status, updater, and update time.
- Defaults are derived from the existing business and active model.
- Required document-upload guardrails are appended to saved context scripts.
- PostgreSQL persists profiles as tenant-indexed JSON records in `cp2_agent_profiles`; the in-memory
  store snapshot uses the same collection.

Incomplete:

- no explicit tenant/account ID, agent ID, runtime version, created time, shop category, public
  introduction, supported-language list, or paused/archived lifecycle;
- identity, style, critical rules, knowledge, skills, and model selection are conflated;
- no revision history or rollback;
- no structured validation beyond bounded strings/lists and available-model checks.

### Model registry and activation

- The server has an AI model catalogue, active cloud fallback per business, installed model records,
  and business/device model assignments.
- Assignments are account-, user-, business-, and device-scoped; compatible installation and a
  successful test inference are required before `READY`.
- Activation is audited and preserves the profile record, but it does not create a profile revision
  or prove the complete business runtime is ready.
- The browser has a model activation coordinator with cancellation, rollback messaging, assignment
  persistence, worker readiness testing, and local-first/cloud-fallback policy.

Disconnected:

- `BusinessAgentProfileSummary.modelId`, `activeAiModels`, and device assignment may describe
  different model layers. Runtime selection resolves these through compatibility logic rather than
  one explicit `AgentModelBinding`.
- model activation does not version the rest of the agent runtime.

### Context files and scripts

- Product and receipt context parsers run before model fallback.
- Default English/Swahili product vocabulary supports list/add/edit/delete/stock/field actions and
  accepts tenant-specific Markdown phrase mappings.
- Receipt/OCR and document-import workflows are deterministic and require preview/confirmation.
- Browser-local inference retrieves a bounded lexical subset of catalogue/context items and applies
  a protected system prefix.

Security gap:

- server prompt text currently says coherent context files are primary operating instructions. An
  owner-uploaded or externally derived file must instead remain untrusted context below platform
  security, permissions, confirmations, and typed business policies.
- context scripts are stored as strings, without source ID, sensitivity, visibility, freshness,
  access policy, status, or version.
- the server formats all saved scripts and free-text knowledge into a model message instead of
  retrieving only relevant items.

### System prompts, instructions, and personality

- Server model prompts are constructed by `formatRuntimeModelMessage` and
  `buildRuntimeModelPrompt`.
- Browser-local prompts are separately constructed by `buildBrowserModelContext`, while the
  frontend also builds local/native prompt strings in `GrogoniApplication.tsx` and
  `agent-model-runtime.ts`.
- Server prompts include profile role, behavior, instructions, tools, integrations, knowledge, and
  context files.
- Personality is one free-text value and has no enforced boundary from business policies.
- Business rules such as discounts, credit, returns, privacy, delivery, and restricted actions have
  no typed profile fields.

Duplicated/disconnected:

- prompt assembly exists in server store helpers, browser context code, Android/local runtime
  helpers, and UI call sites;
- frontend `RuntimeTurnBody.agentProfile` can construct prompt material accepted by server runtime
  turns;
- tool labels saved in the profile are descriptive strings and do not constrain the actual
  `runtimeToolRegistry`.

### Business runtime and chat processing

- Runtime sessions are scoped to a business and authenticated user, have a turn limit, and persist
  in snapshots/PostgreSQL JSON tables.
- Incoming turns build bounded business counts, resolve document/context scripts before model
  fallback, create typed tool proposals, validate inputs, enforce roles, require confirmation for
  risky tools, execute approved tools, and store the result.
- Chat agent processing persists the user message and assistant result with a correlation ID and
  normalized error state.
- Runtime telemetry records context build, model prompt/completion/fallback, intent route, plan,
  verification, confirmation, tool execution, response, block, and rate-limit states.

Incomplete:

- turns do not record an immutable runtime version;
- no unified readiness gate is used by both activation and chat;
- response style is not compiled separately from action policy;
- no explicit output-policy validation checks hallucinated prices/discounts against typed limits;
- runtime outcome telemetry is not a durable evaluation/feedback stream.

### Tools, skills, and permissions

- `runtimeToolRegistry` defines real supported tools, required permissions, risk, confirmation, and
  read-only status.
- Tool inputs are validated before execution; MCP tools are also tenant-scoped and split read/act
  permissions.
- Existing executable domains include catalogue, inventory, customers, invoices, payments,
  receipts/OCR, and document imports.

Incomplete:

- there is no persisted `AgentSkillBinding`;
- profile `tools` and `integrations` are labels and can advertise capabilities not connected to the
  executable registry;
- no per-skill version, allowed intents, confirmation level, environment, quota, success time, or
  failure count.

### Memory

- Short-term session state exists as runtime sessions/turns and conversation history.
- Browser-local inference maintains a rolling conversation summary in IndexedDB.
- Business knowledge generates current deterministic facts from reports, inventory, debts, imports,
  logistics, compliance, notifications, beta, launch, and sync.
- Chat messages, conversations, customers, and business records are durable.

Missing:

- no server-side memory policy;
- no durable shop semantic memory, owner correction, reusable workflow memory, or
  customer-memory privacy policy;
- browser rolling summaries are device-local and not connected to the server business runtime;
- no disable/expiry/retention/relevance state for memory items.

### Catalogue, customers, suppliers, receipts, orders, and inventory

- These are existing business-scoped authoritative records with authenticated API routes and
  snapshot/PostgreSQL persistence.
- Catalogue and inventory support deterministic read/mutation tools.
- Supplier, receipt, OCR, invoice/order, payment, logistics, and customer records already feed
  reports, business knowledge, imports, or dedicated workflows.
- Runtime context currently exposes aggregate counts; tools retrieve full authoritative records only
  for the selected operation.

Incomplete:

- there is no unified context manifest referencing these sources;
- customer/owner visibility and sensitivity are enforced by route context, not expressed as
  reusable retrieval access rules;
- public customer chat must not receive owner-only business knowledge, corrections, debts, supplier
  records, or internal evaluations.

### Corrections, analytics, and evaluation

- Runtime telemetry and audit events exist and intentionally exclude message content from audit
  payloads.
- Beta telemetry and operational reports exist but are release/operations mechanisms, not agent
  quality evaluation.
- No response-level correct/wrong control, owner correction, permanent instruction promotion,
  evaluation summary, hallucination event, policy-violation review, or feedback workflow exists.
- No hidden chain-of-thought is stored, which must remain true.

### Persistence and database

- The in-memory store exports/imports one `Cp2Snapshot`.
- `PostgresCp2Store` maps snapshot collections into normalized JSONB tables and persists after known
  mutating methods.
- Existing profile/model/runtime tables use text entity IDs containing UUID-compatible values from
  the store and business/account/user indexes.
- Account/shop deletion already propagates across scoped store collections and retains restricted
  audit/financial records according to existing recovery policies.

Incomplete:

- runtime versions, context sources, skill bindings, memory policies/items, evaluation events, and
  corrections have no collections or tables;
- `cp2_agent_profiles` has no foreign keys and only a nullable business index because it follows the
  generic normalized-store convention;
- new collections must be added to snapshot hydration, persistence mutation detection, scoped
  deletion, and rollback SQL.

### Frontend settings

- `AgentProfileSurface` already provides explicit edit/save/cancel behavior and the existing visual
  language.
- It exposes identity, free-text personality/instructions/knowledge, descriptive tools and
  integrations, protected Markdown context editing, model library/activation, account security,
  sessions, and deletion.
- A localStorage copy makes the shell available offline.

Frontend-only or misleading:

- `AgentSettings` duplicates the server profile contract locally;
- context unlock is a client-side advanced-password mechanism, not server authorization;
- unsaved state is implicit in `isEditing`, with no field-level validation or explicit dirty
  indicator;
- runtime version/readiness, policies, context visibility, skill executability, memory, evaluations,
  corrections, and rollback are absent;
- the model section appears before the behavior/context sections.

### Tenant isolation and access control

- The repository uses `businessId` as the shop/tenant boundary. Membership and business permission
  checks guard reads and mutations.
- Runtime sessions, tools, business context, messages, model assignments, and record helpers verify
  business ownership.
- Tests prove cross-business product/runtime isolation.

Risks to correct:

- runtime contracts should carry both `tenantId` and `shopId`, mapped to `businessId` until a
  separate tenant entity exists;
- client-provided runtime profiles must not be trusted;
- context and memory retrieval need explicit audience/sensitivity filters;
- uploaded files, OCR text, customer messages, imported conversations, and context Markdown must be
  delimited and treated as untrusted data;
- deletion must include every new business-scoped runtime collection.

## Extension plan

Extend rather than replace:

1. Compose a versioned `ShopAgentRuntime` around `BusinessAgentProfileSummary`,
   `AgentModelAssignmentSummary`, the existing tool registry, and current business records.
2. Keep `cp2_agent_profiles` as the current materialized profile; add small JSONB collections for
   immutable runtime versions, context sources, evaluation events, and owner corrections.
3. Add structured personality, instruction, skill, memory, evaluation, context, and model contracts
   in shared types.
4. Centralize server prompt compilation and enforce platform/policy precedence before adapters.
5. Retrieve bounded, audience-safe context references instead of copying whole datasets into every
   prompt.
6. Make server chat ignore client-authored trusted profile content and load the active saved runtime.
7. Version every material update, including model binding changes, and provide reviewed rollback.
8. Convert runtime telemetry into privacy-safe evaluation events and expose owner-only summaries and
   corrections.
9. Extend the existing settings surface with compact sections; do not create a parallel profile
   system or dashboard.
