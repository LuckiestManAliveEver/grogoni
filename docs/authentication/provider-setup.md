# Authentication provider setup

Grogoni supports email verification and phone-plus-PIN account access. Phone numbers collected
for first-shop registration are compulsory identity/support attributes and remain unverified.

Google, Facebook, TikTok, Apple, GitHub, Microsoft, LinkedIn, and X login are disabled in the
frontend and backend. Their OAuth client IDs and secrets are not required. No Firebase or SMS
provider configuration is required.

## Runtime behavior

- `Continue with email` creates a new account through email verification.
- Returning email users sign in with the verified email address and owner PIN; normal login does not
  send another code.
- `Forgot PIN?` sends a challenge-bound email verification code and allows the verified account to
  set a new PIN, including on a browser without saved local account data.
- `Continue with phone` creates an account by setting the owner PIN.
- `Use phone and PIN` performs normal login.
- Phone OTP request and verification routes return `403`; email verification remains available.
- First-shop registration saves the normalized owner phone without sending an SMS.
- OAuth starts, callbacks, and the legacy social-login route return `403`.

See `docs/identity/owner-phone-identity.md` for the onboarding, API, privacy, and support contract.
