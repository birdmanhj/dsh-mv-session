#!/usr/bin/env node
/*
 * migrate_projcache_timing.js — regression for incident DSH-MV-2026-0826-01
 * (migration renamed workspaces, restart dropped the projection cache, large
 * logs cold-replayed and hit "signal timed out").
 *
 * Reproduces the incident shape:
 *   1. a workspace with a LARGE session log (45000 frames, the incident scale)
 *   2. migrate → simulate the live process's checkpoint write-back by
 *      rewriting the projcache identity to the OLD values
 *   3. --verify must FAIL with a problem (before the fix it passed/warned)
 *   4. --fix-projcache (idempotent, header-authoritative) → --verify green
 *   5. cold-read smoke: full replay of the large log (every frame decompressed,
 *      every line parsed — what the cache cold rebuild does) must complete
 *      well within budget
 *   6. live-dsh guard: without --force, --fix-projcache refuses while a dsh
 *      web is listening (asserted only when one is detected)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'lib', 'migrate_session.js');
const mig = require(SCRIPT);
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

let failures = 0;
function check(cond, label) {
  if (cond) console.log('  PASS  ' + label);
  else { console.error('  FAIL  ' + label); failures++; }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mv-timing-'));
  const oldCwd = path.join(home, 'oldW');
  const newCwd = path.join(home, 'newW');
  const sid = 'session-big-0001';
  const createdAt = 1750000000000;
  console.log('scratch home:', home);

  // ---- build a large session log (incident scale: ~45000 frames) ----------
  const headerLine = JSON.stringify({ type: 'session', version: 0, id: sid, createdAt, cwd: oldCwd });
  const LINES = 45000;
  console.log('building large log (' + LINES + ' lines) ...');
  const t0 = Date.now();
  const chunks = [zlib.zstdCompressSync(Buffer.from(headerLine + '\n', 'utf8'), CHECKSUM_OPTIONS)];
  for (let i = 0; i < LINES - 1; i++) {
    chunks.push(zlib.zstdCompressSync(Buffer.from(
      JSON.stringify({ type: 'note', seq: i, time: createdAt + i, data: { text: 'event-' + i } }) + '\n', 'utf8'
    ), CHECKSUM_OPTIONS));
  }
  const logBuf = Buffer.concat(chunks);
  console.log('  built in ' + (Date.now() - t0) + 'ms, ' + (logBuf.length / 1024 / 1024).toFixed(1) + ' MB');

  // ---- scratch home --------------------------------------------------------
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  const logDir = path.join(home, 'sessions', mig.projectKey(oldCwd), mig.encodeSegment(sid));
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'session.jsonl.zstd'), logBuf);
  fs.mkdirSync(oldCwd, { recursive: true });
  fs.writeFileSync(path.join(oldCwd, 'marker.txt'), 'x');
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws1'], archivedSessionIds: [] },
    tables: { workspaces: { ws1: { path: oldCwd, title: 'W', sessionIds: [sid], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'storages', 'session_projcache.json'), JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: { sessions: { [sid]: { identity: { createdAt, cwd: oldCwd }, rows: {} } } },
  }, null, 2) + '\n');

  function runCli(argv) {
    return spawnSync(process.execPath, [SCRIPT, '--dsh-home', home, ...argv], {
      encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    });
  }

  // ---- migrate --------------------------------------------------------------
  const r = runCli(['--from', oldCwd, '--to', newCwd, '--mkdir', '--yes']);
  check(r.status === 0, 'migration exit 0 (stderr: ' + (r.stderr || '').trim().slice(0, 160) + ')');
  const report = JSON.parse(r.stdout);
  const hasProjcacheStep = (report.actions || []).some((a) => a.step === 'update_projcache_cwd');
  check(!hasProjcacheStep, 'migration no longer writes the projcache (R2: no fight with the live process)');

  // ---- simulate the live process's checkpoint write-back --------------------
  // (the migration leaves the projcache stale anyway; re-assert the old values
  //  to mirror the incident's overwrite explicitly)
  const pcP = path.join(home, 'storages', 'session_projcache.json');
  const pc = JSON.parse(fs.readFileSync(pcP, 'utf8'));
  pc.tables.sessions[sid].identity = { createdAt, cwd: oldCwd };
  fs.writeFileSync(pcP, JSON.stringify(pc, null, 2) + '\n');

  // ---- verify must FAIL with a problem (修复前失败) -------------------------
  const v1 = runCli(['--verify', '--from', newCwd]);
  const v1Report = JSON.parse(v1.stdout);
  check(v1.status !== 0 && v1Report.ok === false, '--verify fails on stale projcache (R1)');
  check(v1Report.problems.some((p) => p.includes('projcache identity cwd mismatch')), 'problem names the projcache cwd mismatch');
  check(Array.isArray(v1Report.manualChecks) && v1Report.manualChecks.some((m) => m.includes('45000 frames') && m.includes('signal timed out')), 'manual check names the largest session (R3)');

  // ---- live-dsh guard (only when a dsh web is actually listening) ----------
  const live = mig.detectLiveDsh();
  if (live.alive) {
    const guard = runCli(['--fix-projcache', '--from', newCwd]);
    check(guard.status !== 0 && /dsh web appears to be running/.test(guard.stderr), '--fix-projcache refuses while dsh web is live (' + live.detail + ')');
  } else {
    console.log('  SKIP  live-dsh guard (no dsh web detected in this environment)');
  }

  // ---- fix in the stopped window, then verify green (修复后通过) -------------
  const fix = runCli(['--fix-projcache', '--from', newCwd, '--force']);
  check(fix.status === 0, '--fix-projcache exit 0 (stderr: ' + (fix.stderr || '').trim().slice(0, 160) + ')');
  const fixReport = JSON.parse(fix.stdout);
  check(fixReport.ok === true && fixReport.aligned.length === 1, 'aligned the session identity');
  check(fixReport.aligned[0].createdAt === createdAt && fixReport.aligned[0].cwd === newCwd, 'identity aligned with cwd AND createdAt (header-authoritative)');
  const fixAgain = runCli(['--fix-projcache', '--from', newCwd, '--force']);
  check(fixAgain.status === 0, '--fix-projcache re-run succeeds (idempotent)');
  const v2 = runCli(['--verify', '--from', newCwd]);
  const v2Report = JSON.parse(v2.stdout);
  check(v2.status === 0 && v2Report.ok === true && v2Report.problems.length === 0, '--verify all green after --fix-projcache');

  // ---- cold-read smoke: full replay of the large log ------------------------
  const migratedLog = path.join(home, 'sessions', mig.projectKey(newCwd), mig.encodeSegment(sid), 'session.jsonl.zstd');
  const buf = fs.readFileSync(migratedLog);
  const t1 = Date.now();
  const { frames } = mig.scanZstdFrames(buf);
  let lines = 0;
  for (const f of frames) {
    const text = zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      JSON.parse(line); // same parse load as a projection cold rebuild
      lines++;
    }
  }
  const elapsed = Date.now() - t1;
  check(lines === LINES, 'cold replay preserved all ' + LINES + ' lines (' + lines + ')');
  check(elapsed < 30000, 'cold replay completes within budget (' + elapsed + 'ms; incident timeout was the failure mode)');
  check(frames.length === 45000, 'frame count preserved (' + frames.length + ')');

  console.log('\n' + (failures === 0 ? 'ALL TIMING CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  console.log('scratch home kept for inspection:', home);
}

main().catch((e) => { console.error(e.stack || e); failures++; }).finally(() => process.exit(failures === 0 ? 0 : 1));
