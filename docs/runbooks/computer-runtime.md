# Computer Runtime Runbook

## Startup

Set `COMPUTER_RUNTIME_URL`, the same high-entropy `COMPUTER_RUNTIME_SERVICE_TOKEN` on API and
worker, and `AUTH_TOKEN_ENCRYPTION_KEY` on API. Locally run
`docker compose --profile computer up computer-runtime` or
`pnpm --filter @grogoni/computer-runtime dev`. Chromium never runs in the API or web process.

Required configuration should include:

- `COMPUTER_RUNTIME_URL`: private worker origin
- `COMPUTER_RUNTIME_SERVICE_TOKEN`: API-to-worker bearer secret
- `AUTH_TOKEN_ENCRYPTION_KEY`: 32+ character profile encryption key
- allowed and blocked domains
- private-network blocking policy
- session timeout
- max concurrent sessions
- profile encryption key reference
- live-view stream settings

The worker container runs as `pwuser`, drops Linux capabilities, has a read-only root filesystem,
and receives bounded `/tmp`, CPU, and memory. Production network policy must also deny metadata,
RFC1918, and internal service ranges at the infrastructure layer.

## Operations

Monitor:

- `computer_sessions_created`
- `computer_sessions_active`
- `computer_actions_total`
- `computer_actions_failed`
- `computer_approvals_requested`
- `computer_approvals_approved`
- `computer_approvals_rejected`
- `computer_human_takeovers`
- `computer_runtime_handoffs`
- `computer_provider_errors`

## Incidents

If a consequential action has unknown outcome, do not retry blindly. Check the external site state, record the reconciliation result, and resume from a fresh observation.
