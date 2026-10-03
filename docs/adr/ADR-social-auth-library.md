# ADR: Social authentication library strategy

## Status

Accepted

## Context

Grogoni already has a custom Fastify auth implementation with:

- phone-plus-PIN access and email OTP
- OAuth state and CSRF validation
- server-side OAuth token exchange
- encrypted OAuth token persistence
- session cookies
- account/user/session relational tables
- Drizzle/Postgres migrations

The product requirement asks for social signup/login without adding Prisma, Supabase, or a duplicate data layer.

## Decision

Continue using the existing custom CP2 auth stack and extend it for the requested social signup/login providers.

Do not introduce Better Auth, Auth.js, Passport, Supabase Auth, Clerk, Firebase Auth, or another
overlapping framework in this phase. Phone account access remains on the Grogoni PIN/session stack;
email OTP remains the only OTP channel.

## Rationale

- Avoids two competing session systems.
- Preserves existing PIN, email OTP, and business ownership flows.
- Keeps Neon/Postgres and Drizzle as the database path.
- Minimizes migration risk while CP2 compatibility tables are still being retired.
- Allows provider secrets and OAuth token exchanges to remain server-side.

## Consequences

- The auth layer remains app-owned code and needs internal maintenance.
- Provider-specific behavior must be implemented and tested in this repo.
- A future framework migration is still possible, but should be handled as a separate ADR and migration project.
