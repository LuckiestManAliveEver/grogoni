# Private Neon Backups

Business data stays in the existing Neon database. The backup destination is the
existing Supabase project's private `grogoni-neon-backups` bucket. No Railway
service or new always-on host is needed.

## Backup and Recovery

The `Neon Private Backup` GitHub workflow uses PostgreSQL 18 tools, matching the
audited Neon server major version. It runs the existing custom-format `pg_dump`
backup script, then encrypts the dump with AES-256-GCM before uploading it.
Every file has a fresh nonce and authenticated format header. The plaintext
dump is never uploaded. The uploader refuses public buckets, overwrites,
unapproved project origins and oversize files; it reads the uploaded ciphertext
back and verifies its exact length and SHA-256 checksum before reporting success.

The workflow then downloads and authenticates the stored object and performs a
full `pg_restore` into its isolated `grogoni_backup_restore` PostgreSQL service.
It verifies the migration ledger and task, procurement and daemon tables before
recording a successful restore drill. Restore targets are restricted to that
dedicated local/service database; Neon and query-based routing overrides are
rejected. Failed authentication removes partial plaintext.

No dump is published as a GitHub artifact. Credentials, raw rows and dump
contents are not printed. `database_backup_runs` and `database_restore_drills`
remain the existing operational ledgers. The synthetic round-trip also runs
in ordinary CI, using disposable databases, real PostgreSQL binaries and mock
private storage, without production data or storage credentials.

## Activation

Supabase owner access was restored on 2026-10-16. The private bucket and three
repository backup secrets are configured. An independent recovery key is retained
in the owning workspace's ignored `.env.backup`, with owner-only file permissions.
Scheduling remains disabled until the first complete remote restore drill passes.

The first manual run failed before upload because libpq could not find its default
root certificate file. The backup step now explicitly uses the PostgreSQL
container's system CA bundle and checks it exists; the audited production Neon
connection retains `sslmode=verify-full` and `channel_binding=require`. The local
restore step does not inherit the production-only trust configuration.
See [PostgreSQL TLS verification](https://www.postgresql.org/docs/18/libpq-ssl.html).

1. Create `grogoni-neon-backups` in project `gnmndzsughifhboqvsgd`, with public
   access disabled. Do not grant anonymous or authenticated-user object access.
2. Set these repository Actions secrets through the owning account:

   - `BACKUP_DIRECT_DATABASE_URL`: the existing unpooled Neon connection.
   - `SUPABASE_BACKUP_SERVICE_ROLE_KEY`: server-only Storage access for the
     existing project, never a frontend environment variable.
   - `NEON_BACKUP_ENCRYPTION_KEY`: an independent cryptographically random
     32-byte key encoded as 64 hexadecimal characters. Retain a secure recovery
     copy outside both Neon and the bucket; do not reuse an application auth key.

3. Manually dispatch `Neon Private Backup` and require the complete restore drill
   to pass, not only the upload step.
4. Only then set the repository variable `NEON_BACKUPS_ENABLED=true`. Scheduled
   backups run daily at 02:17 UTC. Before activation, schedules skip rather than
   falsely claiming a configured production backup. Manual dispatch fails closed
   if credentials or storage are missing.

Keep the original key when updating credentials. Retain old keys in recovery
custody before any intentional rotation; old objects cannot be decrypted with
a replacement key. Remote objects are not automatically deleted by this
implementation. Review retention, capacity and deletion policy before enabling
any cleanup; the existing local 14-day pruning is not a cloud retention promise.
The default encrypted object bound is 50 MiB; larger backups require an explicitly
reviewed bound and matching bucket/project upload limits.

## Manual Recovery

With the server-only key and encryption key set in a private environment:

```sh
node scripts/download-supabase-backup.mjs neon/grogoni-TIMESTAMP.dump.enc /private/new-restore.dump
pg_restore --list /private/new-restore.dump
```

Downloading does not modify a database. Inspect the dump and restore first into
a disposable database. Actual production recovery is a separate authorized
operation; never point an automated restore drill at production.

References: [Supabase private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals),
[authenticated downloads](https://supabase.com/docs/guides/storage/serving/downloads).
