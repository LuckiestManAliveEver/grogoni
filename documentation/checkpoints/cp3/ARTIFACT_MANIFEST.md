# CP3 Artifact Manifest

Status: passed
Date opened: 2026-07-02
Date passed: 2026-07-02

## Created CP3 Artifacts

| Path                                                 | Purpose                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `documentation/checkpoints/cp3/CP3_BASELINE.md`      | Formal CP3 baseline, scope, exit criteria, and rollback instructions. |
| `documentation/checkpoints/cp3/DECISION_LOG.md`      | Mobile shell, chat shell, quick action, and placeholder decisions.    |
| `documentation/checkpoints/cp3/ARTIFACT_MANIFEST.md` | This manifest.                                                        |

## Implemented CP3 Artifacts

| Path                                   | Purpose                                                        |
| -------------------------------------- | -------------------------------------------------------------- |
| `apps/web/public/manifest.webmanifest` | PWA install metadata.                                          |
| `apps/web/public/icons/grogoni-icon.svg`  | Lightweight app icon for install metadata and browser tab.     |
| `apps/web/index.html`                  | Links PWA manifest and app icon.                               |
| `apps/web/src/cp3-shell.ts`            | CP3 quick action, empty state, and chat placeholder contract.  |
| `apps/web/src/main.tsx`                | Authenticated mobile shell, home, chat, and placeholder views. |
| `apps/web/src/styles.css`              | Mobile-first shell styling.                                    |
| `tests/cp3-shell.test.ts`              | Focused CP3 shell behavior tests.                              |

## CP3 Opening Checklist

- [x] CP2 accepted as passed.
- [x] CP2 checkpoint tag exists locally.
- [x] CP2 commit is pushed to `origin/main`.
- [x] CP3 marked `active` in checkpoint log.
- [x] CP3 baseline created.
- [x] CP3 decision log created.
- [x] CP3 scope excludes parser execution, local model integration, business CRUD, payments, marketplace, and TIEL.

## CP3 Completion Checklist

- [x] PWA manifest implemented.
- [x] Authenticated mobile shell implemented.
- [x] Home surface implemented.
- [x] Chat shell implemented.
- [x] Quick actions grid implemented.
- [x] Offline status indicator implemented.
- [x] Sync status placeholder implemented.
- [x] Commerce empty states implemented.
- [x] Small Android viewport layout checked.
- [x] CP3 tests added or existing tests updated.
- [x] Existing CP1 and CP2 checks pass.
- [x] `checkpoint/cp3-mobile-chat-shell` tag created.

## Verification

- `pnpm run ci`
- `pnpm build`
- mobile viewport check for small Android dimensions
