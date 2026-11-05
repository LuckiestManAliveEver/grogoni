# Google Play Console submission

For the Play Console account owner. Do the steps in order. Menu names can change; if one is missing,
search for it in Console.

## 1. Fix what will fail review

**The privacy policy is the known blocker.** `https://grogoni.com/privacy` shows "Draft", contains
placeholders such as `[Legal Entity Name]`, and never mentions SMS, camera or location. Play compares
it with the app's permissions and the Data Safety form. Publish a final version first. It must name
the legal entity and a contact, and state what happens to SMS and MMS, contacts, camera, location, and
the optional business sync. The source is `apps/web/src/legal/privacy-v1-draft-part-*.md`.

## 2. Create the app

1. Console > **Create app**. Name `Grogoni`, type App, free or paid, accept the declarations.
2. Open **Test and release > Testing > Internal testing** and create a release. This is the first
   track in `config/android-release-identity.json`.

## 3. Choose the signing key, permanently

Console asks this on the first release, and it cannot be undone.

- **Google-generated key:** Play builds are signed with a key that differs from the website APK.
  Android refuses to install one over the other. A website user moving to Play must uninstall first. Their
  SMS stay on the phone, but they lose their sign-in, app settings and any messages waiting to sync.
- **Your existing key (recommended if website users exist):** both channels stay compatible. Choose
  to use a different key, then follow Console's export steps. It gives a PEPK tool and an encryption
  key to run on `backups/android-release/grogoni-release.p12`. Back up the key first.

## 4. Upload the bundle

Build and verify it as in `apps/android/README.md`, upload `app-release.aab`, then set
`lastPlayVersionCode` in `config/android-play-policy.json`. The SMS declaration only appears after a
bundle with SMS permissions is uploaded.

Every later upload, including a fix after a rejection, needs a higher `versionCode` in
`apps/android/app/build.gradle.kts` and `config/android-release-identity.json`.

## 5. Complete Policy > App content

**Sensitive permissions (SMS).** Grogoni declares `READ_SMS`, `SEND_SMS`, `RECEIVE_SMS`, `RECEIVE_MMS`
and `RECEIVE_WAP_PUSH`. Choose **Default SMS handler** as the core purpose.

- **Demo video.** The release app blocks screen capture (`FLAG_SECURE`), so a screen recording of it
  comes out black. Record a capture-enabled debug build instead (see `apps/android/README.md`), or
  film the phone with a second device. Show: open Grogoni, set it as default SMS app, grant access,
  send a message, receive a message. Upload it unlisted and paste the link.
- **Instructions for reviewers.** SMS needs no account, and guests can browse and chat. Shop and
  account screens need one. Sign up in the app with a test phone number, then under **App access**
  give that number and password, or Play rejects the app as inaccessible.

Review risk: Play allows SMS access for core functionality only, so a listing that reads as a
marketplace with SMS added can be refused. Lead the description with messaging. Business sync lets a
business send through the user's SIM and lets users share a message to a server. State that it is
off by default and turned on by the user. If Play cites this feature, decide whether to remove
it from the Play build.

**Also required:** Data Safety (must match the privacy policy; declare SMS, contacts, location, photos),
privacy policy URL, account deletion URL `https://grogoni.com/account-deletion`, ads, content rating,
target audience. Marketplace chat and the assistant may also need the user-generated content and AI
declarations.

## 6. Store listing

- Short and full description, category, contact email, countries.
- Icon: `apps/android/play-listing/icon-512.png`.
- Feature graphic, 1024 x 500. None exists in the repo yet.
- At least 2 phone screenshots, including the messenger. Take them from the capture-enabled debug
  build. The website cannot show SMS, and its menu has an APK download link that must not appear in
  a Play listing.

## 7. Release

Personal developer accounts created after November 13, 2023 must run a closed test with 12 or more
testers for 14 days before production. Check the current figures in Console. Organization accounts
skip this. Then promote the release under **Test and release > Production** and send it for review.
The pre-launch report's screenshots will be black, for the same `FLAG_SECURE` reason.

## Reading a rejection

- **Error at upload:** Console shows it beside the bundle. Run `pnpm android:play:verify`, which
  covers target API, icon, debug and test-only builds, signing, and version code.
- **Rejected in review:** the email or **Policy status** page names the policy. Compare it with
  sections 1 and 5, fix it, raise `versionCode`, and upload again.
