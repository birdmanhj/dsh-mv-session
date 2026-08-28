#!/usr/bin/env node
/*
 * migrate_edge_cases.js — edge-case regression tests (README 测试清单第 4 项):
 *   1. target path already has a workspace record  -> sessionIds merged, old record dropped
 *   2. --from is a symlink                        -> real target moved, link replaced by transition link
 *   3. no zstd CLI on PATH                        -> native node:zlib backend still works;
 *      and with node:zlib zstd removed            -> createZstd() returns null (script errors clearly)
 *   4. --session locating mode                    -> workspace located via projcache identity.cwd
 * Every case runs on its own scratch DSH home through the real CLI.
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

function headerLine(sid, cwd) {
  return JSON.stringify({ type: 'session', version: 0, id: sid, createdAt: 1750000000000, cwd: cwd });
}
function eventLines(n) {
  return Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'note', seq: i, time: 1750000000000 + i, data: { text: 'e' + i } }));
}
function makeLog(sid, cwd, eventCount) {
  const lines = [headerLine(sid, cwd), ...eventLines(eventCount)];
  return Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(lines[0] + '\n', 'utf8'), CHECKSUM_OPTIONS),
    ...lines.slice(1).map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8'), CHECKSUM_OPTIONS)),
  ]);
}
function makeHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mv-edge-')); }
function writeWs(home, workspaces, workspaceIds) {
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds, archivedSessionIds: [] },
    tables: { workspaces },
  }, null, 2) + '\n');
}
function writeProjcache(home, sessions) {
  fs.writeFileSync(path.join(home, 'storages', 'session_projcache.json'), JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: { sessions },
  }, null, 2) + '\n');
}
function placeLog(home, cwd, sid, logBuf) {
  const dir = path.join(home, 'sessions', mig.projectKey(cwd), mig.encodeSegment(sid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), logBuf);
}
function runCli(home, argv, envExtra = {}) {
  return spawnSync(process.execPath, [SCRIPT, '--dsh-home', home, ...argv, '--yes'], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, ...envExtra },
  });
}

async function caseMerge() {
  console.log('\n== case 1: target path already has a workspace record (merge) ==');
  const home = makeHome();
  const oldCwd = path.join(home, 'oldW');
  const newCwd = path.join(home, 'newW');
  const sidReal = 'session-merge-real';
  const sidEmpty = 'session-merge-empty';
  fs.mkdirSync(oldCwd, { recursive: true });
  fs.mkdirSync(newCwd, { recursive: true });
  fs.writeFileSync(path.join(oldCwd, 'old-marker.txt'), 'old');
  fs.writeFileSync(path.join(newCwd, 'target-marker.txt'), 'target');
  writeWs(home, {
    wsOld: { path: oldCwd, title: 'Old', sessionIds: [sidReal], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    wsTarget: { path: newCwd, title: 'Target', sessionIds: [sidEmpty], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  }, ['wsOld', 'wsTarget']);
  writeProjcache(home, {
    [sidReal]: { identity: { createdAt: 1750000000000, cwd: oldCwd }, rows: {} },
    [sidEmpty]: { identity: { createdAt: 1750000000000, cwd: newCwd }, rows: {} },
  });
  placeLog(home, oldCwd, sidReal, makeLog(sidReal, oldCwd, 10));
  // auto-created empty session at target: header + a couple of events (<= 6 lines)
  const emptyLog = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(headerLine(sidEmpty, newCwd) + '\n', 'utf8'), CHECKSUM_OPTIONS),
    zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'permission/preset', seq: 0, time: 1, data: {} }) + '\n', 'utf8'), CHECKSUM_OPTIONS),
  ]);
  placeLog(home, newCwd, sidEmpty, emptyLog);

  // refusal first: non-empty target without --merge-dir
  const refused = runCli(home, ['--from', oldCwd, '--to', newCwd]);
  check(refused.status !== 0 && /not empty.*--merge-dir/.test(refused.stderr), 'non-empty target refused without --merge-dir (' + (refused.stderr || '').trim().slice(0, 120) + ')');
  check(fs.existsSync(path.join(oldCwd, 'old-marker.txt')), 'nothing moved on refusal');

  const r = runCli(home, ['--from', oldCwd, '--to', newCwd, '--title', 'Merged', '--merge-dir']);
  check(r.status === 0, 'CLI exit 0 with --merge-dir (stderr: ' + (r.stderr || '').trim().slice(0, 160) + ')');
  check(fs.existsSync(path.join(newCwd, 'old-marker.txt')) && fs.existsSync(path.join(newCwd, 'target-marker.txt')), 'contents merged into target dir');
  check(!fs.existsSync(oldCwd) || fs.lstatSync(oldCwd).isSymbolicLink(), 'old dir gone (transition link in place)');
  const ws = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
  check(!ws.tables.workspaces.wsOld, 'old record dropped');
  check(ws.tables.workspaces.wsTarget && ws.tables.workspaces.wsTarget.sessionIds.includes(sidReal), 'real sessionId merged into target record');
  check(ws.tables.workspaces.wsTarget && !ws.tables.workspaces.wsTarget.sessionIds.includes(sidEmpty), 'empty session dropped from target record');
  check(ws.global.workspaceIds.length === 1 && ws.global.workspaceIds[0] === 'wsTarget', 'workspaceIds pruned to target');
  const emptyDir = path.join(home, 'sessions', mig.projectKey(newCwd), mig.encodeSegment(sidEmpty));
  check(!fs.existsSync(emptyDir), 'empty session dir removed');
  const pc = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'session_projcache.json'), 'utf8'));
  check(pc.tables.sessions[sidReal] && pc.tables.sessions[sidReal].identity.cwd === oldCwd, 'projcache NOT written during migration (R2: aligned later, with dsh stopped)');
  check(pc.tables.sessions[sidEmpty] && pc.tables.sessions[sidEmpty].identity.cwd === newCwd, 'empty-session projcache entry stays until --fix-projcache (header-authoritative cleanup)');
  // close the loop: --fix-projcache aligns identity AND removes the orphan
  const fixR = runCli(home, ['--fix-projcache', '--from', newCwd, '--force']);
  check(fixR.status === 0, '--fix-projcache exit 0 after merge (stderr: ' + (fixR.stderr || '').trim().slice(0, 160) + ')');
  const fixReport = JSON.parse(fixR.stdout);
  check(fixReport.aligned.some((a) => a.sid === sidReal && a.cwd === newCwd), 'real session identity aligned to newCwd');
  check(fixReport.removedOrphans.includes(sidEmpty), 'orphan empty-session entry removed by --fix-projcache');
  const pc2 = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'session_projcache.json'), 'utf8'));
  check(pc2.tables.sessions[sidReal].identity.cwd === newCwd && !pc2.tables.sessions[sidEmpty], 'projcache aligned after --fix-projcache');
  const migratedLog = path.join(home, 'sessions', mig.projectKey(newCwd), mig.encodeSegment(sidReal), 'session.jsonl.zstd');
  const buf = fs.readFileSync(migratedLog);
  const { frames } = mig.scanZstdFrames(buf);
  const f0 = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
  check(mig.isExactlyOneHeaderLine(f0) && JSON.parse(f0.slice(0, -1)).cwd === newCwd, 'migrated log frame invariant holds');
}

async function caseSymlinkFrom() {
  console.log('\n== case 2: --from is a symlink ==');
  const home = makeHome();
  const realCwd = path.join(home, 'realW');
  const linkCwd = path.join(home, 'linkW');
  const newCwd = path.join(home, 'newW');
  const sid = 'session-symlink';
  fs.mkdirSync(realCwd, { recursive: true });
  fs.writeFileSync(path.join(realCwd, 'marker.txt'), 'real');
  fs.symlinkSync(realCwd, linkCwd);
  writeWs(home, {
    ws1: { path: realCwd, title: 'Real', sessionIds: [sid], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  }, ['ws1']);
  writeProjcache(home, { [sid]: { identity: { createdAt: 1750000000000, cwd: realCwd }, rows: {} } });
  placeLog(home, realCwd, sid, makeLog(sid, realCwd, 8));

  const r = runCli(home, ['--from', linkCwd, '--to', newCwd, '--mkdir']);
  check(r.status === 0, 'CLI exit 0 (stderr: ' + (r.stderr || '').trim().slice(0, 160) + ')');
  check(fs.existsSync(path.join(newCwd, 'marker.txt')), 'real dir moved to target');
  const st = fs.lstatSync(linkCwd);
  check(st.isSymbolicLink() && fs.realpathSync(linkCwd) === fs.realpathSync(newCwd), 'old symlink replaced by transition link -> target');
  const ws = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
  check(ws.tables.workspaces.ws1.path === newCwd, 'record path updated to real target');
  // session dir must be located via the RECORD's real path, not the symlink
  const migratedLog = path.join(home, 'sessions', mig.projectKey(newCwd), mig.encodeSegment(sid), 'session.jsonl.zstd');
  check(fs.existsSync(migratedLog), 'session log migrated (located via record real path)');
  const buf = fs.readFileSync(migratedLog);
  const { frames } = mig.scanZstdFrames(buf);
  const f0 = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
  check(mig.isExactlyOneHeaderLine(f0) && JSON.parse(f0.slice(0, -1)).cwd === newCwd, 'symlink case: frame invariant holds');
  const oldProj = path.join(home, 'sessions', mig.projectKey(realCwd));
  check(fs.lstatSync(oldProj).isSymbolicLink(), 'old projectKey dir replaced by symlink');
}

async function caseNoZstdCli() {
  console.log('\n== case 3: no zstd CLI ==');
  const home = makeHome();
  const oldCwd = path.join(home, 'oldW');
  const newCwd = path.join(home, 'newW');
  const sid = 'session-nozstd';
  fs.mkdirSync(oldCwd, { recursive: true });
  fs.writeFileSync(path.join(oldCwd, 'marker.txt'), 'x');
  writeWs(home, { ws1: { path: oldCwd, title: 'O', sessionIds: [sid], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } }, ['ws1']);
  writeProjcache(home, { [sid]: { identity: { createdAt: 1750000000000, cwd: oldCwd }, rows: {} } });
  placeLog(home, oldCwd, sid, makeLog(sid, oldCwd, 6));
  // PATH without /usr/local/bin (where zstd lives) — native node:zlib must carry the load
  const strippedPath = process.env.PATH.split(path.delimiter).filter((p) => !p.includes('/usr/local')).join(path.delimiter);
  const r = runCli(home, ['--from', oldCwd, '--to', newCwd, '--mkdir'], { PATH: strippedPath });
  check(r.status === 0, 'migration works without zstd CLI (native node:zlib; stderr: ' + (r.stderr || '').trim().slice(0, 160) + ')');
  const migratedLog = path.join(home, 'sessions', mig.projectKey(newCwd), mig.encodeSegment(sid), 'session.jsonl.zstd');
  const buf = fs.readFileSync(migratedLog);
  const { frames } = mig.scanZstdFrames(buf);
  const f0 = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
  check(mig.isExactlyOneHeaderLine(f0) && JSON.parse(f0.slice(0, -1)).cwd === newCwd, 'frame invariant holds without CLI');
  // error branch: with every backend unavailable, createZstd() must return null
  const probe = spawnSync(process.execPath, ['-e', `
    const m = require(${JSON.stringify(SCRIPT)});
    const z = m.createZstd({
      zlib: { zstdCompressSync: undefined, zstdDecompressSync: undefined },
      spawnFn: () => ({ error: new Error('ENOENT') }),
      candidates: ['/nonexistent'],
    });
    console.log('backend:', z ? z.kind : 'null');
  `], { encoding: 'utf8' });
  check(probe.status === 0 && /backend: null/.test(probe.stdout), 'createZstd() returns null when every backend is unavailable (' + probe.stdout.trim() + ')');
}

async function caseSessionLocate() {
  console.log('\n== case 4: --session locating mode ==');
  const home = makeHome();
  const oldCwd = path.join(home, 'oldW');
  const newCwd = path.join(home, 'newW');
  const sid = 'session-locate-1';
  fs.mkdirSync(oldCwd, { recursive: true });
  fs.writeFileSync(path.join(oldCwd, 'marker.txt'), 'locate');
  writeWs(home, { ws1: { path: oldCwd, title: 'O', sessionIds: [sid], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } }, ['ws1']);
  writeProjcache(home, { [sid]: { identity: { createdAt: 1750000000000, cwd: oldCwd }, rows: {} } });
  placeLog(home, oldCwd, sid, makeLog(sid, oldCwd, 6));

  const r = runCli(home, ['--session', sid, '--to', newCwd, '--mkdir']);
  check(r.status === 0, 'CLI exit 0 (stderr: ' + (r.stderr || '').trim().slice(0, 160) + ')');
  const report = JSON.parse(r.stdout);
  check(report.migrated && report.migrated.from === oldCwd, 'workspace located via --session (' + report.migrated.from + ')');
  check(fs.existsSync(path.join(newCwd, 'marker.txt')), 'disk dir moved');
  const ws = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
  check(ws.tables.workspaces.ws1.path === newCwd, 'record path updated');

  // --verify after migration: the migration intentionally no longer writes the
  // projcache (live write-back would clobber it), so the stale identity must
  // now surface as a PROBLEM until --fix-projcache runs in the stopped window.
  const v = runCli(home, ['--verify', '--from', newCwd]);
  const vReport = JSON.parse(v.stdout);
  check(v.status !== 0 && vReport.ok === false && vReport.problems.some((p) => p.includes('projcache identity cwd mismatch')), '--verify: stale projcache is a PROBLEM right after migration (R1)');
  check(Array.isArray(vReport.checks) && vReport.checks.some((c) => c.check === 'session log'), '--verify: session log checked');
  check(Array.isArray(vReport.manualChecks) && vReport.manualChecks.some((m) => m.includes('signal timed out')), 'verify emits the cold-read manual check (R3)');
  // R2: --fix-projcache (idempotent; --force because the harness dsh is live)
  const fix1 = runCli(home, ['--fix-projcache', '--from', newCwd, '--force']);
  check(fix1.status === 0, '--fix-projcache exit 0 (stderr: ' + (fix1.stderr || '').trim().slice(0, 160) + ')');
  const fixReport = JSON.parse(fix1.stdout);
  check(fixReport.ok === true && fixReport.aligned.length === 1 && fixReport.aligned[0].cwd === newCwd, '--fix-projcache aligned the identity (cwd+createdAt)');
  const fix2 = runCli(home, ['--fix-projcache', '--from', newCwd, '--force']);
  check(fix2.status === 0, '--fix-projcache re-run exit 0 (idempotent)');
  const v3 = runCli(home, ['--verify', '--from', newCwd]);
  const v3Report = JSON.parse(v3.stdout);
  check(v3.status === 0 && v3Report.ok === true && v3Report.problems.length === 0, '--verify all green after --fix-projcache');
}

async function caseGuards() {
  console.log('\n== case 5: same-dir guard + preflight fail-fast ==');
  const home = makeHome();
  const cwd = path.join(home, 'ws');
  const sid = 'session-guard';
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'marker.txt'), 'x');
  writeWs(home, { ws1: { path: cwd, title: 'W', sessionIds: [sid], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } }, ['ws1']);
  writeProjcache(home, { [sid]: { identity: { createdAt: 1750000000000, cwd: cwd }, rows: {} } });
  placeLog(home, cwd, sid, makeLog(sid, cwd, 4));

  // 5a: from === to
  const rSame = runCli(home, ['--from', cwd, '--to', cwd]);
  check(rSame.status !== 0 && /same directory/.test(rSame.stderr), 'same-dir refused with clear error (' + (rSame.stderr || '').trim().slice(0, 100) + ')');
  check(fs.existsSync(path.join(cwd, 'marker.txt')), 'nothing moved on same-dir refusal');

  // 5b: corrupt log -> preflight aborts BEFORE any mutation (no backup dir, dir untouched)
  const logPath = path.join(home, 'sessions', mig.projectKey(cwd), mig.encodeSegment(sid), 'session.jsonl.zstd');
  const good = fs.readFileSync(logPath);
  fs.writeFileSync(logPath, Buffer.concat([good.subarray(0, 60), Buffer.from('GARBAGE')]));
  const newCwd = path.join(home, 'newW');
  const backupDir = path.join(home, 'backups');
  const rBad = runCli(home, ['--from', cwd, '--to', newCwd, '--mkdir', '--backup-dir', backupDir]);
  check(rBad.status !== 0 && /preflight failed/.test(rBad.stderr), 'preflight aborts on corrupt log (' + (rBad.stderr || '').trim().slice(0, 100) + ')');
  check(fs.existsSync(path.join(cwd, 'marker.txt')) && !fs.existsSync(newCwd), 'nothing moved on preflight failure');
  check(!fs.existsSync(backupDir), 'no backup written on preflight failure (fail before first mutation)');
  const ws = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
  check(ws.tables.workspaces.ws1.path === cwd, 'registry untouched on preflight failure');
  // collapsed single-frame logs must still PASS preflight (repairable)
  {
    const z = await mig.createZstd();
    const whole = await z.decompressAll(good);
    fs.writeFileSync(logPath, zlib.zstdCompressSync(whole, CHECKSUM_OPTIONS));
  }
  const rOk = runCli(home, ['--from', cwd, '--to', newCwd, '--mkdir', '--backup-dir', backupDir]);
  check(rOk.status === 0, 'collapsed (repairable) log passes preflight and migrates (stderr: ' + (rOk.stderr || '').trim().slice(0, 120) + ')');
  const report = JSON.parse(rOk.stdout);
  const rh = (report.actions || []).find((a) => a.step === 'rewrite_header');
  check(rh && rh.repaired === true, 'collapsed log repaired during migration (repaired=true)');
}

async function main() {
  await caseMerge();
  await caseSymlinkFrom();
  await caseNoZstdCli();
  await caseSessionLocate();
  await caseGuards();
  console.log('\n' + (failures === 0 ? 'ALL EDGE CASES PASSED' : failures + ' CHECK(S) FAILED'));
}

main().catch((e) => { console.error(e.stack || e); failures++; }).finally(() => process.exit(failures === 0 ? 0 : 1));
