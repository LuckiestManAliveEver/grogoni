# Full Grogoni default SMS client

Status: future design only; not implemented or enabled.

## Product and policy gate

Mode B must be a separate, explicitly approved Android project. Before requesting restricted SMS
permissions, Grogoni must explain the feature, obtain an affirmative user choice, request the Android
SMS role through supported role APIs, and verify that Grogoni is the selected default SMS handler.
Google Play restricted-permission eligibility, declarations, privacy policy, Data safety answers,
and review must be completed before release.

Losing the default-handler role must immediately disable privileged SMS operations. Generic Grogoni
onboarding must never request SMS permissions.

## Android application components

The future native design should include only the components required by the Android default-SMS
contract:

- activities for composing and viewing conversations;
- role-request and permission education screens;
- supported receivers/services for incoming SMS, delivery events, and MMS;
- telephony-provider access isolated behind a permission- and role-gated adapter;
- notification channels and privacy-safe notification rendering;
- non-exported internal components by default, with strict intent validation on components Android
  requires to be exported.

The manifest, intent filters, permissions, and target SDK must be reviewed against the Android and
Google Play requirements current at implementation time.

## Storage and reconciliation

The Android client needs an encrypted local message database mapped to the platform telephony
provider. Reconciliation must handle provider row IDs, multipart messages, retries, edits made by
other default handlers, clock changes, duplicate broadcasts, app restore, and role changes.
Internet Grogoni messages and carrier messages must retain distinct channel and delivery semantics.

Backup and restore must exclude encryption keys and sensitive transient state. Restored records
must reconcile against the telephony provider before appearing as authoritative.

## Sending, receiving, and MMS

Direct carrier sending may use supported subscription-aware telephony APIs only while Grogoni is the
default handler and has the required grants. It must provide sent and delivery pending intents,
normalize platform error codes, and never infer delivery from API invocation alone.

Inbound SMS needs multipart assembly, sender normalization, spam controls, database reconciliation,
and user-visible notifications. MMS requires its own transport, attachment size and MIME
validation, download policy, roaming controls, and failure recovery; it must not be represented as
ordinary SMS.

## Dual SIM

Enumerate active subscriptions only through supported APIs and after the appropriate grant. Show
the carrier/SIM choice before a chargeable send, remember it only with consent, validate the choice
again before every send, and recover when a SIM is removed, inactive, roaming, or no longer the
default. Never silently switch to a paid or roaming subscription.

## Privacy and security

- Encrypt Grogoni-owned message data at rest and protect key material with Android Keystore.
- Minimize retention and provide per-conversation deletion and export controls.
- Never copy OTPs, credentials, payment secrets, or private customer data into analytics.
- Keep notification previews configurable and hidden on locked devices by default.
- Validate recipient numbers, attachment URIs, imported provider rows, and all external intents.
- Maintain auditable consent, role, permission, send-attempt, and reconciliation events without
  full message bodies.

## Required validation before implementation approval

Test role acquisition and loss, every supported Android/API level, SMS and MMS send/receive,
multipart and Unicode segmentation, airplane mode, no service, roaming, dual SIM, inactive SIM,
reboot, process death, backup/restore, provider reconciliation, notification privacy, accessibility,
low-memory devices, and migration between Grogoni and another default SMS app.
