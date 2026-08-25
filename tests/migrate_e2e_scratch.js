#!/usr/bin/env node
/*
 * migrate_e2e_scratch.js — regression test for the DSH zstd frame invariant.
 *
 * Background: `dsh web` crashes on boot with "corrupt Zstandard session log:
 * first frame is not exactly one header line" when a session.jsonl.zstd has
 * been round-tripped as ONE frame (decompress → edit → compress whole log).
 * The migration script must never produce that layout, and must REPAIR it
 * when it meets one.
 *
 * This test builds a scratch DSH home with two workspaces:
 *   A) a validly framed session log (header frame + event frames),
 *   B) the same content collapsed into one frame (legacy corruption),
 * runs the real CLI (node lib/migrate_session.js ...) against both, then
 * asserts, for each migrated log:
 *   - frame 0 decompresses to EXACTLY one header line whose cwd is the new path
 *     (the same assertion `dsh web` boot performs),
 *   - every frame is independently valid,
 *   - for A: frames 1..n are byte-identical to the source (minimal diff),
 *   - for B: repaired=true and the full JSONL line set is preserved,
 * and for the scratch home:
 *   - workspace.json / session_projcache.json point at the new paths only,
 *   - sessions directories moved, transition symlinks in place,
 *   - backups written.
 *
 * Usage: node tests/migrate_e2e_scratch.js [real-session-log.jsonl.zstd]
 *   With an argument, fixture A is built from that real DSH session log
 *   (only its header cwd is patched; the event bytes are otherwise untouched).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'lib', 'migrate_session.js');
const mig = require(SCRIPT);
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

let failures = 0;
function check(cond, label) {
  if (cond) console.log('  PASS  ' + label);
  else { console.error('  FAIL  ' + label); failures++; }
}
function fail(err) { console.error(err && err.stack ? err.stack : String(err)); failures++; }

function buildHeaderLine(sid, cwd) {
  return JSON.stringify({
    type: 'session', version: 0, id: sid,
    createdAt: 1750000000000, cwd,
  });
}
function buildEventLines(n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ type: 'note', seq: i, time: 1750000000000 + i, data: { text: 'hello-' + i } }));
  }
  return lines;
}

async function main() {
  const args = process.argv.slice(2);
  const realLog = args.find((a) => !a.startsWith('--')) || undefined;
  const boot = args.includes('--boot');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mv-e2e-'));
  const backupDir = path.join(home, 'backups');
  const oldA = path.join(home, 'oldA');
  const newA = path.join(home, 'newA');
  const oldB = path.join(home, 'oldB');
  const newB = path.join(home, 'newB');
  const sidB = 'session-test-bbbb-0002';
  let sidA = 'session-test-aaaa-0001';
  console.log('scratch home:', home);

  const z = await mig.createZstd();

  // ---- fixture A: validly framed log ---------------------------------------
  let fixtureLines; // JSON lines without trailing newline
  if (realLog && fs.existsSync(realLog)) {
    const src = fs.readFileSync(realLog);
    const whole = (await z.decompressAll(src)).toString('utf8');
    fixtureLines = whole.split('\n');
    if (fixtureLines[fixtureLines.length - 1] === '') fixtureLines.pop();
    const hdr = JSON.parse(fixtureLines[0]);
    sidA = typeof hdr.id === 'string' && hdr.id ? hdr.id : sidA;
    hdr.cwd = oldA;
    fixtureLines[0] = JSON.stringify(hdr);
    console.log('fixture A source: real log,', fixtureLines.length, 'lines, sid=' + sidA);
  } else {
    fixtureLines = [buildHeaderLine(sidA, oldA), ...buildEventLines(40)];
    console.log('fixture A source: synthetic,', fixtureLines.length, 'lines');
  }
  // native layout: header frame + batch frames (multi-line batches are what
  // dsh's encodeMaterialization/encodeEventBatch produce)
  const framesA = [await z.compressFrame(Buffer.from(fixtureLines[0] + '\n', 'utf8'))];
  let i = 1;
  for (const batch of [3, 1, 5, 2, 4, 1, 3, 2, 4, 5, 2, 1, 4, 3]) {
    const batchLines = fixtureLines.slice(i, i + batch);
    if (batchLines.length === 0) break;
    framesA.push(await z.compressFrame(Buffer.from(batchLines.join('\n') + '\n', 'utf8')));
    i += batch;
  }
  for (; i < fixtureLines.length; i++) {
    framesA.push(await z.compressFrame(Buffer.from(fixtureLines[i] + '\n', 'utf8')));
  }
  const fixtureABytes = Buffer.concat(framesA);
  const sourceFrames = mig.scanZstdFrames(fixtureABytes).frames;
  console.log('fixture A: lines=' + fixtureLines.length + ' frames=' + sourceFrames.length + ' bytes=' + fixtureABytes.length);

  // ---- fixture B: same content collapsed into ONE frame (legacy bug) -------
  const bLines = fixtureLines.map((l) => {
    const obj = JSON.parse(l);
    if (obj.type === 'session') { obj.id = sidB; obj.cwd = oldB; }
    return JSON.stringify(obj);
  });
  const collapsed = zlib.zstdCompressSync(Buffer.from(bLines.join('\n') + '\n', 'utf8'), CHECKSUM_OPTIONS);
  console.log('fixture B: collapsed single frame, lines=' + bLines.length);

  // ---- scratch home state --------------------------------------------------
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const projKey = (p) => mig.projectKey(p);
  const dirA = path.join(home, 'sessions', projKey(oldA), mig.encodeSegment(sidA));
  const dirB = path.join(home, 'sessions', projKey(oldB), mig.encodeSegment(sidB));
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(path.join(dirA, 'session.jsonl.zstd'), fixtureABytes);
  fs.writeFileSync(path.join(dirB, 'session.jsonl.zstd'), collapsed);
  fs.mkdirSync(oldA, { recursive: true });
  fs.writeFileSync(path.join(oldA, 'marker.txt'), 'oldA');
  fs.mkdirSync(oldB, { recursive: true });
  fs.writeFileSync(path.join(oldB, 'marker.txt'), 'oldB');

  const ws = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['wsA', 'wsB'], archivedSessionIds: [] },
    tables: { workspaces: {
      wsA: { path: oldA, title: 'Old A', sessionIds: [sidA], createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z' },
      wsB: { path: oldB, title: 'Old B', sessionIds: [sidB], createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z' },
    } },
  };
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify(ws, null, 2) + '\n');
  const projcache = {
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: { sessions: {
      [sidA]: { identity: { createdAt: 1750000000000, cwd: oldA }, rows: {} },
      [sidB]: { identity: { createdAt: 1750000000000, cwd: oldB }, rows: {} },
    } },
  };
  fs.writeFileSync(path.join(home, 'storages', 'session_projcache.json'), JSON.stringify(projcache, null, 2) + '\n');

  // ---- run the real CLI ----------------------------------------------------
  function runCli(from, to) {
    return spawnSync(process.execPath, [
      SCRIPT, '--from', from, '--to', to, '--mkdir', '--yes',
      '--dsh-home', home, '--backup-dir', backupDir,
    ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  }

  console.log('\n== migrate A (valid frames) ==');
  const rA = runCli(oldA, newA);
  check(rA.status === 0, 'CLI A exit 0 (stderr: ' + (rA.stderr || '').trim().slice(0, 200) + ')');
  let reportA = null;
  try { reportA = JSON.parse(rA.stdout); } catch (e) { fail('CLI A stdout is not JSON: ' + e.message); }
  if (reportA) {
    check(reportA.ok === true, 'CLI A report ok');
    const rh = (reportA.actions || []).find((a) => a.step === 'rewrite_header');
    check(!!rh && rh.repaired === false, 'A rewrite used the minimal frame-0 path (repaired=false)');
    check(!!rh && rh.frameCount === sourceFrames.length, 'A frame count unchanged (' + (rh && rh.frameCount) + ' == ' + sourceFrames.length + ')');
  }

  console.log('\n== migrate B (collapsed single frame) ==');
  const rB = runCli(oldB, newB);
  check(rB.status === 0, 'CLI B exit 0 (stderr: ' + (rB.stderr || '').trim().slice(0, 200) + ')');
  let reportB = null;
  try { reportB = JSON.parse(rB.stdout); } catch (e) { fail('CLI B stdout is not JSON: ' + e.message); }
  if (reportB) {
    check(reportB.ok === true, 'CLI B report ok');
    const rh = (reportB.actions || []).find((a) => a.step === 'rewrite_header');
    check(!!rh && rh.repaired === true, 'B rewrite repaired the collapsed frame (repaired=true)');
  }

  // ---- verify the DSH boot invariant on the migrated logs ------------------
  async function assertBootable(logPath, newCwd, label) {
    const buf = fs.readFileSync(logPath);
    const { frames } = mig.scanZstdFrames(buf);
    check(frames.length > 0, label + ': has frames');
    const first = (await z.decompressFrame(buf.subarray(frames[0].start, frames[0].end))).toString('utf8');
    check(mig.isExactlyOneHeaderLine(first), label + ': frame 0 is exactly one header line (dsh boot assertion)');
    let hdr = null;
    try { hdr = JSON.parse(first.slice(0, -1)); } catch (e) { /* checked below */ }
    check(hdr && hdr.cwd === newCwd, label + ': header cwd == ' + newCwd + ' (got ' + (hdr && hdr.cwd) + ')');
    let allValid = true;
    for (const f of frames) {
      try { await z.decompressFrame(buf.subarray(f.start, f.end)); } catch (e) { allValid = false; }
    }
    check(allValid, label + ': every frame independently valid');
    return { buf, frames };
  }

  const logANew = path.join(home, 'sessions', projKey(newA), mig.encodeSegment(sidA), 'session.jsonl.zstd');
  const logBNew = path.join(home, 'sessions', projKey(newB), mig.encodeSegment(sidB), 'session.jsonl.zstd');
  const a = await assertBootable(logANew, newA, 'A migrated log');
  await assertBootable(logBNew, newB, 'B migrated log');

  // A: frames 1..n byte-identical to the source (minimal diff)
  if (a.frames.length === sourceFrames.length && sourceFrames.length > 1) {
    const tailIdentical = fixtureABytes.subarray(sourceFrames[1].start).equals(a.buf.subarray(a.frames[1].start));
    check(tailIdentical, 'A: event frames 1..n byte-identical to source');
  } else {
    check(a.frames.length === sourceFrames.length, 'A: frame count matches source');
  }

  // B: line set preserved through repair
  const bText = (await z.decompressAll(fs.readFileSync(logBNew))).toString('utf8');
  const bLinesAfter = bText.split('\n').filter((l) => l.trim());
  check(bLinesAfter.length === bLines.length, 'B: repair preserved every line (' + bLinesAfter.length + ' == ' + bLines.length + ')');
  check(bLinesAfter[0].includes(sidB), 'B: header line is the session header');

  // ---- scratch-home state --------------------------------------------------
  const wsAfter = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
  const paths = Object.values(wsAfter.tables.workspaces).map((r) => r.path);
  check(paths.includes(newA) && paths.includes(newB) && !paths.includes(oldA) && !paths.includes(oldB), 'workspace.json: only new paths remain');
  check(wsAfter.global.workspaceIds.length === 2, 'workspace.json: workspaceIds consistent');

  const pcAfter = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'session_projcache.json'), 'utf8'));
  check(pcAfter.tables.sessions[sidA].identity.cwd === newA, 'projcache A identity.cwd == newA');
  check(pcAfter.tables.sessions[sidB].identity.cwd === newB, 'projcache B identity.cwd == newB');

  check(fs.existsSync(path.join(newA, 'marker.txt')), 'disk dir moved: newA/marker.txt exists');
  check(fs.existsSync(path.join(newB, 'marker.txt')), 'disk dir moved: newB/marker.txt exists');
  const stA = fs.lstatSync(oldA);
  const stB = fs.lstatSync(oldB);
  check(stA.isSymbolicLink() && fs.realpathSync(oldA) === fs.realpathSync(newA), 'transition symlink oldA -> newA');
  check(stB.isSymbolicLink() && fs.realpathSync(oldB) === fs.realpathSync(newB), 'transition symlink oldB -> newB');

  const oldProjA = path.join(home, 'sessions', projKey(oldA));
  const oldProjB = path.join(home, 'sessions', projKey(oldB));
  check(fs.lstatSync(oldProjA).isSymbolicLink(), 'sessions old projectKey A is a symlink');
  check(fs.lstatSync(oldProjB).isSymbolicLink(), 'sessions old projectKey B is a symlink');

  const backups = fs.readdirSync(backupDir);
  check(backups.length === 2, 'two backup snapshots written (' + backups.length + ')');

  // cross-implementation check: system zstd CLI validates the migrated logs
  if (!spawnSync('zstd', ['--version'], { stdio: 'ignore' }).error) {
    for (const [p, label] of [[logANew, 'A'], [logBNew, 'B']]) {
      const t = spawnSync('zstd', ['-t', p], { encoding: 'utf8' });
      check(t.status === 0, label + ': zstd -t validates migrated log');
    }
  }

  // ---- optional: boot a real dsh web against the migrated home -------------
  if (boot) {
    const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const profDir = path.join(home, 'profiles', 'web');
    fs.mkdirSync(profDir, { recursive: true });
    for (const f of ['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']) {
      fs.copyFileSync(path.join(realHome, 'profiles', 'web', f), path.join(profDir, f));
    }
    fs.symlinkSync(path.join(realHome, 'profiles', 'node_modules'), path.join(home, 'profiles', 'node_modules'));
    // pnpm puts workspace-package deps (like a link: plugin) under
    // profiles/<name>/node_modules — mirror that layer too
    const realPkgNodeModules = path.join(realHome, 'profiles', 'web', 'node_modules');
    if (fs.existsSync(realPkgNodeModules)) {
      fs.symlinkSync(realPkgNodeModules, path.join(profDir, 'node_modules'));
    }
    const port = 3200 + (process.pid % 400);
    const child = spawn('dsh', ['web', '--port', String(port), '--host', '127.0.0.1'], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bootLog = '';
    child.stdout.on('data', (d) => { bootLog += d; });
    child.stderr.on('data', (d) => { bootLog += d; });
    let ok = false;
    for (let t = 0; t < 40 && !ok && child.exitCode === null; t++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/');
        if (res.status === 200) ok = true;
      } catch (e) { /* not up yet */ }
    }
    check(ok, 'dsh web boots against the migrated scratch home (HTTP 200 on port ' + port + ')');
    if (!ok) {
      console.error('---- boot log tail ----\n' + bootLog.slice(-2500));
    } else {
      console.log('  (booted a real dsh web on port ' + port + ' against the migrated home, then stopped it)');
    }
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  console.log('scratch home kept for inspection:', home);
}

main().catch((e) => { fail(e); }).finally(() => process.exit(failures === 0 ? 0 : 1));
