# Owner phone identity

Phone numbers are required identity and support attributes. They are not SMS-verified during shop
registration.

## Onboarding

An authenticated user who creates a first shop must have a valid owner phone number. The first-shop
screen collects a country and phone number, normalizes it in the browser, and saves it through
`PUT /account/phone`. The API parses it again before the shop-details step can continue. No
Firebase, reCAPTCHA, SMS, verification token, confirmation result, or OTP challenge participates in
this flow.

Existing users with a valid saved phone are not prompted again. Repeated saves by the same owner
are idempotent, and the same owner may use the saved number for multiple shops.

## API contract

`PUT /account/phone` requires an authenticated, recently confirmed session:

```json
{
  "phoneNumber": "0712345678",
  "country": "KE"
}
```

`POST /businesses` accepts `phoneNumber` and `phoneCountry` during first-shop creation and otherwise
uses the authenticated user's saved number. The owner always comes from the server session; a
client-provided owner ID is never authoritative. Shop creation fails with HTTP 400 when no valid
phone identity is available.

The server uses `libphonenumber-js` to store E.164, ISO country, and national-number forms.
Cross-owner conflicts return HTTP 409 with `PHONE_ALREADY_IN_USE` and do not disclose the other
account. Phone update attempts are rate limited. Invalid or unsupported formats return a
user-safe HTTP 400 response.

## Data model and ownership

The `users` table stores:

- `phone_number_e164`
- `phone_country_code`
- `phone_national_number`
- `phone_verification_status = 'unverified'`
- `phone_added_at`
- `phone_updated_at`
- `phone_source`
- `public_phone_enabled = false`

The existing `business_memberships.user_id` owner membership links the authenticated user and
their phone identity to every owned shop. The phone is not copied into the business record because
the membership is the authoritative relationship. It does not replace the user ID, business ID, or
global Grogoni shop ID.

Migration `029_owner_phone_identity.sql` adds nullable legacy-safe columns, normalizes already
valid E.164 phone login identities where possible, and adds lookup/conflict indexes. Compulsory
capture is enforced at the application boundary so legacy accounts can migrate without destructive
backfill or a premature `NOT NULL` constraint.

## Authentication architecture

Phone account signup and login use the existing Grogoni PIN routes. Email verification remains on the
email OTP routes. Phone OTP requests and verification are rejected. There is no Firebase phone-auth
package, initialization module, server token verifier, feature flag, or Firebase environment
variable.

Changing an owner phone requires a recent session created by PIN confirmation or a newly
authenticated session. A changed number remains `unverified`.

## Privacy, audit, and retention

The full number is available only in the authenticated owner's profile and authorized operational
storage. Public business and storefront serializers do not include owner phone fields, and public
display stays disabled by default.

Audit events record the acting user, request metadata already captured by the audit system, time,
and masked previous/new values such as `+254******678`; they never record the complete phone
number. Application logs must follow the same masking rule.

Phone identity follows the account deletion and 30-day recovery policy. A quarantined account keeps
the identity for recovery and duplicate-account review. Permanent purge removes it with the user.
Support staff must confirm account ownership through the approved session/PIN or passkey process
before using the number for manual recovery, fraud review, or last-resort contact. Support must not
claim the number is verified.

## Environment and operations

No phone provider configuration is required. HTTPS remains mandatory in production, and normal
database, session-cookie, origin, and WebAuthn configuration still applies. Operational checks
should cover:

1. migration 029 is applied;
2. first-shop registration rejects missing/invalid numbers;
3. settings updates require recent authentication;
4. public storefront payloads contain no phone identity fields;
5. audit output contains only masked values.
