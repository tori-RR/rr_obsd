# Legacy plugin sources

The repository now maintains one integrated plugin under `src/`. Earlier standalone copies are retained in Git history, rather than as a second editable source tree. No standalone utility scripts were found alongside those copies during consolidation.

## Provenance

All three snapshots were imported by commit [`2ea4f749f6292087c218e101a3accfa2ea53f32f`](https://github.com/tori-RR/rr_obsd/commit/2ea4f749f6292087c218e101a3accfa2ea53f32f). The last inspected baseline containing the complete snapshots was [`ae76100cc9aa3227be2c8831e69370033306d1c3`](https://github.com/tori-RR/rr_obsd/commit/ae76100cc9aa3227be2c8831e69370033306d1c3).

| Snapshot path at that commit | Recorded version | Current implementation |
| --- | --- | --- |
| `tools/table-row-number/` | Manifest 1.0.0; imported README identifies the delivered behavior as v1.10 | `src/modules/table-row-number.js` |
| `tools/floating-new-note/` | 1.3.0 | `src/modules/floating-new-note.js`; shared root `styles.css` |
| `tools/vault-watch/` | 0.1.0 preview | `src/modules/vault-watch.js`, `src/vault-watch/`, `native/` |

The importing commit describes the earlier source workspace as `obsidian_plugin_draft`. Vault Watch also originated in [tori-RR/obsidian-vault-watch](https://github.com/tori-RR/obsidian-vault-watch). These are origin references, not a claim that another repository remains actively maintained or matches the current integrated implementation.

## Inspect or export a snapshot

From a checkout containing the repository history, inspect a specific historical file without changing the working tree:

```powershell
git show ae76100cc9aa3227be2c8831e69370033306d1c3:tools/vault-watch/README.md
git show ae76100cc9aa3227be2c8831e69370033306d1c3:tools/table-row-number/main.js
```

To preserve all three old directories as a separate archive, choose a new output filename and run:

```powershell
git archive --format=zip --output=legacy-plugins-ae76100.zip ae76100cc9aa3227be2c8831e69370033306d1c3 tools/table-row-number tools/floating-new-note tools/vault-watch
```

The archive includes the old standalone manifests, build scripts, tests and documentation. It does not contain subsequent fixes from the integrated plugin. Inspect it outside the current source tree; changes to current behavior belong under `src/` and the root `tests/`.

## Material retained in current documentation

- Useful standalone development constraints were consolidated into root [AGENTS.md](../AGENTS.md), including lifecycle ownership, queue guards, path safety and scoped tests.
- Installation, operation and rollback guidance was updated in [VAULT-WATCH.md](VAULT-WATCH.md) and the root README.
- The old architecture and validation files were byte-identical to the root copies at the inspected baseline. Historical validation remains dated in [VALIDATION.md](VALIDATION.md).
- The root native-process tests already include the later timeout adjustments. The integrated lifecycle harness supersedes the standalone entrypoint harness.
- Floating New Note's old stylesheet differs from the root stylesheet only in its title comment. Module implementations, shared settings and current styles remain authoritative.

The historical Table Row Number manifest/version mismatch is preserved as recorded; it is not retroactively rewritten. Current release versions come from the root package and manifest.
