# CP27 Google Play Legal Identity and Account Deletion

Status: active  
Date opened: 2026-07-15  
Target tag: `checkpoint/cp27-play-legal-account-deletion`

## Objective

CP27 implements step 2 of the Google Play readiness plan: establish a reviewable production legal
identity contract and provide the public and in-app account-deletion paths required for an app that
allows account creation. CP27 follows CP26 and does not approve the unresolved CP26 package,
developer-account, ownership, or signing decisions.

## Delivered artifacts

- `config/play-legal-readiness.json` is the machine-readable CP27 contract.
- `config/play-legal-readiness.schema.json` defines its permitted fields and states.
- `scripts/verify-play-legal-readiness.mjs` validates repository structure and reports owner gates.
- `apps/web/src/legal/AccountDeletionPage.tsx` publishes the external deletion resource at
  `/account-deletion`.
- `/?intent=account-deletion` opens the secure web login and takes an authenticated account to the
  Compliance deletion controls without requiring the Android app.
- The in-app action is explicitly labelled **Delete account and associated data**.
- `tests/cp27-play-legal-readiness.test.ts` protects the contract and route wiring.
- `Cp2Store.purgeExpiredAccountDeletions` propagates processor deletion first, blocks local purge
  on propagation failure, retries failed processors idempotently, and removes account-linked local
  records after all configured processors acknowledge completion.
- `services/api/src/cp2/account-deletion-processors.ts` provides signed HTTPS deletion webhooks.
- Migration 022 persists non-identifying completion proofs and processor receipts without an
  account foreign key.
- The `grogoni-account-purge` Render cron runs expired deletion work daily and fails visibly if
  processors are unconfigured or any propagation attempt fails.
- `tests/cp27-account-purge.test.ts` proves complete local removal, processor ordering, signed
  propagation, failure safety, and retry completion.
- The responsive/accessibility suite covers the public resource at compact phone, tablet, and
  desktop widths.

## Policy baseline verified on 2026-07-15

Google Play requires an app that supports account creation to provide both a readily discoverable
in-app deletion path and a functional web resource through which users can request deletion of the
account and associated data. The web path must not require the user to reinstall the app. Lawful
retention exceptions must be explained. The privacy policy must be public, non-geofenced,
non-editable by users, identify the app or developer, explain data handling and deletion, and match
the Data Safety declarations.

Authoritative sources:

- [Google Play account-deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Google Play User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311)
- [Google Play Data Safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469)

Policy requirements change. Revalidate these sources immediately before Play Console submission.

## Public deletion resource

Production URL: `https://grogoni.com/account-deletion`

The page:

1. names Grogoni as the affected app;
2. prominently offers a deletion-request action;
3. opens secure web authentication rather than requiring the Android app;
4. describes account and associated-data scope;
5. explains immediate loss of access and the recovery period;
6. explains deletion or irreversible anonymization after the recovery period;
7. explains lawful retention exceptions; and
8. links to the published Privacy Policy and Terms.

The Render static-site wildcard rewrite already serves `/account-deletion` through the PWA entry
document. Deployment must still be verified from an unauthenticated, non-administrator browser and
from every country in which the Play listing will be available.

## Authenticated deletion sequence

1. The user visits `/account-deletion` in any browser.
2. The user selects **Continue to secure deletion request**.
3. The web app opens with `intent=account-deletion`, selects the Compliance view, and prompts for
   secure account authentication.
4. The user reviews the deletion and retention explanation.
5. The user types `DELETE` and selects **Delete account and associated data**.
6. The API creates a deletion request, records its audit event, revokes account sessions, and
   returns the request reference and `anonymizeAfter` date.

Authentication protects against deletion of another person's account. It does not make the Android
app a prerequisite because the complete request path is available on the production website.

## Deletion and retention contract

- Account access is disabled and sessions are revoked when the request is accepted.
- The current recovery period is up to 30 days.
- After the recovery period, in-scope data must be deleted or irreversibly anonymized.
- Data may be retained only for a documented lawful purpose such as regulatory compliance,
  financial recordkeeping, fraud prevention, security, or dispute handling.
- Retained data must be restricted to the stated purpose and retention period.
- Deletion must be propagated to processors and service providers where associated data is held.
- Signing out, uninstalling, temporary deactivation, or hiding a shop does not satisfy account
  deletion.

The repository now implements request scheduling, processor propagation, retry-safe account purge,
and non-identifying completion evidence. Automated tests prove the behavior using deterministic
processor adapters. CP27 does **not** claim that production processor endpoints have acknowledged a
real controlled deletion; deployment evidence is still required before the checkpoint gate passes.

## Processor propagation contract

Configure the Render account-purge cron with:

- `ACCOUNT_DELETION_PROCESSORS_JSON`: a non-empty JSON array such as
  `[{"id":"identity-gateway","url":"https://processor.example/delete-account"}]`.
- `ACCOUNT_DELETION_WEBHOOK_SECRET`: a randomly generated secret of at least 32 characters shared
  only with the deletion processors.

Each processor receives an HTTPS POST containing a stable request ID and the primary-auth/OAuth
subjects it must delete. Requests include an idempotency key, timestamp, processor ID, and an
HMAC-SHA256 signature over the timestamp and exact body. A processor must return HTTP 2xx and a
non-empty `externalReference`. Grogoni stores only that reference, retry count, timestamps, status, and
a one-way subject digest in the completion proof.

If any processor times out, rejects the signature, returns a non-2xx response, or omits its external
reference, local data remains intact, the request becomes `PARTIALLY_FAILED`, the cron exits
unsuccessfully, and the next run retries only incomplete processors. Local purge begins only after
all configured processors have acknowledged deletion.

## Legal identity gate

The supplied Terms and Privacy Policy remain Version 1.0 drafts and visibly contain unresolved
production particulars. Do not remove the draft notices or enter the documents in Play Console as
final until authorized legal/privacy owners supply and approve:

- exact public Play developer name;
- exact contracting/data-controller legal entity;
- registered office, country, and organization registration number;
- verified support, privacy, and legal contact addresses;
- approved effective dates for both documents;
- legal approval/change-record reference; and
- consistency with the final Play developer profile and CP26 identity.

No legal identity or contact address has been inferred from repository content. Addresses already
appearing in drafts or infrastructure configuration are not treated as verified publication
contacts.

## Operational verification required before approval

The operations and privacy owners must execute a controlled test account through the entire flow
and retain evidence that:

1. the request is accepted only after correct authentication;
2. all account sessions are revoked;
3. the request reference and timestamps are recorded;
4. account and shop access are disabled;
5. recovery works only during the disclosed period;
6. the purge/anonymization process runs after expiry;
7. processor deletion requests are propagated and tracked;
8. retained fields match the approved retention schedule;
9. deletion failures alert the accountable owner and can be retried safely; and
10. an audit record proves completion without retaining deleted direct identifiers.

Record that evidence in a durable, access-controlled change or compliance record. Do not put
personal data, credentials, deletion exports, or processor tickets in this repository.

## Verification commands

Structural verification is expected to pass while the contract remains proposed:

```bash
pnpm android:legal:verify
pnpm vitest run tests/cp27-play-legal-readiness.test.ts tests/cp27-account-purge.test.ts tests/cp27-account-purge-migration.test.ts
pnpm playwright test e2e/responsive-accessibility.spec.ts --grep "public account deletion"
```

The approval gate intentionally fails until legal and operational fields are completed:

```bash
pnpm android:legal:gate
```

The full repository command is `pnpm run ci`; `pnpm ci` is reserved by pnpm.

## Approval procedure

1. Complete the exact legal identity and verified contact fields in the CP27 contract.
2. Legally approve the Terms and Privacy Policy, set their effective dates, and preserve the
   approval reference.
3. Replace all production placeholders and ensure the public documents match actual processing.
4. Assign monitored operations and privacy owners.
5. Test deletion fulfillment and processor propagation, then set both operational statuses to
   `verified`.
6. Record the checkpoint approver, approval date, and durable change record.
7. Set `readinessStatus` to `approved`.
8. Run `pnpm android:legal:gate`, UI certification, and `pnpm run ci`.
9. Test all three public URLs against the deployed production origin.
10. Mark CP27 passed and create the target tag.

## Exit criteria

CP27 passes only when:

- the developer and legal entity identities are exact and consistent with CP26 and Play Console;
- public support, privacy, and legal contacts are verified and monitored;
- final Terms and Privacy Policy versions have effective dates and legal approval;
- `/privacy`, `/terms`, and `/account-deletion` work publicly over HTTPS;
- the in-app and external deletion paths are discoverable and functional;
- deletion of associated data and service-provider propagation are verified end to end;
- lawful retention is accurate, minimal, and disclosed;
- the Data Safety answers match production behavior;
- `pnpm android:legal:gate`, UI certification, and full CI pass; and
- the checkpoint record and tag are captured.

## Current blockers

- CP26's permanent Android and developer-account identity is not approved.
- Production legal entity and registered particulars are unknown.
- Publication contact channels are not verified.
- Terms and Privacy Policy remain drafts without effective dates or legal approval.
- Production account purge and processor propagation lack controlled-account deployment evidence.
- Operations and privacy owners are unassigned.

## Rollback

Before Play Console submission, remove the public route and revert the CP27 contract if the
deletion design changes. A submitted deletion URL must never be removed or redirected to an
unrelated page while a Play listing relies on it. If the flow becomes unavailable after submission,
treat it as a release incident, restore the last working public resource, pause affected rollout,
and correct the Play Console declaration if the URL changes.

## Next checkpoint

CP28 covers messaging, user-generated content, and generative-AI safety controls and declarations.
