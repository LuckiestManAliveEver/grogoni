# Trusted-device recovery approval

A person locked out on a browser or PWA, with no passkey and a forgotten PIN, can ask a device
that is still logged in to the same phone account to vouch for that browser. The trusted device
confirms with its own screen lock. The browser then gets a session, creates its own passkey, and
resets its PIN or password.

Outcome it moves: a recovery path for phone accounts with no passkey and no verified backup email.
Before this, they had none. Trace: the security events `auth.recovery_approval_requested`,
`_approved`, `_completed`, `_declined`, `_code_rejected` and `_proof_rejected`, plus structured log
lines with the same names. Requested vs completed is the funnel.

## Flow

1. **Browser (signed out).** Log in → Trouble logging in? → Recover with: _Approve from a
   logged-in device_ → _Get an approval code_. `POST /auth/recovery/device-approval/start` returns
   a 6-digit code, a poll secret and an expiry 10 minutes out. The browser shows the code and polls
   `POST /auth/recovery/device-approval/status` every 4 seconds.
2. **Trusted device (signed in).** A prompt appears when the app opens or regains focus
   (`GET /auth/recovery/device-approval/pending`, at most once per 30 seconds). The same form is in
   Settings → Login & security → _Approve a browser_. The owner types the code and chooses _Continue_. `POST …/options` checks it, and the screen then
   names the browser that asked ("Let in Chrome on Android? It asked 1 minute ago.") before any
   screen-lock prompt.
3. **Screen lock.** In the Android app the Keystore recovery key signs the challenge after
   BiometricPrompt (fingerprint, face or screen-lock PIN), through the existing
   `signRecoveryChallenge` bridge. In a browser a user-verified passkey signs it. The approve call is
   `POST …/approve`.
4. **Browser.** The next poll returns `approved` with a new session. The browser offers _Create
   passkey_ (the browser's own WebAuthn prompt, which is this phone's screen lock), then the PIN or
   password reset. The person can skip the PIN only once a passkey exists.

`POST …/decline` (_This wasn't me_) ends a request, and the browser shows that it was declined.
Revoking the approving Android key or passkey before collection also stops the browser getting in.

### Probation and undo, for 24 hours after a browser gets in

When a browser collects its approval, the server records which session families were already
signed in. For 24 hours every other family is on probation. That covers the browser itself and
any later login: with the PIN it reset, a passkey it added, or a device key it enrolled, including
through Edge's direct `/auth/continue` handler, which does not run the store's checks. Families
survive refresh, so the owner's earlier devices stay trusted as their sessions rotate. A
probation session:

- cannot sign out other devices, including through "log out everywhere";
- cannot remove passkeys or Android keys, or enroll a device-security key;
- cannot change the PIN or password, except the one reset its recovery grant allows (this
  covers `/auth/pin/recover`, `/auth/pin/change`, `/auth/password/change` and `/auth/pin/setup`
  without a grant);
- cannot link or disconnect a sign-in provider such as Google (both disconnect routes), or create
  a password;
- cannot mint MCP/API access tokens;
- cannot invite staff, change a staff role, or delete a shop;
- cannot have another account merged into it (a pre-made device account's credentials would keep
  their old `createdAt` and survive undo);
- cannot change MFA, the backup email or the owner phone number;
- cannot delete the account;
- cannot approve, decline or undo any approval, including its own.

**Enforcement is an allowlist.** One Fastify `preHandler` in `registerCp2Routes` covers every API
route, Node and Edge alike (MCP included). For a probation session it allows a write only if it
is listed in `probationAllowedWrites` (`services/api/src/cp2/recovery-probation-routes.ts`), and
refuses the few reads that change sign-in or API access. A write route added later and not
classified is refused. `tests/recovery-probation-routes.test.ts` fails until every registered
write route is in exactly one list, rejects stale entries, and checks real requests through the
guard. Edge's direct `/auth/continue` handler runs before Fastify, so it applies the same rule in
SQL (`onRecoveryProbation` in `supabase/functions/api/auth-routes.ts`).

The store methods behind the sensitive routes also call `requireOutsideRecoveryProbation`, as a
second layer for callers that are not HTTP routes. The `guardedOperations` table in
`tests/trusted-device-recovery-approval.test.ts` covers them.

Refused reads include the owner-node inference websocket, which would register a node that
receives the shop's inference jobs. That socket now also rechecks its session on every message,
so a session signed out or undone stops receiving jobs. Operations that give an outside business
or source lasting access are refused too: adding a participant to a conversation, network
connections and routes, accepting a staff invitation, and the commerce operations
`source.connect`, `receipt.connect`, `relationship.respond` and `representation.decide`.

A probation session may register only its own new E2EE device. Re-keying or reviving an existing
device is refused, because that would redirect the owner's encrypted messages. Sessions already
on probation from an earlier approval are not counted as trusted by a later one.

This browser's own E2EE device and push subscription are allowed, because the app registers
them at startup and messaging would otherwise break for a day. Undo removes any created since.

It can still use the app, create a passkey and reset its PIN or password, which is the point of
recovery. A reset from a probation session signs out other probation sessions only. Every device
signed in before stays signed in. Passkeys and Android keys created during probation cannot
approve another browser, so one phished approval cannot be chained. A new login by the owner on
a new device during those 24 hours is restricted the same way; their earlier devices are not.

The approving device lists the browser under Login & security → _Approve a browser_ → "Let in
during the last 24 hours" (`recentApprovals` from `GET …/pending`). The list survives reloads.
Any device signed in before the approval can undo. _Undo, this wasn't me_ there, or right after
approving, does all of this:

- signs out every session family on probation, so sessions made with a passkey it added are
  covered too;
- deletes passkeys and revokes Android keys enrolled since then, including any the owner added
  in that window;
- removes sign-in providers linked since then, revokes API tokens and E2EE devices added since,
  and deletes push subscriptions added since;
- removes sign-in identities added since then, such as a first shop's phone number;
- puts back the owner's PIN, password and profile phone as they were when the browser got in.
  The approval record keeps a copy of those hashes and fields for 24 hours to make that
  possible. The PIN is compared by a digest of its hash recorded
  at login; no credential is copied.

The owner keeps the approving device, their earlier credentials and any recovery method.

When a browser gets in, two notices go out:

- every shop the owner owns gets an in-app security notice;
- a verified backup email gets "A browser was let in to your Grogoni account", which points to
  the undo.

A phone account with neither a shop nor a backup email gets no out-of-band notice. Its
approving device's list of recent approvals is the record.

## Security model

What it proves: the person holds a device that is logged in to the account **and** can unlock its
screen lock. That is the same proof the Android screen-lock recovery already accepts, made from a
second device.

- **Starting reveals nothing.** `start` never looks the number up. Unknown numbers get the same
  response and a request that stays pending until it expires. A request is tied to an account only
  when its owner approves it.
- **The code binds the two screens.** The owner must type the code shown on the browser, so an
  attacker who starts a request with someone's number cannot get it approved by a tap. Codes are
  stored as SHA-256 hashes bound to the request id and compared in constant time. A wrong code
  counts against every open request for that number. After 5, they all end.
- **Only screen-lock credentials approve.** Android keys qualify when enrolled with device
  security (`requiresServerChallenge`), not revoked, and **attested** by Android Key Attestation.
  This is checked when approving and again when the browser collects.
  - It is stricter than Android device recovery, which accepts unattested keys until
    `ANDROID_KEY_ATTESTATION_REQUIRED` is on. Without attestation, `deviceSecurity: true` is the
    client's own claim, and a session that knew the PIN could enroll a software key.
  - Keys enrolled before the attesting Android build can't approve. Their owners use a passkey,
    or turn device security off and on again.

  Passkeys qualify when asserted with user verification. The plain IndexedDB browser key never
  approves. A passkey approval ceremony is purpose-bound (`recovery_approval`, this account, this
  request), and `completePasskeyAuthentication` refuses it, so it can never log anyone in.

- **One try per challenge.** Each challenge is bound to the approving session, the credential,
  the nonce and the time it was issued. It is cleared before verification, so a failed or replayed
  signature cannot be retried. It lasts 2 minutes.
- **One session per approval.** The browser's poll secret is hashed. The first `approved` poll
  creates the session, then consumes the request, in the same request. Later polls get
  `expired`. On Edge, a poll resolves its account from the transaction id and ignores any session
  cookie the browser holds. A guest cookie would otherwise compete in the actor query's unordered
  `limit 1`, and depending on the query plan the approved account might not load.
- **The grant follows the approving credential.** The new session gets the same 5-minute,
  single-use recovery grant as passkey recovery, keyed to the credential that approved it. Revoking
  that Android key or passkey cancels the grant. The session is user-verified, so it may enrol a
  passkey right away. A PIN or password reset notifies the owner, as every recovery does. Unlike
  other recoveries, it never signs out devices that were signed in before the approval (see
  Probation), and the approving session is always kept (`recoveryApproverSessionId` on the
  grant). The owner keeps those devices, from which to see the approval and undo it.
- **Limits.** All of these are durable, and the same for unknown numbers.
  - One requester (a hash of the first `x-forwarded-for` address, the one Edge's limiter
    counts) may start 5 requests for a number in any 10 minutes.
  - A number keeps at most 10 open requests. When it is full, new ones are refused rather than
    older ones cancelled. The requester key comes from a header that a caller reaching the raw
    function URL can vary, so any eviction rule could be steered into cancelling the owner's
    own, older request.
  - Someone who keeps a number full can still stop new codes being issued for it. That is
    unavoidable when the only input is a phone number, and it never touches a request already
    open.
  - Edge applies its limit of 60 `/auth/*` requests a minute per client address, and Node applies
    per-route IP limits.
  - Migration 135 adds a partial index on approval requests by number, so the pending check on
    app focus is an index scan.

Requests that expire are deleted the next time someone starts one for the same number. Rows for
numbers nobody retries stay in `cp2_auth_transactions` until a retention job exists. That job is
not built yet.

Approval signatures use the Android payload `grogoni-device-recovery:v1:…`, the same one device
recovery signs. The server chooses every nonce and binds it to one approval request, so a
signature for one cannot complete the other. A separate prefix would need an Android release.

Social engineering is the residual risk: someone starts a request, then persuades the owner to type
their code. The browser it lets in can use the app, but probation keeps it from removing the
owner's devices or credentials for 24 hours, and an undo reverses the whole login. This follows
the restrictions Google and Microsoft put on newly recovered sessions. Every step is designed
against that:

- the code must be typed, not tapped;
- a warning comes before the code field;
- a confirm step names the browser before any screen lock;
- the approving device is never signed out;
- probation lasts 24 hours, with an undo throughout, plus in-app and email notices.

The approve screen warns: "Only enter a code shown on a screen you are holding right
now. If someone sent you a code or asked you to enter one, choose This wasn't me." The confirm step
names the requesting browser and platform from its user agent. That label is a hint, not proof:
a browser can claim any name.

### Pre-existing issues found while reviewing this

- **Removed passwords stayed in `password_credentials`.** Snapshot persistence never deleted
  that relational row, and Edge password login reads it, so a deleted password kept working.
  `deleteMissingPasswordCredentials` in `postgres-store.ts` now removes it, the same way PIN hashes
  are removed. This affected every password removal, not only undo.

These predate this feature, and this feature does not depend on them:

- **`POST /auth/pin/recover` resets the PIN from any signed-in session.** It needs no grant and
  no current PIN (`Cp2Store.recoverAccountPin`). It is blocked during probation. Outside
  probation, anyone holding a session can still replace the PIN. Nothing in the web or Android
  app calls it, so it can be removed or made to require a recovery grant.
- **Edge's direct `/auth/continue` handler can mark an existing key `requiresServerChallenge`
  without proving the private key** (`supabase/functions/api/auth-routes.ts`). It now refuses
  probation sessions. Outside probation it is unchanged. Approval does not trust such keys
  anyway, because it needs an attested key created before any probation.

### Known limits of probation

- Reads are allowed during probation. The browser is in the account and can read what the owner
  can; probation is about keeping control, not secrecy.
- A passkey it adds can run passkey PIN recovery. Each grant allows another reset, so "one reset"
  is not strictly one. Undo removes all of it.
- Edge's legacy PIN rehash rewrites the stored hash. Undo then restores the earlier hash of the
  same PIN, which still works.
- Undo also removes passkeys and device keys the owner added from a trusted device during the
  24 hours, because it cannot tell them from the browser's.

## Persistence and Edge

Requests are auth transactions (`purpose: "recovery"`, `metadata.recoveryApprovalRequest: true`),
so they need no new table; migration 135 only adds an index. Their metadata keys are all in `approvalKeys` in `shared.ts`. Email and
Android recovery ignore them: they need metadata that approval requests never carry.

An unapproved request has no account, so Edge's account-scoped default would never load it.
`recoveryApprovalTransactionScope` in `edge-snapshot-scope.ts` loads:

- for status, the request by id; once approved, the transaction id also resolves the account;
- for start, the entered number's requests that no account has claimed (`account_id is null`), so
  an approved request never enters a signed-out snapshot;
- for the approver routes, the open requests for the signed-in owner's number.

Every route that changes a number's requests takes `edge:recovery-approval:<number>` as an
advisory lock (`recoveryApprovalLockKey`, taken in `edge-domain-routes.ts` before the account lock,
in the same order everywhere). A signed-out start resolves no account, so without it, parallel
starts all passed the limits.

`tests/recovery-approval-edge-postgres.test.ts` runs the whole flow through real scoped loads and
saves on PostgreSQL, and checks that another account's requests never load.

## Tests

| Lane                              | File                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain, routes, helpers, Edge SQL | `tests/trusted-device-recovery-approval.test.ts` (every step runs on a fresh store hydrated from the previous snapshot)                                                       |
| UI, both devices                  | `tests/trusted-device-recovery-ui.test.tsx`                                                                                                                                   |
| PostgreSQL Edge scoping           | `tests/recovery-approval-edge-postgres.test.ts` (`pnpm test:postgres`)                                                                                                        |
| Real browsers, real WebAuthn      | `e2e/mobile-trusted-device-recovery.spec.ts`: two Pixel-sized Chrome contexts with virtual platform authenticators, every API call answered by an in-process API via `inject` |

Removing any one of these guards makes the domain suite fail: the code check, wrong-code
counting, the screen-lock-key requirement, signature verification, binding the challenge to its
session, consuming the request on collection, refusing approval ceremonies at login, and matching
by number.

Not covered yet: a physical Android phone approving through BiometricPrompt. The bridge call is
the one Android recovery already uses, and its instrumentation tests cover the prompt.
