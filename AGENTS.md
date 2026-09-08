# Development notes

- Maintain one implementation under `src/`: module integration in `src/modules/` and watcher support in `src/vault-watch/`. Historical standalone plugins are documented in `docs/LEGACY-PLUGINS.md`; do not restore a parallel editable plugin tree.
- Keep runtime code in plain JavaScript. TypeScript and native npm binaries are not needed for the current design.
- Keep routine refresh driven by events. The active-Markdown fallback may inspect only that note; the full-vault safety scan must remain infrequent and completion-scheduled. Coalesce scans to one in flight and one follow-up, preserving forced manual/recovery requests.
- Update the Obsidian index through its adapter queue. Check lifecycle/epoch validity inside queued callbacks, not only when enqueueing.
- Never force editor content with `editor.setValue` to resolve external changes. Revalidate file/view/editor identity, saved-content baseline, dirty/saving state, edit version and lifecycle after asynchronous reads. Preserve local input when safe refresh cannot be established.
- Treat missing host safety signals or incompatible internal methods conservatively. Do not assume that method presence guarantees compatibility with a new Obsidian version.
- Network and permission errors are not evidence of file deletion. Do not apply a partial failed inventory as current disk state. Preserve path validation and junction/symlink boundaries.
- `native/watch.ps1` must fit the encoded Windows command-line limit and must not write vault contents. Keep it in the installable package and document complete-directory installation.
- Keep helper processes, timers, handlers, observers and buttons owned by their module lifecycle. Stop/unload must prevent retries or detached UI from reactivating work; remove only resources the module owns.
- Test in unique temporary vaults or explicitly authorized scratch directories, and validate the resolved path before cleanup. Existing authorization for a named test location remains valid; it does not extend to unrelated notes or NAS configuration.
- Do not commit private vault paths, note contents, credentials, plugin data, logs or generated binaries. Do not deploy to personal vaults or change NAS configuration without task authorization.
- Run `npm run check` and verify the complete package for runtime or packaging changes. Use Windows for actual helper-process tests. Validate affected UI behavior separately from simulated-host tests.
- Keep `docs/VALIDATION.md` truthful about the exact revision, uncommitted changes, test results, package contents and outstanding UI acceptance. Preserve the dates and limits of historical evidence.
