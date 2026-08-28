# dsh-mv-session

English | [中文](README.zh.md)

[![GitHub tag](https://img.shields.io/github/v/tag/birdmanhj/dsh-mv-session)](https://github.com/birdmanhj/dsh-mv-session/tags)
[![npm](https://img.shields.io/npm/v/dsh-mv-session)](https://www.npmjs.com/package/dsh-mv-session)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0969da)](https://github.com/topics/dsh-plugin)

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin that migrates
sessions/workspaces to a new path and/or title — one tool call, one restart, one verify command.

```
install → ask the agent to "migrate workspace X to Y" → restart dsh web (the only restart)
        → delete transition symlinks → verify (read-only) → done
```

## Pain point

After renaming or moving a workspace directory, DSH does not migrate its sessions: old sessions
stay bound to the old path (tool cwd breaks with ENOENT), DSH auto-creates an empty workspace plus
empty sessions at the new path, and the four persisted layers (session header `cwd`, sessions
directory, workspace registry, projection cache) disagree. This plugin performs the whole migration
in one step, with backups, and tells you exactly which manual steps remain.

## Frame-safe by design

`session.jsonl.zstd` is a multi-frame Zstandard stream; at boot, DSH asserts that **frame 0
decompresses to exactly one header line** (`assertZstdHeaderFrame`). A whole-log
"decompress → edit → recompress" round-trip collapses everything into one frame and makes
`dsh web` crash at boot with *"first frame is not exactly one header line"* (hit in production on
2026-08-24). The bundled CLI rewrites **only frame 0**, leaves every other frame byte-identical,
repairs previously collapsed logs (one checksummed frame per line), and re-verifies the boot
invariant before atomically replacing the file.

## Install

```bash
dsh plugin --profile web add dsh-mv-session          # from npm
dsh plugin --profile web add /path/to/packages/dsh-mv-session   # from a checkout
# restart dsh web once to load the plugin
```

## Usage — plugin tool (recommended)

In any DSH session, just say: *"migrate workspace `/path/old` to `/path/new`, title New Name"*.
The agent runs `dry_run` first so you can review the plan, then executes for real.

Parameters: `from` / `session` (one of), `to` (required), `title`, `dry_run`, `mkdir`,
`merge_dir`, `backup_dir`, `cleanup_empty`, `verify` (read-only closing check).

## Usage — CLI

```bash
node migrate_session.cjs --from /old --to /new --title "New" --mkdir --dry-run  # 1 preview
node migrate_session.cjs --from /old --to /new --title "New" --mkdir --yes      # 2 migrate (auto-backup; no projcache writes)
# 3 STOP dsh web → node migrate_session.cjs --fix-projcache --from /new   # align cache in the stopped window (idempotent)
# 4 start dsh web → confirm in the GUI → open the largest session (no "signal timed out") → delete the transition symlinks
node migrate_session.cjs --verify --from /new                                   # 5 read-only check, done
```

## Why exactly one restart (and not two, not zero)

The migration edits **disk**, but the running dsh web holds a full **in-memory state** (session
header cwd, log append path map, workspace registry) that never re-reads disk before restart —
worse, it checkpoints its stale in-memory values back over `workspace.json` and the projection
cache. One restart rebuilds everything from disk. The transition symlinks exist only to keep the
old process alive during that window; once restarted, nothing references the old paths, so they
can be deleted safely.

A second restart is **not** required: the post-symlink confirmation is replaced by the read-only
`--verify` check (registry record ↔ session header cwd ↔ frame invariant ↔ directories ↔ cache).
Zero restarts is impossible today: DSH exposes no online "rehome" API — a process restart is the
only supported way to refresh the in-memory layer.

## Parameters

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `from` | string | one of | Current workspace path (may be a symlink) |
| `session` | string | one of | Session id; the workspace is located automatically |
| `to` | string | yes | Target workspace path |
| `title` | string | — | New title (default: basename of `to`) |
| `dry_run` | bool | — | Print the plan without changing anything |
| `mkdir` | bool | — | Allow creating the target directory |
| `merge_dir` | bool | — | Merge into an existing non-empty target (refused by default) |
| `backup_dir` | string | — | Backup location (default `<dsh-home>/migration-backups/`) |
| `cleanup_empty` | bool | — | Remove auto-created empty sessions at the target (default true) |
| `verify` | bool | — | Read-only consistency check that replaces the second restart |

## Safety & rollback

- Preflight validation before the first mutation: an unreadable log aborts with **nothing modified**.
- Same-directory guard, atomic tmp+rename writes, full backups before every run.
- Rollback = restore the backup directory + run the migration in reverse (new path → old path).

## Documentation

- [docs/user-manual.en.md](docs/user-manual.en.md) — full English manual: principles, flows, scenarios, FAQ
- [docs/user-manual.md](docs/user-manual.md) — 完整中文说明书
- [docs/publishing.md](docs/publishing.md) — npm/GitHub/marketplace publishing guide (中文)
- [docs/dsh-session-migration-internals.md](docs/dsh-session-migration-internals.md) — DSH internals (中文)

## Development

```bash
node --check lib/migrate_session.js
node tests/migrate_e2e_scratch.js --boot <real-session-log>   # frame invariant + real dsh web boot
node tests/migrate_edge_cases.js                              # merge/symlink/no-zstd/guards/preflight
```

The npm package lives in `packages/dsh-mv-session/`; `lib/migrate_session.cjs` there is synced from
the root `lib/migrate_session.js` (the package is ESM while the CLI runs as a CommonJS child process).

## License

[MIT](LICENSE)
