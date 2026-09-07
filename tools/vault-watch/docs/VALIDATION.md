# Validation

## Evidence boundary

This is a preview release. The following evidence distinguishes notification transport, reconciliation logic, and actual Obsidian UI behavior.

| Layer | Result |
| --- | --- |
| Windows .NET native notification on a TrueNAS SMB share | Earlier scoped diagnostic passed exact create/update/delete events for three temporary files; all probes cleaned up |
| Obsidian 1.13.7 internal adapter | Method bodies and plugin directory format inspected read-only in the running application |
| Native helper on local Windows filesystem | Automated real-process tests cover changes, renames, burst, loss/reconnect and exit |
| JavaScript reconciliation | Automated tests cover ordering, directory descendants, offline cancellation, failed traversal and path boundaries |
| Full helper → bridge → engine chain | Automated test uses real PowerShell and a disk-backed simulated index in a temporary local vault |
| Plugin installed in an actual Obsidian vault | **Not yet verified** |
| Actual open-note and file-explorer UI refresh | **Not yet verified** |
| NAS-side or Linux/NFS-side writes | **Not yet verified** |

Initial local validation (2026-09-08): Windows, Node.js 26.6.0, system Windows PowerShell 5.1. `npm run check` passed all **39 tests**, with no failures or skips, and built the plugin successfully. Tests do not require the user's vault, NAS address, credentials, or note contents. No production installation is performed by build or test scripts.

## Automated checks

Run `npm test` on Windows. The tests use Node's built-in runner and clean up their own scoped temporary directories and helper processes. Non-Windows runs skip native-process integration tests.

- Real file and folder create, modification, rename, nested rename, and deletion; Unicode and shell-special filename characters.
- A burst of 800 creates must either deliver all creates or explicitly report overflow requiring reconciliation; subsequent events must still arrive.
- Root disappearance must report offline without fabricating file deletions; restoration must reattach and request a rescan.
- Closing stdin or ending the designated parent must release the helper.
- Fragmented JSON, heartbeat separation, process restart, invalid-output diagnostics, and unload during startup.
- Parent-first creation, child-first removal, case-only rename preservation and duplicate event coalescing.
- Failed or changing enumeration, failed stat, disconnect and obsolete host-queue callbacks.
- Ignored hidden directories, rejected path traversal and excluded junction/symlink subtrees.
- Real helper → bridge → engine processing of startup state, edits, file/folder renames and deletes; no further index updates after stop.
- The actual plugin entry point with a simulated host: event routing, live settings, plugin-directory resolution, pause/unload cancellation, and incompatible adapter rejection.

`npm run build` checks manifest/package version equality and bundles the actual entry point. `npm run package` includes `main.js`, `manifest.json`, `native/watch.ps1`, README, license, changelog and documentation in the installable ZIP.

## Manual acceptance before production use

Use an independent test vault with the same storage path style as the intended vault. Keep a copy of any existing plugin directory before upgrades.

1. Install and enable the plugin. Confirm status progresses to watching.
2. Open a disposable Markdown note in Obsidian. Change its text using the actual external editing tool; verify the visible text and metadata update without reopening the vault.
3. Externally create a note and nested folder, rename the file and parent folder, and remove only those disposable test entries. Verify Obsidian's file explorer matches the disk after each step.
4. Exercise the AI's actual write path. A Windows SMB write and a NAS-local/Linux write can have different notification behavior.
5. Pause the plugin, confirm its helper exits, then re-enable it and verify changes made while paused are reconciled.
6. With only the test vault in use, simulate connection loss. Confirm the UI reports waiting, existing index entries are retained, and restoration triggers reconciliation.
7. Close the test vault and confirm its helper exits. Repeat in each supported Obsidian version after upgrades.

Do not infer actual UI acceptance from a passing simulated-index test. Any future manual test result should record the Obsidian version, path style, external write origin, exact actions, and observed UI behavior without committing private paths or note content.
