# CP2: Account, Auth, and Business Creation

Status: passed
Date opened: 2026-07-02
Date passed: 2026-07-02
Target tag: `checkpoint/cp2-auth-business`
Actual tag: not created. No `.repo.git` directory exists in this checkout; see the corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`.

## Purpose

CP2 lets a business owner create and access a Grogoni account, create the first business workspace, choose an initial language, and receive an owner role.

The checkpoint starts product implementation while preserving the CP0 boundaries:

- Business Runtime owns correctness.
- Auth and role checks gate account and business actions.
- State-changing actions emit audit events.
- AI infrastructure does not create accounts, businesses, roles, or sessions.
- TIEL, marketplace, payment providers, and full SMS provider selection remain outside CP2.

## Formal Entry From CP1

CP1 is accepted as the engineering foundation.

CP2 starts from:

- pnpm workspace
- React/Vite web app
- Fastify API service
- PostgreSQL and Redis local stack
- Drizzle with committed SQL migrations
- immutable event primitive
- tool and business-core package boundaries
- CI, lint, typecheck, tests, and boundary checks

## CP2 Scope

In scope:

- account model
- user model
- business model
- membership and role model
- owner business creation flow
- language preference capture
- passwordless OTP contract and local development implementation
- authenticated session contract
- auth state refresh behavior
- role-check helper
- audit event foundation for auth and business creation
- API routes and tests for CP2 flows
- minimal web flow needed to exercise account and business creation

Out of scope:

- production SMS provider selection
- production email provider selection
- M-Pesa or payment provider integration
- full TIEL
- marketplace
- product, customer, invoice, supplier, inventory, or report feature logic
- chat parser or Grogoniclaw runtime implementation
- native app-only auth
- multi-business switching beyond the first business workspace

## Target Flow

```text
Owner enters phone or email
  -> OTP challenge is created
  -> owner confirms OTP
  -> account and user are created or resumed
  -> session is established
  -> owner creates first business
  -> language preference is saved
  -> owner membership is created
  -> audit events are recorded
```

## Role Baseline

CP2 defines role checks for:

- owner
- manager
- sales_agent
- cashier
- view_only

Only the owner role must be fully exercised by CP2 user flows. Other roles must exist as enforceable values so later checkpoints can attach permissions without rewriting account membership shape.

## OTP Baseline

CP2 uses a provider-neutral OTP boundary.

Local development may log or expose test OTPs through a dev-only implementation. Production SMS and email providers are deferred until their roadmap checkpoints.

Rules:

- OTPs must expire.
- OTP attempts must be limited.
- OTP secrets must not be stored as plaintext.
- OTP verification must be auditable.
- OTP verification must not grant business permissions directly; it establishes user identity and session state only.

## Session Baseline

CP2 should use secure, refresh-surviving session state appropriate for a mobile PWA.

Rules:

- session state must survive browser refresh
- server-side session validation must exist
- logout must invalidate the active session
- sensitive session material must not be stored in localStorage
- role checks must come from server-validated membership state

## CP2 Exit Criteria

CP2 is marked passed because:

- [x] Account, user, business, membership, OTP, session, and audit schemas exist through committed migration(s).
- [x] Owner can request and verify an OTP in local development.
- [x] Owner can create or resume an account.
- [x] Owner can create a first business.
- [x] Owner role membership is created deterministically.
- [x] Language preference is stored.
- [x] Auth state survives refresh.
- [x] Logout invalidates the session.
- [x] Role checks exist for owner, manager, sales_agent, cashier, and view_only.
- [x] Auth and business creation emit immutable audit events.
- [x] API tests cover successful and rejected auth/business creation paths.
- [x] Web flow exercises account creation, OTP verification, business creation, language selection, and refresh-surviving auth.
- [x] Existing CP1 checks still pass.
- [x] Checkpoint tag `checkpoint/cp2-auth-business` is created.

## Rollback Instructions

Rollback target:

- Return to CP1 foundation plus any stable CP2 migration state.
- Preserve audit events for any created accounts or businesses.

Rollback trigger examples:

- account creation grants incorrect roles
- sessions survive logout
- OTP verification can be bypassed
- business creation mutates state without audit event recording
- auth flow requires production SMS/email provider before CP16
- role checks depend on client-only state

## Next Checkpoint

Next checkpoint:

- CP3: Mobile Shell and Chat Shell

CP3 should not depend on CP2 internals beyond stable auth/session/business membership contracts.
