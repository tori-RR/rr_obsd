# Architecture

## Modules

| File | Responsibility |
| --- | --- |
| `src/main.js` | Obsidian lifecycle, settings, commands, status and integration |
| `lib/native-bridge.js` | Hidden child process, bounded JSON stream, heartbeat and retry |
| `native/watch.ps1` | .NET FileSystemWatcher, bounded event queue, native handle ownership |
| `lib/reconciler.js` | Read-only enumeration, path validation, serial reconciliation plans |
| `lib/obsidian-adapter.js` | Guarded entry into Obsidian's own queue and real file reconciliation |

The JavaScript is bundled into `main.js` with Obsidian and Node built-ins left external. The helper remains a separate file in the installation ZIP. No runtime package manager or downloaded native executable is used.

## Notification protocol

The parent passes the absolute vault path and its PID as environment data, never as interpolated PowerShell source. The system PowerShell executable receives an encoded copy of the fixed helper script. It is hidden and launched without a shell or user profile.

UTF-8 newline-delimited JSON messages:

```json
{"type":"ready"}
{"type":"change","kind":"update","path":"folder/note.md"}
{"type":"change","kind":"rename","path":"new.md","oldPath":"old.md"}
{"type":"offline","reason":"IOException"}
{"type":"rescan","reason":"reconnected"}
{"type":"rescan","reason":"overflow"}
{"type":"heartbeat"}
```

Change kinds are `create`, `update`, `delete`, and `rename`. `ready` is sent after attachment, once per helper process. Later reattachment sends `rescan/reconnected`. The parent starts reconciliation only after attachment so changes arriving during the initial scan can be queued.

The native watcher uses a 16 KiB notification buffer and a queue capped at 2,048 events. A lost notification buffer or full event queue requests reconciliation instead of silently trusting a partial event list. Heartbeats occur every two seconds, and root accessibility is probed every five seconds. Attachment retries back off from one to thirty seconds. These probes do not walk the vault.

The bridge enforces a 1 MiB pending output limit, checks liveness every five seconds, and terminates its own helper after thirty seconds without a protocol message. Process exits trigger bounded-backoff restarts. Failure to read the helper source while the NAS is unavailable also retries automatically. Pausing closes stdin; after a two-second grace period the parent terminates only its own child. Separate helper threads observe stdin EOF and the original parent process handle, including when a network operation is blocked.

## Reconciliation

The engine retains real filename case and supplies Obsidian's normalized form separately. It rejects absolute paths, traversal, Windows alternate streams, control characters, and ambiguous trailing dots/spaces. It ignores dot-prefixed path components and checks ancestors with `lstat` to exclude junctions and symlinks.

Events are debounced and processed in one queue. A directory event includes its descendants because native notifications need not enumerate all children of a renamed directory. Full scans happen only for startup, reconnect, overflow, manual requests, or one bounded retry after a directory changes during enumeration.

A complete enumeration must succeed before its plan is applied. Missing paths are processed child-first and present paths parent-first. Before treating a path as absent, the engine verifies root access; permission and network errors are not converted into absence. Every queued operation carries an epoch. Disconnect, restart and unload invalidate it; the Obsidian queue checks it again immediately before reconciliation.

This prevents stale queued work from being knowingly applied after disconnect. It is not a filesystem transaction: an operation already inside Obsidian can race with a subsequent network failure. The plugin itself never writes or deletes vault documents.

## Obsidian integration

`adapter.queue(() => adapter.reconcileFile(realPath, normalizePath(realPath), true))` uses the real adapter pipeline so file objects, metadata and views can receive the usual host updates. Merely emitting a `vault.modify` event would leave the adapter's file inventory stale.

These are internal APIs inspected in Obsidian 1.13.7. The manifest sets that minimum version, and startup checks for required methods, but future host upgrades still need functional testing. External renames are reconciled as filesystem facts, not executed through Obsidian's user-initiated rename/link-rewrite operation.

## Data and configuration

The native protocol contains relative paths and status, not document contents. The engine reads file metadata and directory entries. Obsidian itself may read document contents while refreshing its index. Plugin settings are saved through the standard Obsidian plugin data mechanism. Diagnostics exposed by the plugin use short error codes; raw child stderr is discarded to avoid displaying private absolute paths.

No NAS configuration, sync service, registry key, execution policy, network listener or network credential is modified.
