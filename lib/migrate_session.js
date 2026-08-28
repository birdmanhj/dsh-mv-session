#!/usr/bin/env node
/*
 * migrate_session.js — migrate DSH sessions/workspaces to a new path and/or title.
 *
 * Input : --from <old cwd> --to <new cwd> [--title <new title>]   (path-based)
 *         --session <sessionId> --to <new cwd> [--title]          (session-based)
 * Output: JSON report of what changed + the manual steps that remain
 *         (restart dsh web, remove transition symlinks, rollback notes).
 *
 * Usage:
 *   node migrate_session.js --from /path/old --to /path/new --title "New Name" [--dry-run] [--yes]
 *
 * Safety: every mutation is asserted; a full backup is written before the first change;
 * --dry-run prints the exact operation plan without touching anything.
 *
 * Zstd framing (learned from the 2026-08-24 boot crash): a session.jsonl.zstd is a
 * CONCATENATION of independently decodable Zstandard frames. DSH's boot check
 * (`assertZstdHeaderFrame` in dsh-session-persistence-jsonl) requires frame 0 to
 * decompress to EXACTLY ONE header line — a whole-log single-frame recompression
 * corrupts this invariant and crashes `dsh web` with
 * "first frame is not exactly one header line". The header rewrite below therefore
 * replaces ONLY frame 0 and leaves every other frame byte-identical; a log whose
 * frame 0 was already collapsed by an older tool is repaired by re-emitting each
 * line as its own checksummed frame (the layout fix_dsh_frames_node.mjs produces).
 * Every rewritten log is verified against the same invariant before it replaces
 * the original file.
 *
 * Requirements: Node >= 22.15 (native node:zlib zstd); falls back to
 * require('@mongodb-js/zstd') or the `zstd` CLI on older Node.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = {
    from: '', to: '', title: '', session: '',
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    dryRun: false, yes: false, backupDir: '', mkdirTo: false, cleanupEmpty: true, mergeDir: false,
    verify: false, fixProjcache: false, force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') opts.from = argv[++i] || '';
    else if (a === '--to') opts.to = argv[++i] || '';
    else if (a === '--title') opts.title = argv[++i] || '';
    else if (a === '--session') opts.session = argv[++i] || '';
    else if (a === '--dsh-home') opts.dshHome = argv[++i] || opts.dshHome;
    else if (a === '--backup-dir') opts.backupDir = argv[++i] || '';
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--mkdir') opts.mkdirTo = true;
    else if (a === '--merge-dir') opts.mergeDir = true;
    else if (a === '--verify') opts.verify = true;
    else if (a === '--fix-projcache') opts.fixProjcache = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--no-cleanup-empty') opts.cleanupEmpty = false;
    else if (a === '--help') { opts.help = true; }
  }
  return opts;
}

function usage() {
  return [
    'usage: node migrate_session.js --from <old-cwd> --to <new-cwd> [options]',
    '       node migrate_session.js --session <sessionId> --to <new-cwd> [options]',
    '       node migrate_session.js --verify --from <cwd>',
    '       node migrate_session.js --fix-projcache --from <cwd> [--force]',
    'options:',
    '  --title <name>       new workspace title (default: basename of --to)',
    '  --dsh-home <dir>     DSH data dir (default: $DSH_HOME or ~/.dsh)',
    '  --backup-dir <dir>   backup location (default: <dsh-home>/migration-backups)',
    '  --dry-run            print the plan without executing anything',
    '  --yes                skip the interactive confirmation (required without TTY)',
    '  --mkdir              create the --to directory when it does not exist',
    '  --merge-dir          merge into an existing non-empty --to directory (required when it exists)',
    '  --verify             read-only consistency check: registry <-> headers <-> dirs <-> cache',
    '  --fix-projcache      align projcache identity (cwd+createdAt) to the session headers;',
    '                       idempotent; MUST run while dsh web is STOPPED (refuses otherwise,',
    '                       override with --force)',
    '  --force              override the live-dsh guard for --fix-projcache',
    '  --no-cleanup-empty   keep auto-created empty sessions/records at the target',
  ].join('\n');
}

// ---------------------------------------------------------------- encoding (mirrors dsh-session-persistence-jsonl)

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return '--' + (readable.replace(/^-+/, '') || 'root').slice(0, 251) + '--';
}

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

// ---------------------------------------------------------------- zstd access

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 little-endian

/**
 * Structural Zstandard frame scanner, ported from scanZstdFrames() in
 * dsh-session-persistence-jsonl: locate complete frames without decompressing
 * their blocks. Returns complete frame ranges plus the byte offset where an
 * incomplete final frame begins (a torn tail from an in-flight append).
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length && frames.length < maxFrames) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid zstd frame magic at byte ' + offset);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('reserved zstd frame-header bit at byte ' + (offset - 1));
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved zstd block type at byte ' + (offset - 3));
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** Exactly the invariant DSH's assertZstdHeaderFrame enforces at boot. */
function isExactlyOneHeaderLine(text) {
  return text.length > 0 && text.indexOf('\n') === text.length - 1;
}

/**
 * Pick a zstd backend. Every backend exposes:
 *   compressFrame(buf) / decompressFrame(buf) — one complete frame
 *   decompressAll(buf)   — every complete frame concatenated (torn tails skipped)
 *   scan(buf)            — structural frame scanner
 * `deps` is a testability seam: { zlib, requireFn, spawnFn, candidates }.
 */
function createZstd(deps = {}) {
  const requireFn = typeof deps.requireFn === 'function' ? deps.requireFn : require;
  const spawnFn = typeof deps.spawnFn === 'function' ? deps.spawnFn : spawnSync;
  // 1. native node:zlib zstd (Node >= 22.15): no external dependency, no output
  //    caps, and checksummed frames exactly like dsh's own write path.
  const zlib = deps.zlib || requireFn('node:zlib');
  if (typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function') {
    const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
    return {
      kind: 'native',
      async compressFrame(buf) { return zlib.zstdCompressSync(buf, CHECKSUM_OPTIONS); },
      async decompressFrame(buf) { return zlib.zstdDecompressSync(buf); },
      async decompressAll(buf) {
        const { frames } = scanZstdFrames(buf);
        return Buffer.concat(frames.map((f) => zlib.zstdDecompressSync(buf.subarray(f.start, f.end))));
      },
      scan: scanZstdFrames,
    };
  }
  // 2. @mongodb-js/zstd from the profile / DSH home node_modules
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidates = Array.isArray(deps.candidates) ? deps.candidates : [
    path.join(dshHome, 'profiles', 'node_modules', '@mongodb-js', 'zstd'),
    path.join(dshHome, 'node_modules', '@mongodb-js', 'zstd'),
  ];
  for (const c of candidates) {
    try {
      const mod = requireFn(c);
      if (typeof mod.decompress === 'function') {
        return {
          kind: 'module',
          async compressFrame(buf) { return Buffer.from(await mod.compress(buf)); },
          async decompressFrame(buf) { return Buffer.from(await mod.decompress(buf)); },
          async decompressAll(buf) {
            const { frames } = scanZstdFrames(buf);
            const parts = [];
            for (const f of frames) parts.push(Buffer.from(await mod.decompress(buf.subarray(f.start, f.end))));
            return Buffer.concat(parts);
          },
          scan: scanZstdFrames,
        };
      }
    } catch (e) { /* try next */ }
  }
  // 3. zstd CLI
  try {
    const r = spawnFn('zstd', ['--version'], { stdio: 'ignore' });
    if (!r.error) {
      const cliCompress = (input) => {
        const r2 = spawnFn('zstd', ['-q', '-c'], { input, maxBuffer: 512 * 1024 * 1024 });
        if (r2.error || r2.status !== 0) throw new Error('zstd CLI compress failed: ' + (r2.error ? r2.error.message : r2.stderr));
        return r2.stdout;
      };
      const cliDecompress = (input) => {
        const r2 = spawnFn('zstd', ['-dc'], { input, maxBuffer: 512 * 1024 * 1024 });
        if (r2.error || r2.status !== 0) throw new Error('zstd CLI decompress failed: ' + (r2.error ? r2.error.message : r2.stderr));
        return r2.stdout;
      };
      return {
        kind: 'cli',
        async compressFrame(buf) { return cliCompress(buf); },
        async decompressFrame(buf) { return cliDecompress(buf); },
        async decompressAll(buf) {
          const { frames } = scanZstdFrames(buf);
          return Buffer.concat(frames.map((f) => cliDecompress(buf.subarray(f.start, f.end))));
        },
        scan: scanZstdFrames,
      };
    }
  } catch (e) { /* fall through */ }
  return null;
}

// ---------------------------------------------------------------- helpers

function log(msg) { process.stderr.write('[mv-session] ' + msg + '\n'); }

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function writeJson(p, value) {
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function realOrNull(p) {
  try { return fs.realpathSync(p); } catch (e) { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

async function readSessionHeader(logPath, z) {
  const buf = fs.readFileSync(logPath);
  const whole = (await z.decompressAll(buf)).toString('utf8');
  return JSON.parse(whole.split('\n', 1)[0]);
}

async function countEventLinesSync(logPath, z) {
  // used only for the "is this an empty auto-created session" check
  const buf = fs.readFileSync(logPath);
  const whole = (await z.decompressAll(buf)).toString('utf8');
  return whole.split('\n').filter((l) => l.trim()).length;
}

/**
 * Rewrite the header's cwd WITHOUT violating the DSH frame invariant:
 *
 *   frame 0 must decompress to exactly one header line; every other frame is
 *   left byte-identical. A log whose frame 0 was already collapsed into one
 *   whole-log frame (an old `zstd -dc | edit | zstd -c` round-trip) is repaired
 *   by re-emitting each line as its own checksummed frame — frame 0 = header
 *   line, the exact layout dsh's own write path and fix_dsh_frames_node.mjs
 *   produce.
 *
 * Returns { out: Buffer, repaired: boolean }.
 */
async function rewriteHeaderCwd(logPath, newCwd, z) {
  const buf = fs.readFileSync(logPath);
  const { frames, tornStart } = z.scan(buf);
  if (frames.length === 0) throw new Error('no complete zstd frames in ' + logPath);
  const first = frames[0];
  const firstText = (await z.decompressFrame(buf.subarray(first.start, first.end))).toString('utf8');

  // Fast path: frame 0 already satisfies the DSH header-frame invariant.
  if (isExactlyOneHeaderLine(firstText)) {
    let hdr = null;
    try { hdr = JSON.parse(firstText.slice(0, -1)); } catch (e) { hdr = null; }
    if (hdr && typeof hdr.cwd === 'string') {
      hdr.cwd = newCwd;
      const newFrame = await z.compressFrame(Buffer.from(JSON.stringify(hdr) + '\n', 'utf8'));
      const restStart = frames.length > 1 ? frames[1].start : first.end;
      return { out: Buffer.concat([newFrame, buf.subarray(restStart)]), repaired: false };
    }
  }

  // Repair path: frame 0 holds more than the header (collapsed by an old tool).
  const whole = (await z.decompressAll(buf)).toString('utf8');
  const lines = whole.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) throw new Error('empty session log: ' + logPath);
  let hdr;
  try { hdr = JSON.parse(lines[0]); } catch (e) { throw new Error('session log has no parseable header line: ' + logPath); }
  if (typeof hdr.cwd !== 'string') throw new Error('header has no cwd: ' + logPath);
  hdr.cwd = newCwd;
  const chunks = [await z.compressFrame(Buffer.from(JSON.stringify(hdr) + '\n', 'utf8'))];
  for (let i = 1; i < lines.length; i++) chunks.push(await z.compressFrame(Buffer.from(lines[i] + '\n', 'utf8')));
  if (tornStart !== undefined) chunks.push(buf.subarray(tornStart));
  return { out: Buffer.concat(chunks), repaired: true };
}

/**
 * Verify a rewritten log the way `dsh web` boot will: frame 0 decompresses to
 * exactly one header line carrying the new cwd, and every frame is valid.
 */
async function verifyMigratedLog(out, newCwd, z) {
  const { frames } = z.scan(out);
  if (frames.length === 0) throw new Error('migrated log has no zstd frames');
  const firstText = (await z.decompressFrame(out.subarray(frames[0].start, frames[0].end))).toString('utf8');
  if (!isExactlyOneHeaderLine(firstText)) throw new Error('migrated log frame 0 is not exactly one header line (dsh web would fail to boot)');
  const hdr = JSON.parse(firstText.slice(0, -1));
  if (hdr.cwd !== newCwd) throw new Error('migrated log header cwd mismatch: ' + hdr.cwd + ' != ' + newCwd);
  for (const f of frames) await z.decompressFrame(out.subarray(f.start, f.end));
  return frames.length;
}

/**
 * Pre-flight validation, run BEFORE the first mutation (before even the
 * backup): every affected session log must be readable and its header
 * rewritable — either frame 0 already satisfies the header-frame invariant
 * with a cwd, or the whole log collapses cleanly into the repair layout.
 * A bad log aborts the migration with NOTHING modified, instead of failing
 * halfway through after the directory move.
 */
async function preflightLogs(dis, z) {
  const problems = [];
  for (const s of dis.sessions) {
    const logPath = path.join(s.dir, 'session.jsonl.zstd');
    if (!fs.existsSync(logPath)) { problems.push('missing session log: ' + logPath); continue; }
    try {
      const buf = fs.readFileSync(logPath);
      const { frames } = z.scan(buf);
      if (frames.length === 0) { problems.push('no zstd frames: ' + logPath); continue; }
      for (const f of frames) await z.decompressFrame(buf.subarray(f.start, f.end));
      const firstText = (await z.decompressFrame(buf.subarray(frames[0].start, frames[0].end))).toString('utf8');
      if (isExactlyOneHeaderLine(firstText)) {
        const hdr = JSON.parse(firstText.slice(0, -1));
        if (typeof hdr.cwd !== 'string') problems.push('header has no cwd: ' + logPath);
      } else {
        const whole = (await z.decompressAll(buf)).toString('utf8');
        const lines = whole.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        let hdr = null;
        try { hdr = JSON.parse(lines[0]); } catch (e) { hdr = null; }
        if (!hdr || typeof hdr.cwd !== 'string') problems.push('collapsed log has no parseable header line: ' + logPath);
      }
    } catch (e) {
      problems.push('unreadable session log: ' + logPath + ' — ' + e.message);
    }
  }
  if (problems.length > 0) {
    throw new Error('preflight failed — nothing was modified:\n  ' + problems.join('\n  '));
  }
}

/**
 * Read-only post-migration consistency check (--verify). Replaces the second
 * "restart to confirm" step: after the restart and the symlink cleanup, this
 * asserts that the data layers agree — workspace.json record, session header
 * cwd + frame invariant, sessions directory location, and projection-cache
 * identity. A stale or missing projcache identity (cwd OR createdAt) is a
 * PROBLEM, not a warning: the "self-heal" is a full-log cold replay, which
 * times out on large sessions (incident DSH-MV-2026-0826-01). Leftover
 * transition symlinks are warnings. Also emits a manual availability check:
 * open the largest session after startup and confirm no "signal timed out".
 */
async function verifyHome(opts, z) {
  const problems = [];
  const warnings = [];
  const checks = [];
  const manualChecks = [];
  const sessionMeta = []; // { sid, frames, cwd, createdAt }
  let dis = null;
  try {
    // discover() demands --to and rejects from===to; verify is read-only and
    // targets the workspace itself, so point --to at a nonexistent placeholder
    dis = await discover({ ...opts, to: (opts.from || 'verify-target') + '.__verify__', mkdirTo: true }, z);
  } catch (e) {
    problems.push('discover failed: ' + e.message);
  }
  if (dis) {
    checks.push({ check: 'workspace record', ok: true, detail: 'id=' + dis.wsId + ' path=' + dis.wsRec.path + ' title=' + dis.wsRec.title });
    for (const s of dis.sessions) {
      const logPath = path.join(s.dir, 'session.jsonl.zstd');
      if (!fs.existsSync(logPath)) { problems.push('missing session log: ' + logPath); continue; }
      try {
        const buf = fs.readFileSync(logPath);
        const { frames } = z.scan(buf);
        const firstText = (await z.decompressFrame(buf.subarray(frames[0].start, frames[0].end))).toString('utf8');
        if (!isExactlyOneHeaderLine(firstText)) {
          problems.push('frame-0 invariant broken (dsh web would fail to boot): ' + logPath);
        } else {
          const hdr = JSON.parse(firstText.slice(0, -1));
          // compare RAW spelling: the four layers must agree verbatim; a
          // transition symlink would otherwise mask a stale path via realpath
          if (typeof hdr.cwd === 'string' && hdr.cwd !== dis.wsRec.path) {
            problems.push('header cwd mismatch: ' + s.sid + ' header=' + hdr.cwd + ' record=' + dis.wsRec.path);
          } else {
            checks.push({ check: 'session log', ok: true, detail: s.sid + ' frames=' + frames.length + ' cwd=' + hdr.cwd });
          }
          sessionMeta.push({ sid: s.sid, frames: frames.length, cwd: hdr.cwd, createdAt: hdr.createdAt });
        }
        for (const f of frames) await z.decompressFrame(buf.subarray(f.start, f.end));
      } catch (e) {
        problems.push('session log corrupt: ' + logPath + ' — ' + e.message);
      }
    }
    // R1: projcache identity must FULLY align (cwd AND createdAt) with the
    // session headers — a missing or mismatched identity means the cache is
    // dropped on next read and the log is cold-replayed (timeout risk on
    // large sessions). This is a PROBLEM, not a warning.
    const pcSessions = dis.projcache && dis.projcache.tables && dis.projcache.tables.sessions;
    for (const m of sessionMeta) {
      const entry = pcSessions && pcSessions[m.sid];
      if (!entry || !entry.identity || typeof entry.identity.cwd !== 'string') {
        problems.push('projcache identity missing for ' + m.sid + ' — run --fix-projcache with dsh web stopped');
        continue;
      }
      if (entry.identity.cwd !== dis.wsRec.path) {
        problems.push('projcache identity cwd mismatch for ' + m.sid + ': cache=' + entry.identity.cwd + ' header=' + m.cwd + ' — run --fix-projcache with dsh web stopped');
      }
      if (typeof m.createdAt === 'number' && entry.identity.createdAt !== m.createdAt) {
        problems.push('projcache identity createdAt mismatch for ' + m.sid + ': cache=' + entry.identity.createdAt + ' header=' + m.createdAt + ' — run --fix-projcache with dsh web stopped');
      }
    }
    // R3: availability smoke — name the largest session for a manual cold read.
    if (sessionMeta.length > 0) {
      const largest = sessionMeta.reduce((a, b) => (b.frames > a.frames ? b : a));
      checks.push({ check: 'largest session', ok: true, detail: largest.sid + ' frames=' + largest.frames });
      manualChecks.push('after starting dsh web, open the largest session ' + largest.sid + ' (' + largest.frames + ' frames) and confirm its history loads without "signal timed out"');
    }
    if (fs.existsSync(dis.fromCwd) && fs.lstatSync(dis.fromCwd).isSymbolicLink()) {
      warnings.push('transition symlink still present: ' + dis.fromCwd + ' -> ' + realOrNull(dis.fromCwd));
    }
    const oldProj = path.join(dis.sessionsRoot, dis.fromProjectKey);
    if (fs.existsSync(oldProj) && fs.lstatSync(oldProj).isSymbolicLink()) {
      warnings.push('sessions transition symlink still present: ' + oldProj + ' -> ' + realOrNull(oldProj));
    }
  }
  return { ok: problems.length === 0, problems, warnings, checks, manualChecks };
}

/**
 * Detect a live dsh web process: a listener on the default web port (3080),
 * or a process whose command line contains "dsh web".
 */
function detectLiveDsh() {
  try {
    const r = spawnSync('lsof', ['-nP', '-tiTCP:3080', '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (!r.error && r.status === 0 && String(r.stdout || '').trim()) {
      return { alive: true, detail: 'port 3080 is listening (PID ' + String(r.stdout).trim().split('\n')[0] + ')' };
    }
  } catch (e) { /* ignore */ }
  try {
    const r = spawnSync('pgrep', ['-f', 'dsh web'], { encoding: 'utf8' });
    if (!r.error && r.status === 0 && String(r.stdout || '').trim()) {
      return { alive: true, detail: 'dsh web process found (PID ' + String(r.stdout).trim().split('\n')[0] + ')' };
    }
  } catch (e) { /* ignore */ }
  return { alive: false, detail: '' };
}

/**
 * R2 (incident DSH-MV-2026-0826-01): align session_projcache.json identities
 * (cwd AND createdAt) to the session headers — header-authoritative, like the
 * emergency script in the incident report. MUST run with dsh web STOPPED: the
 * live process's checkpoint write-back would overwrite the fix. Refuses when
 * a live dsh is detected unless --force. Idempotent — safe to re-run. The
 * migration itself no longer writes the projcache at all.
 */
async function fixProjcache(opts, z) {
  const live = detectLiveDsh();
  if (live.alive && !opts.force) {
    throw new Error('dsh web appears to be running (' + live.detail + '). The projection cache must be aligned with dsh STOPPED — a live checkpoint would overwrite this fix. Stop dsh web first, or pass --force at your own risk.');
  }
  const dis = await discover({ ...opts, to: (opts.from || 'fix-target') + '.__fix__', mkdirTo: true }, z);
  const pcPath = path.join(opts.dshHome, 'storages', 'session_projcache.json');
  if (!fs.existsSync(pcPath)) throw new Error('projcache file not found: ' + pcPath);
  const pc = JSON.parse(fs.readFileSync(pcPath, 'utf8'));
  if (!pc.tables || typeof pc.tables !== 'object') pc.tables = {};
  if (!pc.tables.sessions || typeof pc.tables.sessions !== 'object') pc.tables.sessions = {};

  // backup before touching anything
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(opts.backupDir || path.join(opts.dshHome, 'migration-backups'), 'fix-projcache-' + now);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(pcPath, path.join(backupDir, 'session_projcache.json'));

  const aligned = [];
  for (const s of dis.sessions) {
    const logPath = path.join(s.dir, 'session.jsonl.zstd');
    if (!fs.existsSync(logPath)) continue;
    const buf = fs.readFileSync(logPath);
    const { frames } = z.scan(buf);
    if (frames.length === 0) continue;
    const firstText = (await z.decompressFrame(buf.subarray(frames[0].start, frames[0].end))).toString('utf8');
    const hdr = JSON.parse(firstText.slice(0, -1)); // header-authoritative
    if (typeof hdr.cwd !== 'string' || typeof hdr.createdAt !== 'number') {
      throw new Error('session header lacks cwd/createdAt: ' + logPath);
    }
    const entry = pc.tables.sessions[s.sid] || {};
    const was = entry.identity ? { cwd: entry.identity.cwd, createdAt: entry.identity.createdAt } : null;
    entry.identity = { createdAt: hdr.createdAt, cwd: hdr.cwd };
    pc.tables.sessions[s.sid] = entry;
    aligned.push({ sid: s.sid, cwd: hdr.cwd, createdAt: hdr.createdAt, was });
  }
  // orphan cleanup: entries pointing at this workspace's paths but without a
  // session dir/header in it (leftovers of auto-created empty sessions)
  const known = new Set(dis.sessions.map((s) => s.sid));
  const wsPaths = new Set([dis.wsRec.path, dis.fromCwd].filter(Boolean));
  const removed = [];
  for (const [sid, entry] of Object.entries(pc.tables.sessions)) {
    if (known.has(sid)) continue;
    if (entry && entry.identity && wsPaths.has(entry.identity.cwd)) {
      delete pc.tables.sessions[sid];
      removed.push(sid);
    }
  }
  writeJson(pcPath, pc);
  return { ok: true, aligned, removedOrphans: removed, backupDir, liveDetected: live.alive };
}

// ---------------------------------------------------------------- discovery

function findWorkspaceRecord(state, fromReal) {
  for (const [id, rec] of Object.entries(state.tables.workspaces)) {
    const rp = realOrNull(rec.path);
    if (rp === fromReal || rec.path === fromReal) return { id, rec };
  }
  return null;
}

function findRecordByPath(state, targetReal) {
  for (const [id, rec] of Object.entries(state.tables.workspaces)) {
    const rp = realOrNull(rec.path);
    if (rp === targetReal) return { id, rec };
  }
  return null;
}

async function discover(opts, z) {
  const sessionsRoot = path.join(opts.dshHome, 'sessions');
  const workspaceFile = path.join(opts.dshHome, 'storages', 'workspace.json');
  const projcacheFile = path.join(opts.dshHome, 'storages', 'session_projcache.json');
  const state = readJson(workspaceFile);
  const projcache = fs.existsSync(projcacheFile) ? readJson(projcacheFile) : null;

  let fromCwd = opts.from;
  if (opts.session) {
    // locate the session's cwd: projcache identity first, then workspace records
    const cacheEntry = projcache && projcache.tables && projcache.tables.sessions && projcache.tables.sessions[opts.session];
    if (cacheEntry && cacheEntry.identity && cacheEntry.identity.cwd) {
      fromCwd = cacheEntry.identity.cwd;
    } else {
      for (const rec of Object.values(state.tables.workspaces)) {
        if (rec.sessionIds.includes(opts.session)) { fromCwd = rec.path; break; }
      }
    }
    if (!fromCwd) throw new Error('cannot locate session ' + opts.session + ' in workspace.json or projcache');
  }
  if (!fromCwd) throw new Error('--from or --session is required');
  if (!opts.to) throw new Error('--to is required');
  const fromReal = realOrNull(fromCwd);
  const toReal = realOrNull(opts.to);
  if (!fromReal) throw new Error('--from path does not exist (even via symlink): ' + fromCwd);
  if (!toReal && !opts.mkdirTo) throw new Error('--to path does not exist: ' + opts.to + ' (use --mkdir to create it)');
  if (toReal && fromReal && toReal === fromReal) throw new Error('--from and --to resolve to the same directory: ' + fromReal + ' (nothing to migrate; pick a different target)');
  if (toReal && toReal !== fromReal && isDir(toReal) && fs.readdirSync(toReal).length > 0 && !opts.mergeDir) {
    throw new Error('--to directory exists and is not empty: ' + opts.to + ' (pass --merge-dir to merge its contents into the target)');
  }
  if (toReal && toReal !== fromReal && isDir(toReal) && opts.mergeDir && isDir(fromReal)) {
    const collisions = fs.readdirSync(fromReal, { withFileTypes: true })
      .filter((e) => fs.existsSync(path.join(toReal, e.name)))
      .map((e) => e.name);
    if (collisions.length > 0) throw new Error('--to directory contains colliding entries (resolve them first, then rerun): ' + collisions.join(', '));
  }

  const ws = findWorkspaceRecord(state, fromReal);
  if (!ws) throw new Error('no workspace record found for path ' + fromCwd);

  // DSH encodes session directories with projectKey(header.cwd), and header.cwd
  // is the REAL path recorded in the workspace registry — never the symlink a
  // user may pass as --from. Derive the key from the record path so a symlink
  // --from still locates the session dirs.
  const fromKeyPath = ws.rec.path || fromReal;
  const fromProjectKey = projectKey(fromKeyPath);

  const sessions = ws.rec.sessionIds || [];
  const sessionDirs = [];
  for (const sid of sessions) {
    sessionDirs.push({ sid, dir: path.join(sessionsRoot, fromProjectKey, encodeSegment(sid)) });
  }
  // also include any session dirs physically present under projectKey(from) that are not in the record
  const fromProjectDir = path.join(sessionsRoot, fromProjectKey);
  if (fs.existsSync(fromProjectDir)) {
    for (const entry of fs.readdirSync(fromProjectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sid = entry.name; // encoded id; decode not needed for directory moves
      if (!sessions.includes(sid)) sessionDirs.push({ sid, dir: path.join(fromProjectDir, entry.name) });
    }
  }

  const targetExisting = findRecordByPath(state, toReal);
  return {
    state, projcache, sessionsRoot, workspaceFile, projcacheFile,
    fromCwd, fromReal, toCwd: opts.to, toReal,
    wsId: ws.id, wsRec: ws.rec, sessions: sessionDirs,
    fromProjectKey, toProjectKey: projectKey(opts.to),
    targetExisting,
  };
}

// ---------------------------------------------------------------- plan

async function buildPlan(dis, opts, z) {
  const plan = [];
  const targetRecordId = dis.targetExisting ? dis.targetExisting.id : dis.wsId;
  const newTitle = opts.title || path.basename(dis.toCwd);

  // 1. disk move + transition symlink
  if (!dis.toReal) plan.push({ step: 'mkdir_to', path: dis.toCwd });
  else if (opts.mergeDir && isDir(dis.toCwd) && fs.readdirSync(dis.toCwd).length > 0) plan.push({ step: 'merge_dir', from: dis.fromCwd, to: dis.toCwd });
  plan.push({ step: 'move_dir', from: dis.fromCwd, to: dis.toCwd });
  plan.push({ step: 'symlink', from: dis.fromCwd, to: dis.toCwd });

  // 2. header rewrite per session
  for (const s of dis.sessions) {
    const logPath = path.join(s.dir, 'session.jsonl.zstd');
    if (!fs.existsSync(logPath)) { plan.push({ step: 'warn', msg: 'missing log for ' + s.sid + ' (skipping header rewrite)' }); continue; }
    plan.push({ step: 'rewrite_header', logPath, sid: s.sid, newCwd: dis.toCwd });
  }

  // 3. sessions dir move + old-key symlink
  const fromProj = path.join(dis.sessionsRoot, dis.fromProjectKey);
  const toProj = path.join(dis.sessionsRoot, dis.toProjectKey);
  if (fs.existsSync(fromProj)) {
    plan.push({ step: 'ensure_dir', path: toProj });
    for (const s of dis.sessions) {
      plan.push({ step: 'move_session_dir', from: s.dir, to: path.join(toProj, path.basename(s.dir)) });
    }
    plan.push({ step: 'rmdir_if_empty', path: fromProj });
    plan.push({ step: 'symlink', from: fromProj, to: toProj });
  }

  // 4. workspace.json update
  if (dis.targetExisting) {
    plan.push({ step: 'merge_workspace_record', targetId: targetRecordId, sessionIds: dis.sessions.map((s) => s.sid), dropId: dis.wsId, title: newTitle, path: dis.toCwd });
  } else {
    plan.push({ step: 'update_workspace_record', id: dis.wsId, path: dis.toCwd, title: newTitle });
  }

  // NOTE: no projcache writes here. The projection cache must be aligned with
  // dsh web STOPPED (see --fix-projcache), otherwise the live process's
  // checkpoint write-back overwrites any fix made during the migration
  // (incident DSH-MV-2026-0826-01).
  plan.push({ step: 'cleanup_empty_sessions', note: 'empty auto-created sessions at target are removed (use --no-cleanup-empty to keep)' });
  const selfPath = process.argv[1] || 'migrate_session.js';
  plan.push({
    step: 'manual',
    detail: 'REQUIRED: stop dsh web, then run: node ' + selfPath + ' --fix-projcache --from ' + JSON.stringify(dis.toCwd) + '; then start dsh web and, after the GUI confirms the new workspace, delete the transition symlinks: ' + dis.fromCwd + ' and ' + fromProj + '; then close the loop with: node ' + selfPath + ' --verify --from ' + JSON.stringify(dis.toCwd),
  });
  return plan;
}

// ---------------------------------------------------------------- execute

async function executePlan(dis, plan, opts, z, backupDir) {
  const done = [];
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const bk = path.join(backupDir, 'mv-' + now);
  fs.mkdirSync(bk, { recursive: true });

  // backup
  fs.copyFileSync(dis.workspaceFile, path.join(bk, 'workspace.json'));
  if (dis.projcacheFile && fs.existsSync(dis.projcacheFile)) fs.copyFileSync(dis.projcacheFile, path.join(bk, 'session_projcache.json'));
  for (const s of dis.sessions) {
    const lp = path.join(s.dir, 'session.jsonl.zstd');
    if (fs.existsSync(lp)) fs.copyFileSync(lp, path.join(bk, path.basename(s.dir) + '.session.jsonl.zstd'));
  }
  done.push({ step: 'backup', dir: bk });

  for (const p of plan) {
    switch (p.step) {
      case 'mkdir_to': fs.mkdirSync(p.path, { recursive: true }); break;
      case 'move_dir': {
        if (!fs.existsSync(p.from)) break;
        let src = p.from;
        const st = fs.lstatSync(p.from);
        if (st.isSymbolicLink()) {
          // move the real target, drop the stale link
          src = fs.realpathSync(p.from);
          fs.unlinkSync(p.from);
        }
        if (!fs.existsSync(src)) break;
        if (fs.existsSync(p.to) && isDir(p.to)) {
          // merge contents into the existing target directory (--merge-dir);
          // collisions were pre-checked by discover()
          for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            fs.renameSync(path.join(src, entry.name), path.join(p.to, entry.name));
          }
          fs.rmdirSync(src);
        } else {
          fs.renameSync(src, p.to);
        }
        break;
      }
      case 'symlink': {
        const parent = path.dirname(p.from);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
        if (fs.existsSync(p.from)) {
          const st = fs.lstatSync(p.from);
          if (st.isSymbolicLink()) {
            if (realOrNull(p.from) === realOrNull(p.to)) break; // already the transition link
            fs.unlinkSync(p.from);
          } else {
            throw new Error('refusing to overwrite existing non-symlink at ' + p.from);
          }
        }
        fs.symlinkSync(p.to, p.from);
        break;
      }
      case 'rewrite_header': {
        const { out, repaired } = await rewriteHeaderCwd(p.logPath, p.newCwd, z);
        const frameCount = await verifyMigratedLog(out, p.newCwd, z);
        // atomic replace: never leave a half-written or unverified log in place
        const tmp = p.logPath + '.mv-tmp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        fs.writeFileSync(tmp, out);
        fs.renameSync(tmp, p.logPath);
        done.push({ step: 'rewrite_header', logPath: p.logPath, sid: p.sid, frameCount, repaired });
        break;
      }
      case 'ensure_dir': fs.mkdirSync(p.path, { recursive: true }); break;
      case 'move_session_dir': {
        if (fs.existsSync(p.from)) fs.renameSync(p.from, p.to);
        break;
      }
      case 'rmdir_if_empty': {
        try { fs.rmdirSync(p.path); } catch (e) { /* not empty — leave it */ }
        break;
      }
      case 'merge_workspace_record': {
        const state = dis.state;
        const merged = [...new Set([...p.sessionIds, ...(state.tables.workspaces[p.targetId].sessionIds || [])])];
        state.tables.workspaces[p.targetId] = Object.assign({}, state.tables.workspaces[p.targetId], {
          path: p.path, title: p.title, sessionIds: merged, updatedAt: new Date().toISOString(),
        });
        delete state.tables.workspaces[p.dropId];
        state.global.workspaceIds = state.global.workspaceIds.filter((id) => id !== p.dropId);
        writeJson(dis.workspaceFile, state);
        break;
      }
      case 'update_workspace_record': {
        const state = dis.state;
        state.tables.workspaces[p.id] = Object.assign({}, state.tables.workspaces[p.id], {
          path: p.path, title: p.title, updatedAt: new Date().toISOString(),
        });
        writeJson(dis.workspaceFile, state);
        break;
      }
      case 'cleanup_empty_sessions': {
        if (!opts.cleanupEmpty || !dis.targetExisting) break;
        const state = dis.state;
        const keep = new Set(dis.sessions.map((s) => s.sid));
        const rec = state.tables.workspaces[dis.targetExisting.id];
        if (!rec) break;
        const empties = [];
        for (const sid of rec.sessionIds) {
          if (keep.has(sid)) continue;
          // empty check via log line count
          const dir = path.join(dis.sessionsRoot, dis.toProjectKey, encodeSegment(sid));
          const lp = path.join(dir, 'session.jsonl.zstd');
          let isEmpty = false;
          if (fs.existsSync(lp)) {
            const lines = await countEventLinesSync(lp, z);
            isEmpty = lines <= 6;
          }
          if (isEmpty) empties.push({ sid, dir });
        }
        for (const e of empties) {
          fs.rmSync(e.dir, { recursive: true, force: true });
          rec.sessionIds = rec.sessionIds.filter((x) => x !== e.sid);
          // NOTE: the projcache entry for the empty session is intentionally
          // NOT deleted here (R2): projcache writes belong to --fix-projcache,
          // which removes orphans header-authoritatively with dsh stopped.
        }
        if (empties.length) {
          writeJson(dis.workspaceFile, state);
          done.push({ step: 'cleanup_empty_sessions', removed: empties.map((e) => e.sid) });
        }
        break;
      }
      case 'warn': log('WARN ' + p.msg); break;
      case 'manual': done.push({ step: 'manual_remaining', detail: p.detail }); break;
      default: break;
    }
  }
  return done;
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.from && !opts.session) || (!opts.verify && !opts.fixProjcache && !opts.to)) {
    process.stderr.write(usage() + '\n');
    process.exit(opts.help ? 0 : 2);
  }
  const z = createZstd();
  if (!z) {
    process.stderr.write('[mv-session] zstd unavailable: use Node >= 22.15, or install @mongodb-js/zstd / the zstd CLI\n');
    process.exit(1);
  }
  if (opts.verify) {
    const report = await verifyHome(opts, z);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(report.ok ? 0 : 1);
  }
  if (opts.fixProjcache) {
    try {
      const report = await fixProjcache(opts, z);
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exit(report.ok ? 0 : 1);
    } catch (e) {
      process.stderr.write('[mv-session] fatal: ' + e.message + '\n');
      process.exit(1);
    }
  }
  const dis = await discover(opts, z);
  const plan = await buildPlan(dis, opts, z);

  if (opts.dryRun) {
    const report = {
      dryRun: true,
      discovered: {
        workspaceId: dis.wsId, workspacePath: dis.wsRec.path, title: dis.wsRec.title,
        sessions: dis.sessions.map((s) => s.sid),
        fromProjectKey: dis.fromProjectKey, toProjectKey: dis.toProjectKey,
        targetExistingWorkspace: dis.targetExisting ? dis.targetExisting.id : null,
      },
      plan,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  if (!opts.yes) {
    process.stderr.write('[mv-session] non-interactive run requires --yes. Plan first with --dry-run.\n');
    process.exit(3);
  }

  // fail fast on unreadable logs BEFORE any mutation (not even a backup is written)
  await preflightLogs(dis, z);

  const backupRoot = opts.backupDir || path.join(opts.dshHome, 'migration-backups');
  const done = await executePlan(dis, plan, opts, z, backupRoot);
  process.stdout.write(JSON.stringify({
    ok: true,
    migrated: {
      from: dis.fromCwd, to: dis.toCwd,
      title: opts.title || path.basename(dis.toCwd),
      workspaceId: dis.wsId,
      sessions: dis.sessions.map((s) => s.sid),
    },
    actions: done,
  }, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('[mv-session] fatal: ' + (e && e.stack ? e.stack : String(e)) + '\n');
    process.exit(1);
  });
} else {
  // library mode for regression tests (tests/migrate_e2e_scratch.js)
  module.exports = {
    scanZstdFrames, isExactlyOneHeaderLine, createZstd,
    rewriteHeaderCwd, verifyMigratedLog, verifyHome, fixProjcache, preflightLogs,
    projectKey, encodeSegment, parseArgs, detectLiveDsh,
  };
}
