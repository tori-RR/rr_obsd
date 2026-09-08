# Architecture

## Source ownership

| File | Responsibility |
| --- | --- |
| `src/main.js` | Plugin lifecycle, shared settings, legacy settings migration and module composition |
| `src/modules/table-row-number.js` | Table numbering, styles and module-owned UI resources |
| `src/modules/floating-new-note.js` | New-note button, destination resolution and module-owned UI resources |
| `src/modules/vault-watch.js` | Watcher lifecycle, commands, status and refresh scheduling |
| `src/vault-watch/native-bridge.js` | Hidden child process, bounded JSON stream, heartbeat and retry |
| `src/vault-watch/reconciler.js` | Read-only enumeration, path validation and serial reconciliation plans |
| `src/vault-watch/obsidian-adapter.js` | Guarded entry into Obsidian's adapter queue |
| `src/vault-watch/editor-refresh.js` | Guarded refresh of open Markdown views |
| `native/watch.ps1` | .NET FileSystemWatcher, bounded event queue and native handle ownership |

`src/` is the only maintained implementation. Earlier standalone plugins are recoverable from Git as described in [LEGACY-PLUGINS.md](LEGACY-PLUGINS.md). The JavaScript is bundled into `main.js`; Obsidian and Node built-ins remain external. The helper remains a separate file in the ZIP. No runtime package manager or downloaded native executable is required.

## Module lifecycle

Each module owns its UI resources. Disabling a feature stops its visible behavior; Vault Watch also releases its helper and timers, while some UI modules retain guarded host listeners or observers until the whole plugin unloads. Unload releases owned resources and must not remove another module's elements or leave a detached button capable of acting. Settings changes persist through the shared plugin host.

Floating New Note resolves an active note's root parent as the vault root, without manufacturing an absolute path. When there is no active note, it uses the configured fallback directory. The fixed-directory mode follows the same root-path rules.

## Notification transport

The parent passes the absolute vault path and its PID as environment data, never as interpolated PowerShell source. System Windows PowerShell receives an encoded copy of the fixed helper. It runs hidden, without a shell wrapper or user profile.

The protocol is UTF-8 newline-delimited JSON:

```json
{"type":"ready"}
{"type":"change","kind":"update","path":"folder/note.md"}
{"type":"change","kind":"rename","path":"new.md","oldPath":"old.md"}
{"type":"offline","reason":"IOException"}
{"type":"rescan","reason":"reconnected"}
{"type":"rescan","reason":"overflow"}
{"type":"heartbeat"}
```

Change kinds are `create`, `update`, `delete` and `rename`. `ready` follows successful attachment and occurs once per helper process. Reattachment emits `rescan/reconnected`. Starting reconciliation after attachment allows incoming events to be retained during the initial scan.

The helper uses a 16 KiB notification buffer and an event queue capped at 2,048. Buffer loss or queue overflow requests reconciliation. Heartbeats occur every two seconds, and a root-access probe occurs every five seconds. Attachment retries back off from one to thirty seconds. These probes do not enumerate the vault.

The bridge limits pending output to 1 MiB, checks liveness every five seconds and terminates its own helper after thirty seconds without a protocol message. Exits and helper-source read failures receive bounded-backoff retries. Pausing closes stdin; after a two-second grace period the bridge terminates only its own child. Helper threads observe stdin EOF and the original parent process handle, including when a network operation is blocked.

## Index reconciliation

Paths retain their real filename case and are supplied separately in Obsidian's normalized form. The engine rejects absolute paths, traversal, Windows alternate streams, control characters and ambiguous trailing dots/spaces. It ignores dot-prefixed path components and excludes symlinks and junctions by checking ancestors with `lstat`.

File events are debounced into one work queue. Directory events include descendants because native notifications need not enumerate every child of a renamed directory. Startup, reconnect, overflow and manual requests force a complete reconciliation. A directory changing during enumeration can request a bounded retry.

The periodic safety scan defaults to **180 seconds after the previous scheduled scan finishes**. Its interval is configurable, and zero disables it. It enumerates the vault but applies only entries whose metadata changed, are absent, or are missing from the loaded index. This avoids repeatedly sending unchanged files through the host adapter. Metadata comparison is an optimization, not content hashing: a change that preserves compared metadata can require an event or a forced manual scan.

At most one full scan is in flight and one follow-up request is retained. Concurrent requests are coalesced; a forced manual/recovery request cannot be weakened into a metadata-only periodic request. A slow scan must not create an unbounded backlog.

A complete enumeration must succeed before its plan is applied. Missing entries are processed child-first and present entries parent-first. Root accessibility is checked before treating a path as absent. Permission errors, disconnects and partial traversal are not evidence of deletion. Disconnect, restart and unload invalidate the epoch, which is checked again inside each queued host operation.

The host integration uses `adapter.queue` and `adapter.reconcileFile` to update file inventory, metadata and views through Obsidian's normal pipeline. External renames are reconciled as disk state; they are not user-initiated Obsidian rename operations and do not promise internal-link rewriting.

## Open-note refresh

The index and the visible editor can become stale independently. Content-change events schedule refreshes per open file, so an event for one note does not discard another note's pending refresh. A separate check **defaults to 5 seconds and inspects only the current active Markdown note**. Its interval is configurable, and zero disables it. It does not enumerate the vault or periodically read every open note.

The editor refresh captures the view, file and editor identities, the saved-content baseline and an edit-version marker before asynchronous disk access. It checks dirty/saving state and available host baseline information, including `lastSavedData`, and verifies the identities, baseline, edit version and plugin lifecycle again before applying the result. A switch to another note, typing during the read, save in progress or lifecycle change invalidates that attempt.

For a view that is still safe to refresh, the plugin calls the host's `setData(fresh, false)` path. It does not force replacement with `editor.setValue`. If local input is dirty or its safety baseline cannot be established, it preserves the input and skips the refresh. It reports a conflict only when a known baseline allows it to confirm differing disk content. This is conflict avoidance, not a merge or a guarantee that other software cannot write the file.

These are internal host interfaces inspected for Obsidian 1.13.7. Method-presence checks cannot prove semantic compatibility with future versions. Actual UI acceptance remains separate from simulated-host tests; see [VALIDATION.md](VALIDATION.md).

## Data boundaries

The native protocol contains relative paths and status, not document text. Index reconciliation reads directory entries and metadata; the guarded editor refresher reads the affected note. Obsidian may read content while updating its index. Vault Watch does not directly write, move or delete source notes. Floating New Note creates a note only in response to the user's button action.

Settings use Obsidian's plugin data mechanism. Diagnostics use short error codes; raw helper stderr is discarded to avoid displaying private paths. The plugin does not alter NAS configuration, synchronization services, registry keys, PowerShell execution policy or network credentials.

Lifecycle checks cannot retract an operation already inside Obsidian, and this is not a filesystem transaction. A network failure can still race with host work. Validation must preserve this limitation rather than infer universal reliability from one successful run.
