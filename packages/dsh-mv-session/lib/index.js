// dsh-mv-session — migrate DSH sessions/workspaces to a new path/title.
//
// Registers one host-side tool, `mv_session`, which runs the shipped
// frame-safe migration CLI (lib/migrate_session.cjs) through the shell
// service. The CLI preserves the DSH zstd frame invariant — frame 0 stays
// exactly one header line — so migrated sessions never crash `dsh web` on
// boot (see docs/dsh-session-migration-internals.md §2.5 in the repo).
//
// The plugin deliberately has ZERO runtime imports: ToolDefinition.parameters
// is a plain JSON Schema object, and external imports break resolution when
// this package is installed as a pnpm `link:` dependency (Node ESM resolves
// symlinked packages by their real path).
import { fileURLToPath } from 'node:url';

const name = 'mv-session';
const inject = ['shell', 'tools'];
const SCRIPT = fileURLToPath(new URL('./migrate_session.cjs', import.meta.url));

const q = (v) => JSON.stringify(String(v));

function buildArgv(args) {
  const argv = [];
  if (args.from) argv.push('--from', args.from);
  if (args.session) argv.push('--session', args.session);
  if (args.verify) {
    argv.push('--verify');
    return argv;
  }
  argv.push('--to', args.to);
  if (args.title) argv.push('--title', args.title);
  if (args.backup_dir) argv.push('--backup-dir', args.backup_dir);
  if (args.dry_run) argv.push('--dry-run');
  if (args.mkdir) argv.push('--mkdir');
  if (args.merge_dir) argv.push('--merge-dir');
  if (args.cleanup_empty === false) argv.push('--no-cleanup-empty');
  if (!args.dry_run) argv.push('--yes');
  return argv;
}

function summarizePlan(value) {
  const plan = Array.isArray(value.plan) ? value.plan : [];
  const byStep = {};
  for (const p of plan) byStep[p.step] = (byStep[p.step] || 0) + 1;
  return Object.entries(byStep).map(([step, count]) => '  - ' + step + ' x' + count).join('\n');
}

function summarizeActions(value) {
  const actions = Array.isArray(value.actions) ? value.actions : [];
  const lines = [];
  for (const a of actions) {
    if (a.step === 'backup') lines.push('  - backup -> ' + a.dir);
    else if (a.step === 'rewrite_header') lines.push('  - rewrite_header sid=' + a.sid + ' frames=' + a.frameCount + (a.repaired ? ' (repaired collapsed frames)' : ''));
    else if (a.step === 'cleanup_empty_sessions') lines.push('  - cleanup_empty_sessions removed=' + (a.removed || []).join(','));
    else if (a.step === 'manual_remaining') lines.push('  - manual: ' + a.detail);
  }
  return lines.join('\n');
}

function render(args, value) {
  const lines = [];
  if (!value || value.ok === false) {
    lines.push('mv_session failed (exit ' + (value && value.exitCode) + ')');
    if (value && value.stderr) lines.push('stderr: ' + value.stderr);
    else if (value && value.stdout) lines.push('stdout: ' + value.stdout);
  } else if (Array.isArray(value && value.problems)) {
    // --verify report (read-only consistency check)
    lines.push('mv_session verify: ' + (value.ok ? 'CONSISTENT' : 'PROBLEMS FOUND'));
    for (const c of value.checks || []) lines.push('  ✓ ' + c.check + ': ' + c.detail);
    for (const p of value.problems || []) lines.push('  ✗ PROBLEM: ' + p);
    for (const w of value.warnings || []) lines.push('  ⚠ warning (self-healing): ' + w);
    if (value.ok) lines.push('Migration is fully closed. Warnings above are harmless and self-healing.');
    else lines.push('Handle the problems above (rollback or re-migrate), then re-run verify.');
  } else if (value.dryRun) {
    const d = value.discovered || {};
    lines.push('mv_session dry-run (nothing changed)');
    lines.push('  workspace: ' + (d.workspacePath || '?') + ' -> ' + (args.to || '?'));
    lines.push('  sessions: ' + ((d.sessions || []).length));
    lines.push('  plan steps:');
    lines.push(summarizePlan(value));
  } else {
    const m = value.migrated || {};
    lines.push('mv_session migration complete');
    lines.push('  ' + (m.from || '?') + ' -> ' + (m.to || '?'));
    lines.push('  title: ' + (m.title || ''));
    lines.push('  sessions: ' + ((m.sessions || []).length));
    lines.push('  actions:');
    lines.push(summarizeActions(value));
    lines.push('');
    lines.push('Remaining manual steps:');
    lines.push('  1. restart dsh web (the plugin cannot restart its own host)');
    lines.push('  2. after restart confirms normal, delete the transition symlinks listed in the manual action above');
    lines.push('  3. close the loop with verify: mv_session { from: "' + (m.to || '') + '", verify: true }');
    lines.push('  4. rollback data lives in the backup dir of the actions list');
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

function createTool(ctx) {
  return {
    name: 'mv_session',
    description: 'Migrate DSH sessions/workspaces to a new path and/or title (rename a workspace). Runs the frame-safe migrate_session CLI: backs everything up, moves the directory, rewrites each session header cwd WITHOUT breaking the DSH zstd frame invariant (frame 0 stays exactly one header line; collapsed-frame logs are repaired), moves the sessions directory, updates workspace.json and session_projcache.json, cleans up auto-created empty sessions, and leaves transition symlinks. Use only when the user explicitly asked to move/rename a workspace. Real runs are destructive-but-backed-up: pass dry_run=true first to preview. The tool cannot restart dsh web itself (exactly one restart is required after migrating), so it reports the remaining manual steps; after the restart and symlink removal, call it again with verify=true as the read-only closing check.',
    timeoutMs: 600000,
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        from: { type: 'string', description: 'Current workspace path to migrate (use this OR session)' },
        session: { type: 'string', description: 'Session id to migrate; the script locates its workspace path (use this OR from)' },
        to: { type: 'string', description: 'Target workspace path (required unless verify=true)' },
        title: { type: 'string', description: 'New workspace title (default: basename of to)' },
        dry_run: { type: 'boolean', description: 'Print the plan without changing anything (default false)' },
        mkdir: { type: 'boolean', description: 'Create the target directory when it does not exist' },
        merge_dir: { type: 'boolean', description: 'Merge contents into an existing non-empty target directory (required when it exists)' },
        backup_dir: { type: 'string', description: 'Backup location (default: <dsh-home>/migration-backups)' },
        cleanup_empty: { type: 'boolean', description: 'Remove auto-created empty sessions at the target (default true)' },
        verify: { type: 'boolean', description: 'Read-only post-migration consistency check (registry record, session header cwd, frame invariant, dirs, cache, symlink leftovers). Replaces the second restart: run after restart + symlink removal. Needs only from/session, no to.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render,
    },
    async execute(args) {
      if (!args.from && !args.session) throw new Error('mv_session needs from (workspace path) or session (session id)');
      if (!args.verify && !args.to) throw new Error('mv_session needs to (target path) — unless verify=true');
      const command = 'node ' + q(SCRIPT) + ' ' + buildArgv(args).map(q).join(' ');
      const spec = ctx.shell.resolve({ command, timeoutMs: 600000, stdoutMaxBytes: 4 * 1024 * 1024 });
      const result = await ctx.shell.run(spec);
      const stdoutText = result.stdout && typeof result.stdout.text === 'string' ? result.stdout.text : '';
      const stderrText = result.stderr && typeof result.stderr.text === 'string' ? result.stderr.text : '';
      let parsed = null;
      try { parsed = JSON.parse(stdoutText); } catch (e) { /* keep raw */ }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsed.exitCode = result.exitCode;
        if (stderrText) parsed.stderr = stderrText.slice(0, 4000);
        if (result.stdout && result.stdout.truncated) parsed.stdoutTruncated = true;
        return parsed;
      }
      return {
        ok: false,
        exitCode: result.exitCode,
        stdout: stdoutText.slice(0, 4000),
        stderr: stderrText.slice(0, 4000),
        command,
      };
    },
  };
}

export default {
  name,
  inject,
  apply(ctx) {
    ctx.effect(() => ctx.tools.register(createTool(ctx)));
  },
};
