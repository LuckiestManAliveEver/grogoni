# CP0 Artifact Manifest

Status: passed
Date opened: 2026-07-01
Date passed: 2026-07-01

## Created CP0 Artifacts

| Path                                                 | Purpose                                              |
| ---------------------------------------------------- | ---------------------------------------------------- |
| `documentation/README.md`                            | Harmonized documentation entry point and roadmap.    |
| `documentation/checkpoints/CHECKPOINT_LOG.md`        | Global checkpoint status and tag plan.               |
| `documentation/checkpoints/cp0/CP0_BASELINE.md`      | Formal CP0 baseline.                                 |
| `documentation/checkpoints/cp0/DECISION_LOG.md`      | Accepted and open planning decisions.                |
| `documentation/checkpoints/cp0/RISK_REGISTER.md`     | Initial risk register.                               |
| `documentation/checkpoints/cp0/SCOPE_BASELINE.md`    | MVP, beta, launch, and post-launch scope boundaries. |
| `documentation/checkpoints/cp0/ARTIFACT_MANIFEST.md` | This manifest.                                       |

## Source Artifacts Preserved

| Path                                                        | Role                                      |
| ----------------------------------------------------------- | ----------------------------------------- |
| `documentation/Grogoni doc 5 June ctrl .pdf`                | Master Control Document.                  |
| `documentation/Grogoni_Master_Control_Document_v1.docx`     | Master Control Document source duplicate. |
| `documentation/Grogoni_Master_Control_Document_v1 (1).docx` | Master Control Document source duplicate. |
| `documentation/Grogoni doc 1 june.pdf`                      | Master Architecture Document.             |
| `documentation/Grogoni doc 2 June .pdf`                     | Technical Architecture Specification.     |
| `documentation/Grogoni doc 3 june.pdf`                      | PRD and Development Blueprint.            |
| `documentation/Grogoni doc 4 June  (1).pdf`                 | Grogoniclaw Runtime Specification.        |
| `documentation/Grogoni doc 1.0 june (1).pdf`                | TIEL base specification.                  |
| `documentation/Grogoni doc 1,1 june.pdf`                    | TIEL implementation supplement.           |
| `documentation/1000157660.png`                              | UI reference.                             |
| `documentation/1000157661.png`                              | UI reference.                             |
| `documentation/1000157662.png`                              | UI reference.                             |

## Invalid or Superseded Artifacts

| Path                                    | Reason                                                |
| --------------------------------------- | ----------------------------------------------------- |
| `documentation/Grogoni doc 4 June .pdf` | Broken one-page placeholder. Excluded from authority. |

## Integrity Notes

- The two Master Control DOCX files have identical extracted text, even though their container file hashes differ.
- **Correction (added after implementation):** no `.repo.git` directory exists in this checkout,
  and no checkpoint tags were ever created. Whether a read-only `.git` mount and an alternate
  `.repo.git` genuinely existed in some earlier, now-lost environment cannot be verified — either
  way, neither exists today. `.git` in this checkout is a normal writable repository. See the
  corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`.

## CP0 Completion Checklist

- [x] Harmonized README created.
- [x] Source hierarchy documented.
- [x] Broken placeholder identified.
- [x] CP0 baseline created.
- [x] Decision log created.
- [x] Risk register created.
- [x] Scope baseline created.
- [x] Artifact manifest created.
- [x] Checkpoint log created.
- [ ] Alternate Git repository initialized at `.repo.git`. **Not actually done** — see correction above.
- [ ] `checkpoint/cp0-planning-baseline` tag created. **Not actually done** — see correction above.
- [x] CP0 marked `passed` in checkpoint log.
