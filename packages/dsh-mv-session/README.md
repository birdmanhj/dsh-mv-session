# dsh-mv-session

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-mv-session)](https://www.npmjs.com/package/dsh-mv-session)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin that migrates
sessions/workspaces to a new path and/or title — one tool call, one restart, one verify command.

```
install → ask the agent to "migrate workspace X to Y" → restart dsh web (the only restart)
        → delete transition symlinks → verify (read-only) → done
```

## Pain point

After renaming a workspace directory, DSH does not migrate its sessions: old sessions stay bound to
the old path (tool cwd breaks with ENOENT), DSH auto-creates an empty workspace plus empty sessions
at the new path, and the persisted layers disagree. This plugin performs the whole migration in one
step, with backups.

## Frame-safe by design

`session.jsonl.zstd` is a multi-frame Zstandard stream; at boot DSH asserts that **frame 0
decompresses to exactly one header line**. A whole-log recompress collapses everything into one
frame and crashes `dsh web` at boot (*"first frame is not exactly one header line"*). The bundled
CLI rewrites **only frame 0**, leaves every other frame byte-identical, repairs previously collapsed
logs, and re-verifies the boot invariant before atomically replacing the file.

## Install

```bash
dsh plugin --profile web add dsh-mv-session
# restart dsh web once
```

## Usage — plugin tool (recommended)

In any DSH session, say: *"migrate workspace `/path/old` to `/path/new`, title New Name"*.

Parameters: `from` / `session` (one of), `to` (required), `title`, `dry_run`, `mkdir`,
`merge_dir`, `backup_dir`, `cleanup_empty`, `verify` (read-only closing check).

## Usage — CLI

```bash
node migrate_session.cjs --from /old --to /new --title "New" --mkdir --dry-run  # preview
node migrate_session.cjs --from /old --to /new --title "New" --mkdir --yes      # migrate (auto-backup)
# restart dsh web (the only required restart) → confirm in the GUI
# delete the transition symlinks (printed in the report)
node migrate_session.cjs --verify --from /new          # read-only check, done
```

## Why exactly one restart

The migration edits disk, but the running dsh web holds in-memory state (session header cwd, log
append paths, workspace registry) that never re-reads disk before restart and may write stale
values back. One restart rebuilds everything from disk. The post-symlink confirmation does not need
a second restart — the read-only `--verify` check covers it. Zero restarts is impossible today: DSH
has no online "rehome" API.

## Rollback

Every run is backed up first (workspace.json, session logs, projection cache). Rollback = restore
the backup directory + run the migration in reverse (new path → old path) + restart.

## Docs & development

Full manual, publishing guide, and internals notes live in the
[upstream repository](https://github.com/birdmanhj/dsh-mv-session): `docs/user-manual.md`,
`docs/publishing.md`, `docs/dsh-session-migration-internals.md` (中文).

`lib/migrate_session.cjs` is synced from the repo root `lib/migrate_session.js` (this package is
ESM while the CLI runs as a CommonJS child process).

## License

[MIT](LICENSE)
