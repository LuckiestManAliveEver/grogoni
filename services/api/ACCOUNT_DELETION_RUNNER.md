Account Deletion Runner
======================

This service can optionally run a daily purge that contacts configured external deletion
processors (webhooks) and then finalizes local account data removal once processors confirm
deletion.

Environment
-----------

- `ENABLE_ACCOUNT_DELETION_RUNNER=true` — enables the in-process daily purge runner.
- `ACCOUNT_DELETION_PROCESSORS_JSON` — JSON array of processor configs, e.g.

  [{ "id": "identity-gateway", "url": "https://processor.example/delete" }]

- `ACCOUNT_DELETION_WEBHOOK_SECRET` — HMAC secret used to sign processor requests. Must be
  at least 32 characters.

Deployment notes
----------------

1. Provide `ACCOUNT_DELETION_PROCESSORS_JSON` and `ACCOUNT_DELETION_WEBHOOK_SECRET` as
   environment variables in your deployment (do not check them into source control).
2. Set `ENABLE_ACCOUNT_DELETION_RUNNER=true` if you want the API process to run the daily
   purge. The runner executes once after startup, prevents overlapping runs, and stops cleanly
   during API shutdown. Alternatively, run the purge script as a scheduled job using:

```bash
pnpm --filter @grogoni/api db:purge-accounts
```

Security
--------

- Ensure webhook endpoints use HTTPS and authenticate/validate inbound requests.
- Keep `ACCOUNT_DELETION_WEBHOOK_SECRET` secret and rotate periodically.
