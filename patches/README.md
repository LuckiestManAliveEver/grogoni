# Dependency modifications

`libsignal@6.0.0.patch` was created by Grogoni on November 7, 2026. It removes
direct console diagnostics from the GPL-3.0 libsignal dependency because those
diagnostics expose session keys and other protocol internals. Cryptographic and
session-state behavior is unchanged. The modified source remains GPL-3.0; see
`docs/licenses/libsignal-GPL-3.0.txt` and `THIRD_PARTY_NOTICES.md`.

The patch is pinned in the workspace's pnpm patchedDependencies and lockfile.
Always install with the committed lockfile. Do not remove the patch or ship an
unpatched connector. The installed-library regression test exercises session
closing, reopening and pruning with secret canaries while checking console output.
