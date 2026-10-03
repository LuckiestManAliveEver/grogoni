# CP10 Decision Log

Status: passed
Date opened: 2026-07-03
Date passed: 2026-07-03

This file records Grogoniclaw Runtime full adapter decisions for CP10.

## Accepted Decisions

| ID       | Decision                                                                 | Rationale                                                                                        | Impact                                                                                                  |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| CP10-D01 | Keep runtime output behind deterministic tool adapters.                  | Model or planner output is advisory and must not become business truth by itself.                | All mutations must route through existing validators, role checks, and confirmation gates.              |
| CP10-D02 | Treat high and critical risk tools as confirmation-required.             | Business writes, financial state, inventory, imports, and sync replay can cause real harm.       | The verifier must block execution until an explicit confirmation token or equivalent action exists.     |
| CP10-D03 | Preserve CP4 parser as a deterministic fallback and evaluation baseline. | CP4 already provides inspectable low-risk routing for common merchant commands.                  | The runtime can enrich planning but must not remove parser behavior or make low-confidence flows worse. |
| CP10-D04 | Keep local model integration out of CP10 implementation scope.           | CP10 should define the runtime contract before attaching llama.cpp or model-specific code.       | CP11 can bind local models behind stable runtime interfaces.                                            |
| CP10-D05 | Log runtime state transitions without sensitive source content.          | Runtime debugging needs traceability, but merchant records and imported documents are sensitive. | Telemetry should prefer IDs, statuses, risk levels, decisions, and error codes over raw content.        |
| CP10-D06 | Rate-limit agent actions and planning loops.                             | Runtime loops can amplify bad plans, cost, latency, or duplicate attempts.                       | Runtime sessions need bounded turn/tool execution limits and deterministic failure states.              |
| CP10-D07 | Make the Pi/OpenClaw-style harness optional behind an adapter.           | Harness execution is useful for parity testing but should not become a core runtime dependency.  | `AgentHarnessAdapter` can be added without coupling business services to the harness.                   |

## Deferred Decisions

| Decision                                     | Deferred To | Reason                                                                                 |
| -------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| llama.cpp local model adapter                | CP11        | CP10 must first stabilize runtime contracts, verification, and tool adapters.          |
| Production hosted LLM provider               | CP14/CP15   | Provider choice requires security, privacy, cost, and compliance hardening.            |
| Model-assisted document extraction           | CP14/CP15   | CP9 import confirmation is stable, but extraction accuracy/privacy need more controls. |
| Autonomous background agents                 | CP15+       | Requires mature rate limits, observability, permissions, and rollback tooling.         |
| Marketplace automation through runtime tools | CP17        | Marketplace workflows belong to the post-launch marketplace checkpoint.                |
| Trusted Identity Execution Layer integration | CP18        | TIEL belongs after core-commerce and runtime boundaries are hardened.                  |

## CP10 Boundary Checks

CP10 must preserve these checks:

- Runtime sessions are business-scoped.
- Runtime context does not leak records across businesses.
- Model/runtime output cannot directly mutate business records.
- Tool execution routes through deterministic validators.
- High and critical risk tools require confirmation.
- Verification blocks invalid role, risk, or tool-input states.
- Runtime telemetry avoids plaintext sensitive content.
- Agent action loops are bounded by rate limits.
- CP4 deterministic parser behavior remains available.
- Existing CP1 through CP9 tests continue to pass.
