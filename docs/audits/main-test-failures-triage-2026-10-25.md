# Triage: `main` test failures — legacy vs. live

**Question asked:** of the code behind the 12 failing test files / 47 failing tests on `main`, is any of it legacy code or connected to discontinued services, and can it be discarded?

**Answer: no.** Every failing test exercises **live, shipped** code reachable from the web app entry point (`apps/web/src/main.tsx` → `GrogoniApplication.tsx`). None is legacy, orphaned, or tied to a discontinued service. Discarding them would remove real behavioural coverage and, in one case (`user-purge-script`), hide a genuine live data-safety bug.

## Reachability check

The web entry chain is `main.tsx` → `GrogoniApplication.tsx`. `GrogoniApplication.tsx` is the single importer of `useChatRuntimeState` and `useChatInboxState`, which in turn pull in the rest of the failing-test surface. All exercised modules are imported by live (non-test) source:

| Module | Imported by (live `.ts/.tsx`) | Status |
| --- | --- | --- |
| `api-helpers` | 76 files | live |
| `chat-message-plumbing` | 47 files | live |
| `daemon-chat` | 5 files | live |
| `chat-device-only-messages` | 4 files | live |
| `messaging/outbox` | 4 files | live |
| `marketplace-search-reply` | 3 files | live |
| `useChatComposerState` | 2 files | live |
| `guest-reply-pending` | 2 files | live |
| `chat-assistant-intents` | 2 files | live |
| `useChatRuntimeState` / `useChatInboxState` | `GrogoniApplication.tsx` | live |
| `guest-intent-client` / `GuestTypingIndicator` | live hook path | live |

No `discontinued` / `decommission` / `sunset` markers exist in web source. The only "legacy" reference is `legacyMessagingOutboxStorageKey` in `messaging/outbox.ts`, which is an active **migration** (read old key, discard, write new) — not discontinued.

## The 12 failing test files

Each is an established, maintained test (creation dates span 2026-08-30 to 2026-10-25), and none duplicates a passing sibling (verified by `describe()` headings — e.g. "automatic outbox resend" vs "messaging outbox"; "queued end-to-end encrypted message" vs "human direct-message encryption").

| Test file | Exercises (live) | Category | Discard? |
| --- | --- | --- | --- |
| `guest-intent-client.test.tsx` | guest classifier (model + rules fallback) | live feature | **No** — test-isolation bug (see below), code is live |
| `guest-chat-routing.test.tsx` | guest chat routing via `useChatRuntimeState` | live feature | No |
| `outbox-auto-retry.test.tsx` | messaging outbox auto-retry | live feature | No |
| `outbox-resend-routing.test.tsx` | outbox resend routing + `lib/api` | live feature | No |
| `fresh-shop-hosted-first-chat.test.tsx` | first-message flow, runtime handoff | live feature | No |
| `chat-assistant-journeys.test.tsx` | assistant journeys, daemon chat | live feature | No |
| `chat-inbox-recovery.test.tsx` | inbox recovery, `useChatInboxState` | live feature | No |
| `composer-send-clears-draft.test.tsx` | composer send semantics | live feature | No |
| `e2ee-queued-copy-not-stored.test.tsx` | encrypted queued copy in `chat-message-plumbing` | live feature | No |
| `session-context-refresh.test.tsx` | session refresh vs restore | live feature | No |
| `agent-turn-async-chat.test.tsx` | async agent turns | live feature | No |
| `user-purge-script.test.ts` | purge script vs `postgres-store.ts` table list | live data-safety guard | **No — real bug** |

## The one item that is a genuine live bug, not a test problem

`user-purge-script.test.ts` fails with:

```
cp2_agent_skills must be classified: expected undefined to be 'DELETE'
```

`services/api/src/cp2/postgres-store.ts` declares a normalized `cp2_agent_skills` collection, but `scripts/purge-all-users.sql` does **not** classify it. Result: an account purge would **silently leave that user's agent-skills rows behind**. Agent Skills is current functionality (shipped in #58). This is a live data-left-behind / privacy bug — it must be **fixed** (add the `DELETE` row), never discarded.

## Failure signatures (observed, `origin/main` @ e9bd5eac)

Each file collected by running it in isolation on pristine `main`:

| File | Failure signature | Bucket |
| --- | --- | --- |
| `outbox-auto-retry.test.tsx` | `viewport.addEventListener is not a function` | A — jsdom `matchMedia` |
| `outbox-resend-routing.test.tsx` | `viewport.addEventListener is not a function` | A — jsdom `matchMedia` |
| `chat-inbox-recovery.test.tsx` | `viewport.addEventListener` + `expected [] to deeply equal [ObjectContaining{…}]` | A — jsdom `matchMedia` |
| `chat-assistant-journeys.test.tsx` | `viewport`/spy assertions (`"spy" to not be called`) | A/B — mixed |
| `guest-intent-client.test.tsx` | in-sequence `fallback: "timeout"` vs `"error"`; passes 1-by-1 | B — fake-timer isolation |
| `fresh-shop-hosted-first-chat.test.tsx` | `Cannot read properties of undefined (reading 'helpTopic')` | C — behaviour drift |
| `guest-chat-routing.test.tsx` | `expected [] to deeply equal ['hello there'…]` (empty replies) | C — behaviour drift |
| `composer-send-clears-draft.test.tsx` | `expected "spy" to be called with ['sugar']` | C — behaviour drift |
| `agent-turn-async-chat.test.tsx` | `expected [] to include 'agent-reply-1'` | C — behaviour drift |
| `session-context-refresh.test.tsx` | URL `/marketplace/conversations/…` vs `/workspace/conversations/…` | C — behaviour drift |
| `e2ee-queued-copy-not-stored.test.tsx` | storage contains plaintext `'meet me at the shop at six'` | C — behaviour drift (privacy) |
| `user-purge-script.test.ts` | `cp2_agent_skills must be classified` + count 204→205 | **fixed (PR #63)** |

Root-cause buckets:

- **A — jsdom lacks `matchMedia`.** `useChatInboxState`/`useCompactViewport` call `window.matchMedia(...)`; jsdom does not implement it, so `viewport.addEventListener` throws. App code is correct in real browsers. Fix: one shared `tests/setup.ts` shim via `vitest.config` `setupFiles`.
- **B — fake-timer isolation.** A test calling `vi.useFakeTimers()` leaves shared state that turns the next `classifyGuestMessage` into a spurious timeout. Proven: passes 1-by-1, fails in sequence, still fails under `singleFork`. Fix: per-file timer hygiene (restore timers + settle pending work inside the hanging test).
- **C — behaviour drift from the integration merge.** Real assertions about reply placement, spy calls, routes, and (critically) **plaintext E2EE copy appearing in storage**. These need per-case investigation: either the merge changed intended behaviour (update test) or introduced a regression (fix code). **The `e2ee` one is privacy-sensitive and must be treated as a likely real regression until proven otherwise.**

## Remediation plan (phased)

Ordered by risk and independence; each phase is its own PR off `main`.

### Phase 0 — live data bug (done)
- **Fix `cp2_agent_skills` purge classification.** PR #63. Standalone, verified, no dependency on the rest.

### Phase 1 — test-environment foundation (low risk, unblocks A)
- Add `apps/web/test/setup.ts` (or `tests/setup.ts`) installing a `window.matchMedia` stub + `ResizeObserver` no-op, wired via `vitest.config` `test.setupFiles`.
- Goal: clear `outbox-*`, `chat-inbox-recovery`, and the matchMedia part of `chat-assistant-journeys`.
- Verify by re-running those files; must not perturb currently-green files.

### Phase 2 — fake-timer isolation (low risk, unblocks B)
- In `guest-intent-client.test.tsx`, make the "hang at budget" test restore real timers and settle its pending promise within the test (or extend `afterEach` to `vi.clearAllTimers()` **and** confirm the fix with a before/after run).
- Goal: 21/21 in that file; confirm `classifyGuestMessage` cases pass after the hang case.

### Phase 3 — behaviour drift, privacy first (medium risk)
- **`e2ee-queued-copy-not-stored`** first: determine whether plaintext is genuinely persisted (regression → fix `chat-message-plumbing`) or the test's storage stub changed (test fix). Treat as a real privacy regression until disproven.
- Then `session-context-refresh` (route mismatch) and `agent-turn-async-chat` (reply placement) — compare merge diffs of the relevant code.

### Phase 4 — remaining behaviour drift (medium risk)
- `fresh-shop-hosted-first-chat` (`helpTopic` undefined), `guest-chat-routing` (empty replies), `composer-send-clears-draft` (send spy), and the behavioural part of `chat-assistant-journeys`.
- Each: bisect the merge (`5a7877c7`…`dc167f8f`) for the owning module, decide intended vs. regression, fix accordingly.

### Phase 5 — close-out
- Add the `tests/setup.ts` note to test guidelines; re-run full `pnpm ci`; merge the earlier stragglers (#59 share-links, #60/#61/#62 CI restoration) once green.

## Conclusion / recommendation

- **Nothing here is safe to discard.** All 12 tests target live, entry-point-reachable code; several are recent features (guest classifier, async agent turns, Agent Skills).
- **One is a real product bug** (`cp2_agent_skills` missing from the purge script) — fixed in PR #63.
- **Bucket A/B are test-infrastructure** (jsdom shim, timer isolation) — low risk, do first.
- **Bucket C is behaviour drift** — investigate per case, **privacy (`e2ee`) first**; fix code where the merge regressed behaviour rather than loosening tests.
