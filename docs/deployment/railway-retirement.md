# Railway Retirement

Railway hosting and repository deployment links are retired at the owner's
request. The API, staging web, private computer worker, database backup job and
shop-purge job must not be recreated automatically. Their schedules and Railway
URLs are no longer operational.

Neon remains the existing business database. Retiring Railway does not delete,
migrate or replace its data. Existing Vercel and Supabase configuration and
the owner's separate local daemon work are not changed by this retirement.
Neon storage alone does not provide an API or a background runtime. Any caller
still using a retired Railway URL needs an explicitly configured replacement.

Railway service-setting payloads, its standalone Caddy proxy and the dedicated
proxy validation CI step have been removed. Provider-neutral startup safety
and build identity compatibility remain; no inference, approval, persistence
or production-backup safety checks are weakened to hide deployment failures.

The Railway backup and purge schedules no longer run. Before relying on an
alternative host in production, explicitly provision durable private backups
and the required maintenance schedules there. No replacement backup destination
is assumed, and no production data is exported as part of this retirement.

Project-scoped credentials are not committed. Revoke retired Railway tokens
and remove this repository's Railway GitHub App access in GitHub settings if
account-level access remains after the service source links are disconnected.
Do not uninstall a shared app from unrelated repositories.
