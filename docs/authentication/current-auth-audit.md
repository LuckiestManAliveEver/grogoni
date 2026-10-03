# Current authentication audit

Date: 2026-07-18

## Framework decision

The repository does not currently use Better Auth, Auth.js/NextAuth, Passport, Supabase Auth,
Clerk, Prisma, or Firebase Auth. CP2 owns sessions, accounts, PIN access, email verification, and
business permissions.

Current auth is a custom Node/Fastify CP2 auth implementation:

- API routes: `services/api/src/cp2/routes.ts`
- Auth/session store: `services/api/src/cp2/store.ts`
- OAuth provider/token logic: `services/api/src/cp2/oauth.ts`
- Email provider adapter: `services/api/src/cp2/email-provider.ts`
- Postgres/Drizzle migration execution: `services/api/scripts/migrate-db.mjs`
- Frontend auth UI: `apps/web/src/main.tsx`

Because this stack already has email OTP, PIN/passkey access, OAuth state/CSRF, encrypted OAuth
token persistence, session cookies, and Drizzle/Postgres migrations, the safe path is to extend the
existing implementation instead of adding an overlapping auth framework.

## Existing auth capabilities

- Email signup/recovery verification and phone-plus-PIN signup/login.
- WebAuthn passkey registration, login, listing, and revocation.
- Session cookie creation and logout.
- OAuth start/callback flow with server-side token exchange.
- OAuth token encryption using AES-256-GCM.
- Account/user/session relational tables.
- User identity and OAuth session relational tables.
- PIN setup/login/recovery.
- Connected social account display and disconnect flow.
- One-tap device account creation with progressive phone/email/PIN/passkey strengthening,
  cookie-loss recovery through a device-bound signing key, and proof-gated identity-collision
  merging; see `docs/authentication/progressive-identity.md`.

## Implemented social-login additions

- Primary frontend choices now include:
  - Continue with phone
  - Continue with email
- TikTok OAuth provider metadata is now supported.
- `/api/auth/...` aliases were added for provider discovery, OAuth start/callback, OTP request/verify, session, logout, logout-all, and login account list/link/disconnect.
- Session-scoped login accounts are now separate from business/customer channels in the settings UI.
- New relational social-auth tables were added in migration `015_social_auth_accounts_channels.sql`.

## Security notes

- OAuth token exchange remains server-side.
- OAuth tokens are encrypted before persistence.
- Existing OAuth state and CSRF validation remains in place.
- Normal login uses a passkey, PIN, or connected social identity.
- Phone OTP is rejected. Phone access uses a Grogoni PIN, while compulsory first-shop phone capture is
  stored as an unverified identity/support attribute.
- Provider secrets stay in server environment variables and are not exposed to Vite.

## Known follow-up work

- Configure production provider apps in Google, Facebook, and TikTok dashboards.
- Add stricter OTP rate-limit backing storage if API instances scale horizontally.
- Move business channel connect/disconnect UX into a dedicated channel management screen when provider APIs are fully configured.
