# Authentication repair implementation report

Status: partial repair; PIN-first production acceptance criteria are not met. No deployment performed.

## Scope and findings

See [pre-change audit](pin-first-audit.md) for the source files examined and architectural findings. This was a targeted source audit, not a completed file-by-file audit of every authentication file, database policy or production system.

Modified application files:

- `apps/web/src/PhoneFirstAuthentication.tsx`: require explicit passkey selection; offer passkey after two invalid PIN attempts; generic delivery wording; numeric six-digit recovery code; resend with 60-second UI cooldown; change-email control clears pending proof and credentials; expiration/spam guidance; live status and offline feedback. Existing sessions, MFA, password support and credential-reset paths remain.
- `services/api/src/cp2/routes.ts`: account-enumeration-safe recovery response now says “If this email is registered, we'll send a verification code.” Authorized server logs distinguish simulated mail from provider acceptance, without claiming inbox delivery. Existing sanitized provider failure logs remain.
- `services/api/src/cp2/domains/otp/store.ts`: accepted recovery resend expires older challenges for the same destination/purpose. Rejected resends do not invalidate existing proof.
- `tests/phone-first-authentication-ui.test.tsx`, `tests/otp-recovery.test.ts`: explicit authentication gestures, recovery controls, and resend supersession coverage.

Confirmed defects: automatic passkey prompt without method selection; false sent claim despite swallowed delivery errors; overlapping valid recovery OTPs; missing resend controls. The local `.env.local` contains a Brevo API key but lacks `GROGONI_EMAIL_FROM`. Presence was checked without printing secret values. Production configuration and the cause of actual mailbox non-delivery are unverified.

## Architecture and limitations

Custom Grogoni OTP generation/verification remains authoritative. No Supabase Auth recovery code system was added. No schema changes, credential removals, or account migrations.

PIN-first quick unlock is deliberately not activated using remembered identifiers or browser-controlled device IDs. Existing remote phone/PIN login lacks trusted-device proof; implementing a new device-bound credential, enrollment, revocation and durable attempt enforcement across both Fastify and direct Postgres remains necessary. Existing PIN behavior remains a security risk and requires further work before rollout. IndexedDB keys must not be described as hardware-backed.

Provider acceptance is only HTTP acceptance. There is no provider delivery webhook, message-ID reconciliation, bounce/suppression dashboard or controlled-inbox confirmation in this change. Detailed delivery-state tracking remains outstanding. Existing request history is process-local; distributed rate-limit persistence remains outstanding. Account security settings consolidation and comprehensive browser/PWA/security testing are not complete.

## Validation

- `node node_modules/vitest/vitest.mjs run tests/phone-first-authentication-ui.test.tsx tests/otp-recovery.test.ts tests/recovery-start-privacy.test.ts tests/email-pin-recovery.test.ts tests/email-provider.test.ts --maxWorkers=1 --minWorkers=1`: 5 files, 28 tests passed.
- Latest UI run after adding recovery-control coverage and offline feedback: 12 tests passed.
- `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit`: passed, including the final rerun.
- Targeted ESLint on all five modified TypeScript files: passed.
- `git diff --check`: passed.
- No end-to-end browser, real Android, production DNS/provider or real-mailbox tests performed. Mock provider tests do not prove real delivery.

## Production requirements and verification gate

Configure `NODE_ENV=production`, `BREVO_API_KEY`, and a verified `GROGONI_EMAIL_FROM` in the actual API runtime. Check the sender domain's SPF/DKIM/DMARC, Brevo sender status, quota, bounce and suppression records. Local environment files are not proof of deployed secrets. Preserve existing signing/hash secrets and database contents.

Before rollout, receive a recovery OTP in a controlled inbox linked as a verified recovery address; confirm Brevo delivery status, enter the code, complete recovery, and reject replay. Verify MFA cannot be bypassed. Test eligible PIN unlock, fallback, revocation and session restoration on real Android/PWA devices once device binding is implemented. Real-mailbox verification has not occurred, so email recovery must not be described as repaired end to end.

## Staging and rollback

Deploy the API and web changes to staging using the existing deployment process. Keep PIN-first rollout disabled until the security gate above passes. Verify generic public responses, sanitized operator diagnostics, resend expiry and existing-account access. Promote in a limited cohort only after Android and mailbox checks. Roll back to the previous web/API artifacts if authentication or delivery regressions occur. No database migration needs rollback; superseded OTPs remain expired and users must request a fresh code. Do not restore expired recovery proofs.
