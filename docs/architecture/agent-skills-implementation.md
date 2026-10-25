# Native Agent Skills implementation

Implemented 2026-10-25 following the Phase 0 audit. The user authorized all subsequent phases in
one implementation; the original per-phase review stops were superseded by that instruction.
This document distinguishes implemented behavior from production rollout and optional capabilities.

## Using skills

In an authenticated business chat, send `Create a skill: <business procedure>` or
`/skills create <business procedure>`. The existing configured model produces a validated draft.
No capability is granted and no installation, action, or schedule happens automatically.

1. `/skills list` shows installations and drafts within the authorized scope.
2. `/skills review <id>` shows complete content, requested capabilities, versions, grants and review digest.
3. `/skills edit <id> {"files":{"SKILL.md":"..."},"grants":["products.list"]}` edits instructions or grants.
4. `/skills approve <id> <reviewDigest>` approves the exact version, content, grants, agent bindings and scope.
5. `/skills enable <id>` makes the approved installation available to authorized agents.
6. `/skill <id-or-unique-name> <request>` activates instructions for one business runtime turn.
7. `/skills disable <id>` and `/skills uninstall <id>` stop future activations. Editing requires fresh approval.

In the existing personal daemon conversation, prefix business commands with
`/business <businessId>`, for example `/business <businessId> /skill <id> Check cement availability`
or `/business <businessId> /skills create Check stock before promising delivery`.
The daemon uses its queue-owned user only to locate an existing live PIN-verified session and validate
the originating conversation. The ordinary authenticated messaging route then checks business membership,
agent policy and tool permissions. An absent or revoked session blocks execution. Browser lanes send
these requests to the server, and server settlement rejects fabricated device completion for skill requests.
Retries reuse existing message idempotency; recurring executions have distinct occurrence identifiers.

Discovery metadata contains names/descriptions and opaque IDs/checksums, not instruction bodies.
Activation is explicit. There is no additional autonomous agent loop or automatic relevance selector.
The current model sees only the authorized metadata catalog until a skill is selected. Instructions
enter the untrusted user context, never trusted system policy. Resource reads use the authorized
version/digest API and are inert. Activate again for a later turn; no global instruction cache exists.

## Existing interfaces reused

- Grogoni/Pi agent adapters and the existing model-provider interface; Luna/OpenRouter defaults remain unchanged.
- `AgentRuntimeDomain.createRuntimeTurn`, `runtimeToolRegistry`, typed tool validation and `executeRuntimeCapability`.
- Current business membership/role checks, runtime policy, context grounding and exact-action approvals.
- Existing messaging persistence, notifications, idempotency and daemon browser/server lanes.
- PostgreSQL normalized snapshot persistence, scoped Edge hydration, audit events and deletion sweeps.

Every skill-backed write requires explicit runtime action confirmation, including writes whose older
tool definitions permit automatic execution. Confirmation retains the exact skill ID/version/digest in
the stored action and rechecks current authorization and revocation. Consumed approvals cannot replay.
Tool permission is the intersection of existing policy, owner-reviewed grants and any `allowed-tools`
restriction. Package content never creates executable capabilities. Model and tool failures cannot
be relabeled as completed operations. Audit/telemetry record identifiers and outcomes rather than instructions.

## Format and host policies

Portable packages follow the [Agent Skills specification](https://agentskills.io/specification).
Required YAML metadata, optional fields, Unicode naming, directory matching and relative Markdown
resource references are validated. Invalid YAML, duplicate keys and actionable validation errors are reported.
The direct Node dependency is `yaml@2.9.0` (ISC); no Python runtime or upstream source was vendored.
The Phase 0 audit records upstream Apache-2.0 code and CC-BY-4.0 documentation attribution requirements.

Grogoni-specific restrictions are separate from the format: text-only imports, 128 KiB instruction files,
256 KiB resources, 2 MiB packages, 100 files/directories/entries, depth four, 100 active records/drafts per
owner, and 16 MiB history per skill. YAML aliases, unsafe paths, symlinks, hardlinks and non-regular files
are rejected. Filesystem discovery pins Linux directory descriptors before reading children, so concurrent
renames cannot redirect a resource read outside the package. Other hosts can import file mappings.
Scripts may be stored/exported as inert text, but are never executed or installed. No general script sandbox
is claimed; the existing browser service remains limited to its established typed browser capabilities.

Set `GROGONI_SKILL_DIRS` to operator-controlled roots (platform path delimiter separated) for daemon
filesystem discovery. No root is enabled implicitly. `services/api/skills/inventory-check/SKILL.md` is
packaged with the API and provides an example; stale historical repository skills are not auto-enabled.
Filesystem packages supply instructions to chat-only operator tasks. Business operations require a
registered authorized installation and the business bridge, rather than the daemon's synthetic operator scope.

## Registry and marketplace

Migration `125_agent_skills.sql` adds one bounded normalized registry collection, retaining immutable
content versions inside each identity record. Scope/ownership checks cover `SYSTEM`, `TENANT` and `USER`.
SYSTEM installation mutation requires platform-operator authority; tenant mutation requires its owner;
personal records belong to their account. Validation precedes drafting and installation. New versions
return to draft status. The separate review digest prevents approving changed grants with an old content hash.

Business routes live under `/businesses/:businessId/skills`; account/system management uses `/v1/skills`.
The existing API serves marketplace search at `/v1/skills/marketplace`.

`/skills publish <id> <JSON-review>` requires the source digest, a separately supplied `publicFiles` mapping,
publisher attribution, category and `reviewedForPublication: true`. A license is required. No tenant content
is copied into a public package implicitly. Owners must inspect that separate export for private information;
there is no claim of automated secret/proprietary-content detection. All public content passes validation.

`/skills install-public <publicId> {"digest":"...","grants":["products.list"]}` pins reviewed public
content into a new installation in the caller's business. It starts installed, requiring explicit enabling.
Updates preserve public and private version history. Revoking a publication blocks existing imported copies
on the next activation/action/resource read; revoked public digests cannot be republished. Standard export
returns a directory name and file mapping, with Grogoni ownership/grants/lifecycle kept outside the package.

Categories: inventory, sales, customer support, supplier management, logistics, accounting and business reporting.
Trust labels distinguish private, community, verified and platform content. Only platform operators may attest
verified/platform publication trust. Those labels do not bypass validation, permissions or approval requirements.

## Scheduling and event dependencies

A skill is not a workflow. Draft generation explicitly describes this distinction and never schedules work.
To run an enabled skill periodically, create a separately approved task through the existing
`POST /v1/daemon/tasks` interface: provide an idempotency key, ISO `runAt`, `intervalMs`, the originating
conversation metadata, and message `/business <businessId> /skill <skillId> <request>`.
Existing daemon quotas, time limits, leases and cancellation remain authoritative. Each successful
occurrence increments the existing execution counter and gets a fresh message-processing identity.
No event-trigger subscription framework was added. Inventory-event wiring beyond existing task workflows
remains a dependency to configure separately, rather than something skill installation promises to do.

## Phase reports

| Phase                         | Reused components                                             | Created files                                                                         | Modified files                                                                                                                          | Migration / security / next phase                                                                                               |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1 — format compatibility      | Daemon executor, model prompts/adapters                       | `domains/agent-skills/format.ts`, bundled inventory skill, format/discovery tests     | Daemon executor, API package manifest and lockfile                                                                                      | No migration. Bounded untrusted text and inert scripts. Followed by registry.                                                   |
| 2 — tenant registry           | Membership, normalized persistence, Edge scope/deletion/audit | `domains/agent-skills/store.ts`, `routes.ts`, PostgreSQL test, migration/rollback 125 | CP2 store/routes/PostgreSQL/Edge scope, DB schema                                                                                       | One table; atomic snapshot lifecycle and scoped ownership. Followed by tools.                                                   |
| 3 — authorized operations     | Existing runtime dispatcher/approvals, daemon and messaging   | `daemon/business-skills.ts`, workflow tests                                           | Runtime types/dependencies/model context, messaging, daemon lanes/index/executor, Edge wiring, browser lane and route coverage contract | Exact skill snapshot travels with approvals; all skill writes require confirmation. Followed by drafting.                       |
| 4 — conversational generation | Current model provider, chat, daemon and existing scheduler   | No separate service or application                                                    | Registry/store/chat functions and generation tests in the files above                                                                   | Generated drafts have zero grants; explicit review/install/enable. Scheduling is separately approved. Followed by distribution. |
| 5 — marketplace               | Existing API/chat/persistence/audit surfaces                  | No marketplace backend                                                                | Registry/routes/chat publication, version/revocation/export functions and tests                                                         | Separate reviewed public package; no implicit private-data copying. No further implementation phase is required.                |

Executable source paths above are relative to `services/api/src/cp2` unless prefixed with `daemon`.
Tests and final results are recorded in the dated handoff after the PR merge. Earlier failing fixtures and
interrupted checks are not represented as passing results. No production migration or live paid inference,
external messaging, mobile build or full-suite certification is claimed by this implementation.
