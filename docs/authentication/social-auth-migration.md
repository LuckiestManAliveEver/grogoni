# Social auth migration

## Migration added

Run:

```bash
pnpm db:migrate
```

This applies:

```text
infra/db/migrations/015_social_auth_accounts_channels.sql
```

Rollback script:

```text
infra/db/rollbacks/015_social_auth_accounts_channels.down.sql
```

## New relational auth tables

- `auth_accounts`: normalized login identities projected from `user_identities`.
- `verification_challenges`: normalized OTP challenge records projected from `otp_challenges`.
- `connected_channels`: future-safe table for login/business channel links.
- `auth_audit_events`: future-safe table for auth-specific audit events.

## Runtime behavior during CP2 retirement

During the compatibility phase:

- existing auth writes continue through the CP2 store
- `user_identities` remains the immediate OAuth identity source of truth
- `auth_accounts` is dual-written from the same runtime records
- `otp_challenges` remains the immediate OTP source of truth
- `verification_challenges` is dual-written from the same runtime records

This keeps production risk controlled while giving the social-auth domains first-class relational tables.

## Deployment order

1. Set provider environment variables.
2. Run `pnpm db:migrate`.
3. Deploy API and web.
4. Confirm `/auth/oauth/providers` returns configured providers.
5. Confirm `/api/auth/providers` returns only enabled/configured login providers.
6. Test OTP, Gmail, Facebook, and TikTok login in a staging environment.

## Rollback

If the deployment fails before new writes are needed:

```bash
pnpm --filter @grogoni/api db:rollback 015_social_auth_accounts_channels
```

If rollback tooling is unavailable, manually apply:

```text
infra/db/rollbacks/015_social_auth_accounts_channels.down.sql
```

Do not drop the old `user_identities`, `oauth_sessions`, or `otp_challenges` tables during this phase.
