# Authentication security operations

## Deployment checks

1. Apply database migrations through `046_disable_sms_verification.sql` before starting the
   new API build.
2. Set independent random values for `OTP_HMAC_SECRET`, `PASSWORD_HASH_SECRET`,
   `AUTH_AUDIT_HMAC_SECRET`, and `AUTH_TOKEN_ENCRYPTION_KEY`. Store them only in the deployment secret
   manager.
3. Confirm retired phone challenge, verification, resend, webhook, gateway-health, and SMS-metrics
   routes return 404. Confirm phone password recovery returns `phone_recovery_unavailable`, the
   retired phone PIN recovery-code route returns 404, and PIN reset requires a purpose-bound
   passkey ceremony.
4. Probe `/health/ready`.
5. Perform a controlled signup, email verification/recovery, MFA, passkey, logout, and
   session-revocation exercise.
6. Confirm the browser receives `Secure; HttpOnly; SameSite=Lax; Path=/` access and refresh cookies,
   that `/session/refresh` receives the refresh cookie, and that the service worker never serves an
   auth response from cache.

## Render authentication settings

The checked-in `render.yaml` supplies the safe feature flags and 15-minute/30-day/180-day session
limits. In the Render dashboard, keep `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=lax`,
`SESSION_ROTATION_ENABLED=true`, and
`SESSION_REUSE_DETECTION_ENABLED=true`. Set `WEBAUTHN_RP_ID=grogoni` and
`WEBAUTHN_EXPECTED_ORIGINS=https://grogoni.com,https://www.grogoni.com` unless the actual domains
differ. If a cookie domain is needed, use a hostname only; host-only cookies are safer by default.

Render must generate or securely store values of at least 32 characters for `OTP_HMAC_SECRET`,
`PASSWORD_HASH_SECRET`, `AUTH_AUDIT_HMAC_SECRET`, and `AUTH_TOKEN_ENCRYPTION_KEY`. Startup validates
these production invariants and fails closed on an unsafe configuration. Apply migrations using the
direct PostgreSQL URL, while normal API traffic uses the pooled URL.

## Monitoring

Alert on elevated email challenge starts, verification failures, attempt lockouts, resend limits, and
recovery traffic. Logs should contain correlation/challenge IDs and hashed identifiers, never OTPs,
passwords, TOTP secrets, recovery codes, bearer credentials, or raw session tokens.

## Rotation and incident response

Coordinate `OTP_HMAC_SECRET` rotation with a brief drain window because outstanding email codes
become unverifiable.
If session material may be exposed, revoke affected session families and require reauthentication.

Back up PostgreSQL using the existing backup workflow and test restoration regularly. Historical SMS
delivery rows are retained only as audit data; expire them under the project retention policy.
