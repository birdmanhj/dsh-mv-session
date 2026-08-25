# mv-session User Manual

English | [中文](user-manual.md)

> Scope: the DSH-mv-session project (`lib/migrate_session.js` core script, the `mv_session`
> plugin tool, and the `packages/dsh-mv-session/` npm package). This document is for end users.
>
> **TL;DR**: the migration edits disk, but the running dsh web keeps using memory (the old path)
> and writes stale values back to disk. The fixed protocol is:
> **preview → migrate → restart once → verify in the GUI → delete symlinks → `--verify` check → done**.
> You can follow it without understanding the internals; §5 explains the why.

## 1. What problem this solves

After you rename or move a workspace directory, DSH does **not** migrate its sessions:

- old sessions stay bound to the old path (tool cwd breaks with ENOENT);
- DSH auto-creates an **empty workspace + empty sessions** at the new path;
- the session header `cwd`, the sessions directory, the workspace registry, and the projection
  cache disagree with each other.

`mv_session` performs the whole migration in one step (with backups) and tells you which manual
steps remain.

**Core safety guarantee**: the migration rewrites only frame 0 (the header frame) of each session
log and leaves every other frame byte-identical, so the DSH zstd frame invariant (frame 0 must be
exactly one header line) is never violated — no `dsh web` boot crash
(*"first frame is not exactly one header line"*). Historically collapsed logs are repaired
automatically.

## 2. Two ways to use it

| Form | Entry point | When |
|---|---|---|
| **Plugin tool** | Ask the agent in any DSH session to call the `mv_session` tool (natural language works) | Daily use (recommended) |
| **CLI** | `node lib/migrate_session.js ...` (in the repo) or the bundled `migrate_session.cjs` | Scripting, batch runs |

Both forms share the same parameters and behavior.

### 2.1 Install the plugin (once)

```bash
dsh plugin --profile web add dsh-mv-session        # from npm
dsh plugin --profile web add /path/to/packages/dsh-mv-session   # from a checkout

# restart dsh web once; afterwards just ask the agent, e.g.:
#   "migrate workspace /path/old to /path/new, title New Name"
```

Success marker: `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json` contains
`dsh-mv-session`, and `mv_session` shows up in the agent's tool list after the restart.

## 3. Parameters

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `from` | string | one of | Current workspace path (may be a symlink) |
| `session` | string | one of | Session id; the workspace is located from the cache/registry automatically |
| `to` | string | yes | Target workspace path |
| `title` | string | — | New title (default: basename of `to`) |
| `dry_run` | bool | — | Print the plan without changing anything (default false) |
| `mkdir` | bool | — | Allow creating the target directory |
| `merge_dir` | bool | — | Explicitly merge into an existing non-empty target (refused by default) |
| `backup_dir` | string | — | Backup location (default `<dsh-home>/migration-backups/`) |
| `cleanup_empty` | bool | — | Remove auto-created empty sessions at the target (default true) |
| `verify` | bool | — | Read-only consistency check (the tool form of `--verify`): run after restart + symlink removal; replaces the second restart |

CLI flags: `--from/--session/--to/--title/--dry-run/--mkdir/--merge-dir/--backup-dir/
--no-cleanup-empty/--verify/--yes`.

## 4. Standard migration flow (one restart closes the loop)

```bash
# Step 1: preview (writes nothing; --mkdir is needed to plan a missing target)
node lib/migrate_session.js --from /path/old --to /path/new --title "New Name" --mkdir --dry-run

# Step 2: migrate (auto-backup; takes effect on disk immediately)
node lib/migrate_session.js --from /path/old --to /path/new --title "New Name" --mkdir --yes

# Step 2.5 (anti-write-back): immediately verify that the registry record survived —
# the old running process may write its stale in-memory registry back to workspace.json
# (observed in practice). If it reports "discover failed: no workspace record",
# re-run step 2 (idempotent: an existing transition symlink is reused, not rebuilt).
node lib/migrate_session.js --verify --from /path/new
```

```text
Step 3: restart dsh web — the only required restart (see §5.1). Three options:
        ① the bundled one-click script (recommended, bilingual output: kill old instance
           → start → wait for readiness → open browser):
           scripts/dsh-web-restart.command (macOS: double-click or bash; Linux: bash; optional port argument)
        ② manual command: kill $(lsof -tiTCP:3080) && dsh web
        ③ your own desktop shortcut (e.g. a dsh-web launcher)
Step 4: verify in the GUI:
        ✅ workspace list shows only the new path   ✅ full message history
        ✅ tool cwd works in sessions                ✅ no empty sessions/workspaces left
Step 5: delete the transition symlinks (safe now — the restarted process only references
        the new path, see §5.2):
        rm <old workspace directory symlink>
        rm ~/.dsh/sessions/<old projectKey symlink>
Step 6: read-only check instead of a second restart (see §5.3):
        node lib/migrate_session.js --verify --from /path/new
        → ok:true with no problems = loop closed; warnings are normal self-healing notices (§7);
        → problems or GUI anomalies → restart once more to investigate (that restart is a
          diagnostic aid, not a required step)
```

> Note: the early protocol required two restarts. The second one was only a defensive check
> ("nothing still depends on the old path after the symlinks are gone"), not a mechanical
> requirement — step 6's read-only `--verify` replaces it.

## 5. Principles: why exactly one restart (and not two, not zero)

### 5.1 Why a restart is required

The migration edits **disk**, but the running dsh web process holds a full **in-memory state**
that never re-reads disk before a restart:

| In-memory state | Consequence without a restart |
|---|---|
| `Session.header.cwd` (session objects) | Tools (bash/read/write) resolve their default workdir against the old cwd → ENOENT |
| `sessionPaths` map (log append paths) | Each turn's log append still targets the old projectKey directory → lands in the new location only through the transition symlink |
| workspace registry entities | The GUI list is unchanged; worse, its checkpoint writes the **stale in-memory values back** over workspace.json / session_projcache.json, overwriting the migration's fresh edits (hit twice in practice: a registry record got clobbered, a cache cwd reverted) |

After a restart the process rebuilds from disk: the registry is rebuilt from
`sessionPersistence.list()` (reading each session log's header), whose cwd now points at the new
path → the workspace appears correctly with full history; projection-cache identity mismatches
cold-rebuild automatically (lossless).

**Conclusion: disk changes take effect immediately (via the symlinks), but full effect requires
exactly one restart. Keep the migrate → restart window as short as possible** (the longer the
window, the higher the chance the old process writes stale values back; `--verify` right after
migrating tells you whether the registry record survived, and re-running the migration repairs it).

### 5.2 The transition symlinks: purpose and lifetime

The symlinks serve only the "old process → restart" window: they keep the old cwd usable (tools
don't error) and route log appends through the old path to the new location (no log split).
**Once the restart has happened, the new process references only the new path, so the symlinks'
job is done** and deleting them is safe (step 5). Do not delete them before the restart (the old
process still needs them) and do not keep them forever (leftover old-spelling symlinks interfere
with later migrations and checks).

### 5.3 Why a second restart is not required

- After step 3, process memory is entirely on the new path: tool cwd, append paths, and registry
  records are new; nothing references the old path anymore;
- deleting the symlinks (step 5) therefore changes no live references;
- "restart once more to confirm" was purely defensive — catching some unforeseen dependency on
  the old path. The read-only `--verify` now performs the same check (§7): registry record ↔
  session header cwd ↔ frame invariant ↔ session directories ↔ projection cache, plus symlink
  leftovers;
- hence the standard protocol has exactly **one required restart**; `--verify` all-green closes
  the loop, and you only restart again if problems or GUI anomalies appear.

### 5.4 Can it be zero restarts?

**Not today.** Reasons:

1. the in-memory layer (§5.1) has no public "rehome online" API — the `workspaceRegistry`
   service has no rename/rehome method, and the `sessionPaths` map is not refreshable;
2. mutating the running process's in-memory objects from a plugin is undocumented internal
   surgery (editing Session headers, bypassing registry validation) — fragile across DSH
   versions, and the plugin cannot prove that every downstream consumer (append paths, GUI
   subscriptions, cache checkpoints) switched over;
3. the only DSH-supported way to refresh the in-memory layer is a process restart.

**The achievable minimum is one restart** (this protocol). If DSH ever ships an official
`workspaceRegistry.rehome(oldPath, newPath)`-style API, the plugin can be upgraded to true
zero-restart migration; until then, "migrate + one restart" is the best balance of reliability
and invasiveness.

### 5.5 Mapping from the old "two restarts" protocol

| Old protocol | Now | Nature |
|---|---|---|
| 1st restart | step 3 (the only restart) | required (refresh the in-memory layer) |
| delete symlinks | step 5 (after the restart) | required (remove the transition apparatus) |
| 2nd restart | step 6 `--verify` | verification (replacement; restart only on anomalies) |

## 6. Scenarios

### 6.1 Plain rename/move

```
Agent tool call: mv_session { from: "/path/old", to: "/path/new", title: "New", dry_run: true }
→ review the plan → call again: mv_session { from: "/path/old", to: "/path/new", title: "New", mkdir: true }
→ restart dsh web (the only required restart) → verify in the GUI → delete symlinks → --verify closes the loop
```

### 6.2 Only the session id is known

```
mv_session { session: "session-xxxx", to: "/path/new" }
```

### 6.3 Target directory already exists and is non-empty

Refused by default (the error suggests `--merge-dir`). To merge:

```
mv_session { from: "/path/old", to: "/path/existing", merge_dir: true }
```

The script checks for name collisions first (listing them and aborting on any) and then merges
entry by entry.

### 6.4 --from is itself a symlink

The script locates session directories via the **real path recorded in the registry** (so nothing
is missed), moves the real directory, and replaces the old symlink with the new transition link.

## 7. Reading the output

- dry-run: `discovered` (workspace id/path/session count, old and new projectKeys, whether the
  target already has a record) + `plan` (the step list) — **read-only**.
- real run: `migrated` (from/to/title/session count) + `actions`:
  - `backup`: backup directory (the rollback basis);
  - `rewrite_header`: per-session rewrite results (`frameCount` frames; `repaired: true` means the
    log had been collapsed by an older tool and was rebuilt one frame per line);
  - `manual_remaining`: the remaining manual steps (restart, delete symlinks).
- `--verify` (read-only, replaces the second restart):
  - `checks`: per-item passes (registry record, each session's frame invariant and header cwd);
  - `problems`: **must handle** (missing record, header cwd ≠ record path, frame-0 invariant
    violated, corrupt log) — investigate/roll back and restart if any appear;
  - `warnings`: **harmless and self-healing** (stale projcache cwd → auto cold-rebuild on read;
    leftover symlinks → just delete them).
- In tool form, all of the above is rendered as a readable report with rollback hints.

## 8. Safety mechanisms

1. **Frame invariant**: only frame 0 is rewritten; every other frame stays byte-identical; before
   writing, the result is re-checked against the same assertion dsh boot uses (frame 0 is exactly
   one header line, cwd updated, every frame independently decodable); tmp+rename atomic replace.
2. **Backup before mutation**: workspace.json, the projection cache, and every affected session
   log are copied to the backup directory first.
3. **Explicit consent**: a non-empty target directory is refused by default; any disk-level step
   that fails aborts with the backup preserved.
4. **Idempotency guards**: an existing transition symlink is reused instead of rebuilt; record and
   empty-session cleanups deduplicate.

## 9. Rollback

1. Data rollback: the backup directory holds the pre-migration workspace.json / projection cache /
   session logs; move the directory back to the old path and run the migration in reverse (new
   path → old path), or restore the four layers by hand and restart dsh web.
2. Note: restart dsh web **as soon as possible** after migrating — the running process may write
   its stale in-memory registry back to disk (observed in practice). Before restarting, check
   workspace.json; if the record was clobbered, re-run the migration before the restart, after
   which the process rebuilds from disk and is stable.

## 10. FAQ

| Symptom | Cause & action |
|---|---|
| `--to path does not exist (use --mkdir to create it)` | Target missing: add `--mkdir` to preview and real run |
| `ENOTEMPTY: rename ...` or `--to directory exists and is not empty` | Target non-empty: pass `--merge-dir` explicitly (collisions checked first) |
| `--from and --to resolve to the same directory` | Guard trip: from/to point at one directory (e.g. re-running with a symlink as from) — pick a different target |
| `no workspace record found for path ...` | No registry record for from: open the workspace once in the GUI, or check the path; may also mean the old process wrote back over it (see next row) |
| `preflight failed — nothing was modified` | A bad log was found before any mutation: **nothing changes** (not even a backup); replace the listed logs from backups and re-run |
| Migration failed or was interrupted midway | Preflight keeps bad logs from failing midway; if a disk step was interrupted, restore the four layers from the backup directory, move the directory back, and re-run |
| Workspace missing / record lost after restart | The old process wrote its registry back: check workspace.json before restarting (step 2.5) and re-apply if needed |
| Session history missing after migration | Check whether the sessions directory moved completely and header cwd is the new path; roll back from the backup and redo |
| `--verify` reports projcache cwd stale | **Harmless, self-healing**: the cache identity mismatch cold-rebuilds on read; no action needed |
| `--verify` reports header cwd mismatch | This is a problem: header and registry disagree — roll back from the backup and redo the migration |
| `zstd unavailable` | Use Node ≥ 22.15 (native node:zlib zstd), or install @mongodb-js/zstd / the zstd CLI |
| Tool execution timed out | Very large logs (hundreds of MB) compress slowly: raise timeoutMs or run the CLI directly |
| Is the second restart really needed? | No. `--verify` all-green closes the loop; restart again only on problems or GUI anomalies (§5.3) |
| Does it work on Windows? | The logic is cross-platform but battle-tested only on macOS/Linux; on Windows, walk the full flow once on a test workspace first |

## 11. Tests & regression

```bash
node --check lib/migrate_session.js
node tests/migrate_e2e_scratch.js [real-session-log] --boot   # frame invariant + real dsh web boot
node tests/migrate_edge_cases.js                              # merge/symlink/no-zstd/--session/--verify edges
```

Related docs: `docs/user-manual.md`（中文版）、`docs/dsh-session-migration-internals.md`
(internals), `docs/publishing.md` (publishing guide).
