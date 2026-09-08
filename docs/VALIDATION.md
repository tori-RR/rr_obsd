# Validation

## Current revision: 0.3.0

Validated on 2026-09-08 using Windows, Node.js 26.6.0, Windows PowerShell 5.1, and Obsidian app/installer 1.13.7. The source was base commit `ae76100cc9aa3227be2c8831e69370033306d1c3` plus the uncommitted 0.3.0 repair; the base commit alone does not identify this build.

| Check | Result |
| --- | --- |
| `npm run check`: syntax, tests and build | Passed: **91 tests, 0 failures, 0 skips**; build succeeded |
| `npm run package`: complete archive inventory | Passed; SHA-256 is printed by the command for the generated archive |
| Complete installation includes `native/watch.ps1` | Passed; installed plugin 0.3.0, matching built `main.js`, helper running |
| Clean open note receives external changes without reopening | Passed in the actual focused editor and rendered CodeMirror DOM |
| Typing during a pending read retains local input | Passed in the actual editor; dirty/saving/IME and split-view cases also covered by automated tests |
| File switch, pause, restart and unload cancel stale refresh work | Passed in the actual editor; helper released on pause/unload and restarted successfully |
| File/folder create, rename and delete reach the index/file explorer | Passed for file creation and directory creation/rename/deletion in the actual UI; file rename covered by automated tests |
| Active-note fallback with a missing native content event | Passed with this plugin's notifications suppressed for the test note; confirmed the fallback applied the refresh |
| NAS-side or Linux/NFS-side writes | **Not yet verified for this revision** |
| Floating New Note destination and ownership | Actual button created beside the active test note; root destination, ownership and unload cleanup passed automated tests |

Build identity and packaging:

- Built `main.js` SHA-256: `1b3f3cb4d91d5fe2d2056bbf9660b64736bb06b4bf9bef96ef28ec4aca7285bf`.
- Archive: `dist/rr_obsd-0.3.0.zip`. Its `rr_obsd/` directory contains `main.js`, `manifest.json`, `styles.css`, `versions.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, `native/watch.ps1`, and all four documents in `docs/`.
- The archive hash is recorded by the packaging command outside the archive to avoid a self-referential checksum. Repackaging may change ZIP metadata and its hash without changing runtime code.

The opt-in `scripts/obsidian-live-acceptance.cjs` completed **9/9 checks** against an actual Obsidian session and TrueNAS SMB vault, from 03:58:11 to 03:58:27 UTC. All writes used the Windows SMB client and a unique child of the user's authorized scratch directory. The script checked real view objects, rendered editor content and file-explorer entries, and exercised typing/file-switch/pause/unload races with controlled pending reads. The missing-event check suppressed this plugin's events for one disposable note and used a shorter in-memory fallback interval; it validates the fallback path, not a fixed production latency guarantee.

Each UI check took between 54 ms and 5.85 s, including deliberate waits and multiple actions. These are check durations, not measured notification latencies. The native creation check took 466 ms and the focused-editor check took 1.63 s including a 1.5 s integrity wait.

The scratch directory and its index entries were removed. The script restored the original tab and in-memory settings, and the installed `data.json` matched the pre-repair backup byte for byte. A rollback copy of the installed plugin and a Git bundle of the previous source were retained outside the repository.

Limitations: actual root-level creation and IME composition were not exercised in the personal vault; their guards have automated coverage. No production NAS disconnection, NAS-local/Linux/NFS write, or simultaneous multi-client save/merge experiment was performed. Preserving input during refresh does not replace Obsidian's ordinary save/conflict behavior or provide conflict merging.

## Historical evidence

The following was carried forward from standalone Vault Watch 0.1.0's validation record. It provides provenance, not acceptance of the current implementation:

- On 2026-09-08, a scoped Windows .NET diagnostic on a TrueNAS SMB share reported create/update/delete events for three temporary files and recorded cleanup.
- Obsidian 1.13.7 adapter method bodies and plugin-directory resolution were inspected in the running application.
- The initial local Windows validation used Node.js 26.6.0 and system Windows PowerShell 5.1. Its `npm run check` recorded **39 passing tests**, no failures or skips, and a successful build.
- That record explicitly left installed-plugin UI acceptance and NAS-local/Linux/NFS write behavior unverified.

The original document is recoverable from the commits in [LEGACY-PLUGINS.md](LEGACY-PLUGINS.md). Do not combine an earlier native-notification probe, a simulated editor and a current build into a claim of end-to-end UI verification.

## Automated verification

Run `npm run check` and `npm run package` from the repository root. Tests use Node's built-in runner and unique temporary directories. Windows runs exercise the real PowerShell helper; other platforms skip those process tests. Syntax checking includes the opt-in UI acceptance script, but the ordinary test/build commands do not run it or modify a personal vault.

The final test review should cover:

- Real file and folder events, Unicode filenames, nested renames, burst/overflow, disconnect/reconnect and helper exit.
- Native bridge protocol framing, retry cancellation and invalid-output handling.
- Reconciliation ordering, rejected paths, incomplete scans, inaccessible roots and obsolete queued callbacks.
- Full-scan coalescing, metadata-only periodic updates and forced recovery/manual scans.
- Clean editor refresh, dirty/saving refusal, unknown baselines, typing during a read, file/editor identity changes and lifecycle invalidation.
- Per-file event coalescing, the active-note-only fallback and timers that stop with the module.
- Root-directory note creation, fallback destinations and cleanup of only the module's own UI resources.

Simulated-host tests verify the scheduling and safety contracts they model. Real-process tests with a disk-backed mock index verify transport and reconciliation. Neither proves the actual Obsidian editor's internal API behavior.

The installable ZIP must contain `main.js`, `manifest.json`, `styles.css` and `native/watch.ps1`, along with the release documentation and metadata. Build/test scripts do not perform production deployment.

## Scoped UI acceptance

Use an independent vault or a unique disposable directory within a location explicitly authorized by the user. Save a rollback copy of the installed plugin before replacing it. Existing authorization for one scratch location does not extend testing to unrelated notes or NAS configuration.

The optional UI script exports `start(app, { expectedVaultRoot, scratchParent, allowWrites: true })` and `status()`. Load it through Obsidian's developer environment, supplying the exact active vault root and an existing authorized parent relative to that root. It creates its own unique child, temporarily pauses/reloads this plugin, restores settings and the original tab, and removes only that child after validating its resolved path. It is intentionally excluded from ordinary automated tests and the installable runtime.

1. Install the complete plugin and confirm the helper starts. Record the exact app/installer version and plugin revision.
2. Open a disposable Markdown note, edit it externally through the actual AI/tool write path, and verify visible text without switching notes or reopening the vault.
3. With unsaved local input, repeat an external change. Confirm the refresh preserves the input and reports the conflict. Also type or switch files while an asynchronous read is pending.
4. Modify two open notes in quick succession. Verify per-file scheduling, then test the active-note fallback independently of native update delivery.
5. Create a file and nested folder, rename the file and parent, and delete only those disposable entries. Compare the visible tree with disk.
6. Observe a periodic scan and a forced manual scan. Record elapsed time without asserting an unconditional 5-second or 180-second delivery bound.
7. Pause, restart and unload the module during pending work. Check helper/timer cleanup and absence of stale editor updates.
8. Check root-level Floating New Note creation and independent module toggles. Ensure another module's or plugin's buttons remain intact.
9. Remove only the unique test directory after confirming its absolute path and contents. Record cleanup and any files retained for review.

Network-loss testing must be scoped to the test fixture or separately authorized; do not disconnect shared production services just to complete the checklist. SMB-client and NAS-local/Linux writes can have different notification behavior, so record the origin actually tested.
