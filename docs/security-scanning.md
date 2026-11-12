# Automated security scans

`.github/workflows/security.yml` runs on pushes, pull requests, manual dispatch and weekly.
Jobs use read-only repository permissions and do not persist checkout credentials.

The dependency job installs the frozen lockfile without dependency lifecycle scripts, then runs
`pnpm audit --prod --audit-level high`. Registry failures fail the job. High/critical advisories
are not ignored. This is a release check, not proof of exploitability or a substitute for review.

The secret job uses the official Gitleaks action pinned to commit
`ff98106e4c7b2bc287b24eaf42907196329070c7`, with scanner 8.30.1 and full checkout history.
PR comments and report uploads are disabled. Never commit local credential files or unredacted
scanner reports. Scan reports belong in restricted temporary storage; record paths/rule IDs and
counts, never secret values, in the repository.

For a local historical scan, run:

```sh
gitleaks git --redact --no-banner --report-format json --report-path /tmp/grogoni-secrets.json
pnpm audit --prod --audit-level high
```

Review each secret finding. A confirmed credential must be revoked at its provider and replaced
in deployment configuration; removing text from the current checkout does not revoke historical
credentials. A proven false positive may receive a narrowly scoped, reviewed allowlist entry.
Do not suppress whole directories or create a blanket baseline merely to obtain a passing check.

## Initial verification — 10 November 2026

Production dependency audit: 0 critical, 22 high, 19 moderate, 2 low advisories before remediation.
Historical Gitleaks scan: 912 commits, approximately 77 MB, 70 untriaged findings, chiefly generic
API-key rules in fixtures and retained source snapshots. These are scanner findings, not 70
confirmed live credentials. They remain open pending individual triage. The downloaded scanner's
archive checksum was verified against the official release checksums before execution.

Sources: [Gitleaks action](https://github.com/gitleaks/gitleaks-action),
[pnpm audit](https://pnpm.io/cli/audit). No independent security review is claimed.
