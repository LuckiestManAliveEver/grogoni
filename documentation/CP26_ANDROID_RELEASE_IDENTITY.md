# CP26 Android Release Identity Foundation

Status: active  
Date opened: 2026-07-15  
Target tag: `checkpoint/cp26-android-release-identity`

## Objective

CP26 establishes one reviewable source of truth for Grogoni's Google Play identity before an
Android project, signing key, Play Console application, or store listing is created. This prevents
an irreversible package name or account ownership decision from being embedded in build files by
accident.

CP26 implements step 1 of the Google Play readiness plan. It does not create the Trusted Web
Activity or an Android App Bundle; those begin only after this checkpoint passes.

## Authoritative artifact

`config/android-release-identity.json` is the machine-readable release identity contract.
`config/android-release-identity.schema.json` documents its shape. Values in Android build files,
Bubblewrap configuration, Digital Asset Links, Play Console, and release automation must be derived
from or checked against this contract in later checkpoints.

The current contract is `proposed`, not approved. Proposed values may be reviewed and changed now.
After the package is registered in Play Console, `android.applicationId` is treated as permanent.

## Decision register

| Decision               | Proposed value        | State                       | Basis and consequence                                                     |
| ---------------------- | --------------------- | --------------------------- | ------------------------------------------------------------------------- |
| Product name           | `Grogoni`         | established                 | Matches the web application and PWA manifest.                             |
| Launcher name          | `Grogoni`                | established                 | Matches `short_name` and fits launcher surfaces.                          |
| Production origin      | `https://grogoni.com` | established                 | Declared by the Render production blueprint.                              |
| Production API         | `https://grogoni.com` | established                 | Declared by the Render production blueprint.                              |
| Android wrapper        | Trusted Web Activity  | proposed                    | Shortest path that preserves the existing PWA runtime.                    |
| Application ID         | `market.grogoni.app`     | proposed—approval required  | Valid, brand-specific namespace; permanent after Play registration.       |
| Developer account type | organization          | proposed—approval required  | Keeps the listing and signing authority with the operating entity.        |
| First Play track       | internal              | proposed                    | Allows artifact and reviewer-access validation before broader testing.    |
| Version name           | `0.1.0`               | established for first build | Matches the workspace package version.                                    |
| Version code           | `1`                   | proposed                    | First Play artifact; every later upload must use a larger integer.        |
| Minimum SDK            | 23                    | proposed                    | Preserves low-end Android reach while setting a defined support floor.    |
| Target/compile SDK     | 35                    | policy baseline             | Meets the policy verified on 2026-07-15; must be rechecked before upload. |
| Play App Signing       | enabled               | proposed                    | Google holds the app-signing key; Grogoni controls a separate upload key.    |

## Permanent identity rule

Do not create the Play Console application, generate the TWA project, publish Digital Asset Links,
or issue a production signing certificate until the application ID is explicitly approved.

Changing an application ID after publication creates a different Android application. It does not
upgrade the original listing or preserve its install base. Approval must therefore confirm:

1. `market.grogoni.app` is the intended permanent namespace.
2. The approving organization controls the Grogoni brand and `grogoni` domain.
3. No existing private or public Android application already uses the namespace within the
   organization.
4. The same value will be used in Play Console, Android build files, signing certificates, and
   `/.well-known/assetlinks.json`.

## Developer account identity

The recommended account type is `organization`. CP26 does not claim that an account exists or that
Google has verified it. Before approval, record in the contract:

- the exact public Play developer name;
- the exact registered legal entity name;
- the Play developer account ID;
- completed Google identity verification;
- the primary Play Console owner.

The public developer name, legal entity, Terms of Service, Privacy Policy, support identity, billing
profile, and domain ownership must not contradict one another.

## Ownership and separation of duties

Four accountable roles must be recorded. A role address is acceptable when it is monitored,
access-controlled, and recoverable; a personal address should not be the only owner.

| Role                       | Responsibility                                                            |
| -------------------------- | ------------------------------------------------------------------------- |
| Release owner              | Approves version, track, rollout, and rollback decisions.                 |
| Play Console primary owner | Controls account access, verification, policy declarations, and recovery. |
| Upload-key custodian       | Creates, stores, backs up, rotates, and uses the upload key.              |
| Incident-recovery owner    | Coordinates lost-key, compromised-account, and rejected-release recovery. |

At least two authorized people should be capable of recovering the organization account. Grant
least-privilege Play Console roles for routine work.

## Signing boundary

- Use Play App Signing for production distribution.
- Create a separate upload key only after ownership is assigned.
- Never commit a keystore, private key, password, recovery code, service-account credential, or
  Play Console export to this repository.
- Commit certificate fingerprints only; fingerprints are public identifiers required by Digital
  Asset Links.
- Store signing material in an approved secrets/password management system with access logging and
  recovery documentation.
- Key generation, fingerprints, and Digital Asset Links are CP29 work after CP26 approval.

## Versioning contract

- `versionName` is the user-visible semantic version and initially matches root `package.json`.
- `versionCode` is a monotonically increasing positive integer used by Google Play.
- No uploaded artifact may reuse or decrease a version code.
- Release branches and tags must identify the source commit used to produce each AAB.
- The target API policy must be revalidated immediately before the first upload because Play
  requirements change over time.

## Verification commands

Structural verification is safe while decisions remain proposed:

```bash
pnpm android:identity:verify
pnpm vitest run tests/cp26-android-release-identity.test.ts
```

The approval gate intentionally fails until all owner-controlled fields are completed:

```bash
pnpm android:identity:gate
```

## Approval procedure

After the authorized owner confirms the decisions:

1. Set `android.applicationIdStatus` to `approved`.
2. Set `developer.accountTypeStatus` to `approved`.
3. Populate the developer and ownership fields with exact identities or monitored role addresses.
4. Set `developer.identityVerificationStatus` to `verified`.
5. Document upload-key rotation and recovery, then set
   `signing.rotationAndRecoveryDocumented` to `true`.
6. Record the approver, approval date, and durable change record.
7. Set top-level `identityStatus` to `approved`.
8. Run `pnpm android:identity:gate` and the full repository CI.
9. Mark CP26 passed in the checkpoint log and create the target tag.

## Exit criteria

CP26 passes only when:

- the permanent application ID is explicitly approved;
- the organization/personal account choice is explicitly approved;
- Google developer identity verification is complete;
- public developer and legal entity names are recorded;
- release, console, upload-key, and recovery ownership are assigned;
- signing separation, rotation, backup, and recovery are documented;
- the production origin and API still match deployed infrastructure;
- `pnpm android:identity:gate` passes;
- repository CI passes; and
- the checkpoint status and tag are recorded.

## Current blockers

The following facts cannot be inferred safely from source code and remain owner decisions:

- approval of `market.grogoni.app` as the permanent application ID;
- confirmation that the Play account will be an organization account;
- exact Play developer and registered legal entity names;
- Play developer account ID and Google verification status;
- named or role-based release, console, signing, and recovery owners; and
- the durable approval/change-record reference.

CP26 remains active until those values are supplied. The structural verifier passes; the approval
gate must continue to fail while the checkpoint is active.

## Rollback

Before Play registration, revert or amend the proposed contract and rerun structural verification.
After Play registration, the package name cannot be rolled back as an ordinary configuration
change; a different package name represents a different application and requires a new listing.

No signing keys or external Play resources are created in CP26, so rollback of this checkpoint does
not require revoking credentials or deleting an application.

The repository CI command is `pnpm run ci`. Do not use `pnpm ci`; pnpm reserves that command and
does not dispatch it to the package script.

## Subsequent Google Play checkpoints

- CP27: production legal identity and external account deletion.
- CP28: messaging, UGC, and generative-AI safety controls.
- CP29: Trusted Web Activity, signing, Digital Asset Links, and AAB generation.
- CP30: Android device and platform validation.
- CP31: Data Safety inventory, permission disclosures, and declarations.
- CP32: Play Billing classification and implementation decision.
- CP33: store listing, graphics, reviewer access, and App Content declarations.
- CP34: internal/closed testing, production access, staged rollout, and monitoring.
