# Direct Android installation and app links

## Gap report

The repository already contains the two building blocks needed for direct installation:

- The web app ships a PWA manifest and service worker in [apps/web/public/manifest.webmanifest](../apps/web/public/manifest.webmanifest) and [apps/web/public/sw.js](../apps/web/public/sw.js).
- The Android project already exists at [apps/android](../apps/android) and is configured with a secure package id, SDK targets, and release-signing support in [apps/android/app/build.gradle.kts](../apps/android/app/build.gradle.kts).

The missing pieces are the user-facing install route, the Android App Links file, and the direct-download release flow tied to a tested signing identity:

1. There is no dedicated `/install` route in the web router.
2. The repo does not publish a `.well-known/assetlinks.json` file for `market.grogoni.app`.
3. The release pipeline documents APK generation but not a reproducible, tested, signed distribution flow for the public website.
4. The production signing certificate fingerprint is not yet recorded because the real release key has not been created and approved.

## Implementation plan

1. Add a route and mobile-first page that explains the PWA and APK installation options and listens for `beforeinstallprompt` without forcing install.
2. Keep the existing web App Shell and service worker intact while ensuring the `/install` page remains outside of the high-risk auth flow.
3. Generate a template Android App Links document that follows the Android required structure and is regenerated from the production keystore before public release.
4. Add a script to generate the asset links file from the real release certificate and add a release build command that fails when release signing metadata is missing.
5. Document the compliance boundary clearly: the repo can produce a signed APK and a PWA install route, but the production package identity and certificate must be verified before it is claimed as production-published or Play-ready.

## Current verification boundary

This repository is not allowed to claim Play verification or a production app-signing certificate until the Google account, developer identity, and release key are created and approved by the responsible owner. The app link and release script are prepared for that step, but they remain pending the actual production certificate and app registration.
