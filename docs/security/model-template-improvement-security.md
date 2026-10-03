# Model Template recursive-improvement threat model

## Assets and trust boundaries

Assets are source expertise, approved corrections, frozen datasets/evaluations, compiled artifacts,
promotion authority, and business-private inputs. Trust boundaries exist at production input,
expert review, import/export, judge evaluation, object storage, tenant authorization, and runtime
model selection.

## Threats and controls

| Threat                             | Current control                                                                                        | Residual risk                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Malicious production input         | Observation is bounded, separate from truth, injection-pattern risk flagged                            | Pattern detection is not a semantic malware detector                |
| Prompt injection entering training | Explicit review, correction, approval, and dataset creation; unapproved rows rejected                  | A malicious or mistaken approver can still poison data              |
| User behavior treated as truth     | No implicit labels; only corrected output is eligible                                                  | Colluding reviewers remain possible                                 |
| Secret/private leakage             | Secret-shaped object keys redacted; no whole-conversation ingestion; bounded relevant context          | Secrets embedded in free text need a future DLP scanner             |
| Cross-tenant contamination         | Business/account columns, FK cascade, authorization before lookup, 403/404 isolation                   | Operator/database compromise is outside application controls        |
| Evaluation manipulation            | Used suites freeze; exact result rows and regressions persist; evaluation cases excluded from training | Benchmark gaming and judge bias require independent suites          |
| Artifact substitution              | Canonical manifest and per-file SHA-256 verification; unsafe paths rejected                            | Public-key publisher signatures are not implemented                 |
| Base-specific adapter misuse       | Adapter/delta requires exact base and architecture; selected base checked at runtime                   | Architecture metadata itself depends on trusted compilers           |
| Unauthorized promotion             | Write endpoints require business `launch:write`; decision and actor persisted                          | Owner/manager role separation may need a dedicated permission later |
| Silent regression                  | Candidate and production baseline run the same frozen suite; thresholds block promotion                | Incomplete suites cannot detect unknown failures                    |

## Operational rules

- Never log raw prompts, examples, corrections, credentials, or whole conversations in lifecycle
  telemetry.
- Treat judge output as evidence, not authority. Deterministic safety/tool/output checks take
  precedence.
- Keep large binaries in object storage with immutable keys and checksums.
- Do not grant a template new Grogoni tool permissions. Existing agent, role, confirmation, and tool
  validation stay authoritative.
- Audit dataset approvers and promotion actors. For higher-risk domains, require two-person review
  before adding a training worker.

## Unresolved work

Public-key signatures, text DLP, malware scanning for imported compiled artifacts, reviewer quorum,
adversarial suite generation, judge calibration, differential privacy, deletion propagation into
derived adapters, and per-marketplace license enforcement need dedicated infrastructure and policy.
