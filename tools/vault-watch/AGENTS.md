# Development notes

- Keep runtime code in plain JavaScript. TypeScript and native npm binaries are not needed.
- Preserve the event-driven design; full scans need an explicit recovery or manual reason.
- `native/watch.ps1` must fit the encoded Windows command-line limit and must not write vault contents.
- Reconciliation may update the Obsidian index only through its adapter queue. Check lifecycle/epoch validity inside the queued callback.
- Network/permission errors must not become evidence of file deletion. Do not use a partial failed scan as the current inventory.
- Keep helpers owned by the plugin lifecycle. Stop/unload must prevent retries from resurrecting them.
- Test in unique temporary vaults and scope cleanup to those exact paths. Do not test against personal notes by default.
- Keep private vault paths, note contents, credentials, plugin data and generated binaries out of Git. Update release validation honestly; simulated-index tests are not actual UI acceptance.
- Run `npm test` and `npm run build` for behavior changes; use Windows for the actual helper tests.
