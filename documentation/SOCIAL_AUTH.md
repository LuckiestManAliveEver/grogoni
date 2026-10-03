# Authentication channels

Social OAuth login is disabled. The signup and login UI do not show Google, Facebook, TikTok,
Apple, GitHub, Microsoft, LinkedIn, or X. The API marks those providers disabled and rejects OAuth
start/callback requests and the legacy `/auth/social/login` endpoint with `403`.

Phone authentication uses Grogoni phone-plus-PIN routes. It does not create or link a social identity,
and it sends no SMS.

## Available choices

- Phone signup/login with an owner PIN.
- Email verification and recovery through the existing email OTP path.
- Compulsory unverified phone capture before first-shop creation.

See `docs/authentication/provider-setup.md` for the server configuration.
