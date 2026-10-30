import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { INSPECT_JS, judge, parseJsonLines, readRestartLog } from './live/restart.mjs';

// The pure parts of the AC12 restart procedure (tests/sandbox/live/restart.mjs): what it requires of the picture before the kill and the
// picture after the restart. The procedure itself needs the deployed Box.

const MARKER = 'abcDEF0123456789ghijKL';
const blocker = (kind, attempt, state, extra = {}) => ({ resource_id: `${kind}-${attempt}`, execution_id: `E-${attempt}`, attempt_id: attempt, kind, release_state: state, process_bearing: 0, locator: JSON.stringify(kind === 'process-tree' ? { marker: MARKER } : {}), identity: '{}', ...extra });
const before = () => ({
    processes: [{ pid: 700, start: '7000', state: 'S', cmdline: ['/usr/bin/bwrap', '--unshare-uts', '--unsetenv', MARKER] }, { pid: 21, start: '21', state: 'S', cmdline: ['node', '/code/server/main.mjs'] }],
    main: { pid: 21, start: '21' },
    net: { netns: ['rw1111111111111111'], links: ['rw1111111111h'], tables: ['rw_1111111111111111'] },
    runtimeDirs: ['aaaa'],
    db: {
        generations: [{ id: 'G1', state: 'active', prior_id: null, recovery_pending: 0 }],
        attempts: [{ execution_id: 'E-A1', attempt_id: 'A1', robot_id: 'R', state: 'running', generation_id: 'G1' }],
        blockers: [blocker('keeper', 'A1', 'committed'), blocker('process-tree', 'A1', 'committed'), blocker('netns', 'A1', 'committed', { identity: JSON.stringify({ name: 'rw1111111111111111', host: 'rw1111111111h', peer: 'rw1111111111n', table: 'rw_1111111111111111' }) })]
    }
});
const clean = () => ({
    processes: [{ pid: 21, start: '9999', state: 'S', cmdline: ['node', '/code/server/main.mjs'] }],
    main: { pid: 21, start: '9999' },
    net: { netns: [], links: [], tables: [] }, runtimeDirs: [],
    db: {
        generations: [{ id: 'G1', state: 'retired', prior_id: null, recovery_pending: 0 }, { id: 'G2', state: 'active', prior_id: 'G1', recovery_pending: 0 }],
        attempts: [{ execution_id: 'E-A1', attempt_id: 'A1', robot_id: 'R', state: 'interrupted', generation_id: 'G1' }],
        blockers: [blocker('keeper', 'A1', 'released'), blocker('process-tree', 'A1', 'released'), blocker('netns', 'A1', 'released')]
    }
});
const log = { listening: { event: 'listening', recovered: true, at: '2026-10-31T10:00:05.000Z' }, recovery: [], events: 3 };

test('a clean restart passes every check', () => {
    const result = judge({ before: before(), after: clean(), log, restartedBy: 'container-restart' });
    assert.deepEqual(result.failed, []);
    assert.equal(result.pass, true);
    assert.ok(Object.keys(result.checks).length >= 10);
});

test('each failure is named: still running, blocker committed, quarantined, leftovers, a surviving marker process, no recovered:true, not restarted', () => {
    const run = (mutate, restartedBy = 'container-restart', logOverride = log) => { const after = clean(); mutate(after); return judge({ before: before(), after, log: logOverride, restartedBy }).failed; };
    assert.ok(run((a) => { a.db.attempts[0].state = 'stopping'; }).some((name) => name.includes('interrupted')));
    assert.ok(run((a) => { a.db.blockers[1].release_state = 'committed'; }).some((name) => name.includes('released')));
    assert.ok(run((a) => { a.db.blockers[1].release_state = 'quarantined'; }).some((name) => name.includes('released')), 'quarantined is not released');
    assert.ok(run((a) => { a.db.blockers[2].release_state = 'committed'; }).some((name) => name.includes('unsettled')));
    assert.ok(run((a) => { a.db.generations[1].recovery_pending = 1; }).some((name) => name.includes('recovery-pending')));
    assert.ok(run((a) => { a.net.netns = ['rw1111111111111111']; }).some((name) => name.includes('network')));
    assert.ok(run((a) => { a.net.links = ['rw1111111111h']; }).some((name) => name.includes('network')));
    assert.ok(run((a) => { a.net.tables = ['rw_1111111111111111']; }).some((name) => name.includes('network')));
    assert.ok(run((a) => { a.runtimeDirs = ['aaaa']; }).some((name) => name.includes('runtime')));
    assert.ok(run((a) => { a.processes.push({ pid: 888, start: '1', state: 'S', cmdline: ['/usr/bin/bwrap', MARKER] }); }).some((name) => name.includes('marker')));
    assert.ok(run((a) => { a.processes.push({ pid: 700, start: '7000', state: 'S', cmdline: ['whatever'] }); }).some((name) => name.includes('alive')));
    assert.ok(run(() => {}, 'none').some((name) => name.includes('restarted')));
    assert.ok(run(() => {}, 'container-restart', { ...log, listening: { ...log.listening, recovered: false } }).some((name) => name.includes('recovered:true')));
    assert.ok(run(() => {}, 'container-restart', { ...log, listening: null }).some((name) => name.includes('recovered:true')));
});

test('a recycled pid with a different start time is not "the old process alive"; a NEW attempt\'s network is not a leftover', () => {
    const after = clean();
    after.processes.push({ pid: 700, start: '55555', state: 'S', cmdline: ['/usr/bin/sleep'] });
    after.db.attempts.push({ execution_id: 'E-B1', attempt_id: 'B1', robot_id: 'R', state: 'running', generation_id: 'G2' });
    after.db.blockers.push(blocker('netns', 'B1', 'committed', { identity: JSON.stringify({ name: 'rw2222222222222222', host: 'rw2222222222h', peer: 'rw2222222222n', table: 'rw_2222222222222222' }) }));
    after.net = { netns: ['rw2222222222222222'], links: ['rw2222222222h'], tables: ['rw_2222222222222222'] };
    assert.deepEqual(judge({ before: before(), after, log, restartedBy: 'process-restart' }).failed, []);
    // but the OLD network named in the new picture is a leftover even when a new attempt exists
    after.net.netns.push('rw1111111111111111');
    assert.ok(judge({ before: before(), after, log, restartedBy: 'process-restart' }).failed.some((name) => name.includes('network')));
});

test('no running attempt at the kill is a failed check, so a restart with nothing to interrupt cannot pass', () => {
    const idle = before();
    idle.db.attempts[0].state = 'completed';
    assert.ok(judge({ before: idle, after: clean(), log, restartedBy: 'container-restart' }).failed.includes('an attempt was running at the kill'));
});

test('readRestartLog takes the restart\'s own `listening` line (after the kill) and the recovery events; parseJsonLines ignores non-JSON', () => {
    const text = [
        '{"at":"2026-10-31T09:00:00.000Z","event":"listening","recovered":true}',
        'not json',
        '{"at":"2026-10-31T10:00:02.000Z","event":"attempt_end","executionId":"E","classification":"interrupted"}',
        '{"at":"2026-10-31T10:00:05.000Z","event":"listening","recovered":true,"coordinatorPort":7000}'
    ].join('\n');
    const result = readRestartLog(text, '2026-10-31T10:00:00.000Z');
    assert.equal(result.listening.coordinatorPort, 7000, 'the earlier listening line (before the kill) is not the restart');
    assert.deepEqual(result.recovery.map((event) => event.event), ['attempt_end']);
    assert.equal(parseJsonLines('x\n{"a":1}\n[]\n').length, 1);
    assert.equal(readRestartLog('', 'x').listening, null);
});

test('the in-worker inspector is valid JavaScript and prints one JSON document (here: no worker store)', () => {
    const run = spawnSync(process.execPath, ['--no-warnings', '-e', INSPECT_JS], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const picture = JSON.parse(run.stdout.trim().split('\n').at(-1));
    assert.ok(Array.isArray(picture.processes) && picture.processes.length > 0);
    assert.ok(picture.main === null || (Number.isInteger(picture.main.pid) && typeof picture.main.start === 'string'), 'main is null or { pid, start } (a host that can see a worker has one)');
    assert.deepEqual(picture.db, { error: 'store unreadable' });
    assert.ok(Array.isArray(picture.net.netns) && Array.isArray(picture.runtimeDirs));
});

// ---- the procedure's control flow against a FAKE podman (no Box needed): wait for an attempt, kill, detect the restart, verify ----------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const RESTART = fileURLToPath(new URL('./live/restart.mjs', import.meta.url));

function fakePodman(t, { restarts = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-fakepodman-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const state = path.join(dir, 'state.json');
    fs.writeFileSync(state, JSON.stringify({ killed: false, restarts }));
    fs.writeFileSync(path.join(dir, 'before.json'), JSON.stringify({ at: 'x', ...before() }));
    fs.writeFileSync(path.join(dir, 'after.json'), JSON.stringify({ at: 'y', ...clean() }));
    fs.writeFileSync(path.join(dir, 'podman'), `#!${process.execPath}
const fs = require('fs'); const zlib = require('zlib');
const dir = ${JSON.stringify(dir)}; const state = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8'));
const argv = process.argv.slice(2); const gz = (text) => process.stdout.write(zlib.gzipSync(text).toString('base64'));
const joined = argv.join(' ');
if (argv[0] === 'exec' && argv[2] === 'podman' && argv[3] === 'inspect') {
    const restarted = state.killed && state.restarts;
    process.stdout.write('running|' + (restarted ? '2026-10-31T10:00:03Z' : '2026-10-31T09:00:00Z') + '|' + (restarted ? 1 : 0) + '\\n');
} else if (argv[0] === 'exec' && argv[2] === 'podman' && argv[3] === 'logs') {
    process.stdout.write(state.killed && state.restarts ? JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), event: 'listening', recovered: true }) + '\\n' + JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), event: 'attempt_end', classification: 'interrupted' }) + '\\n' : '');
} else if (argv[0] === 'exec' && argv[2] === 'podman' && argv[3] === 'exec') {
    const command = argv[argv.length - 1];
    if (command.includes('base64 -d | gunzip')) process.exit(0);
    if (command.includes('/tmp/.rsinspect.js')) gz(fs.readFileSync(dir + (state.killed && state.restarts ? '/after.json' : '/before.json'), 'utf8'));
    else if (command.includes('kill -9')) { state.killed = true; fs.writeFileSync(dir + '/state.json', JSON.stringify(state)); fs.appendFileSync(dir + '/calls.log', command + '\\n'); gz(''); }
    else gz('');
} else process.exit(1);
`);
    fs.chmodSync(path.join(dir, 'podman'), 0o755);
    return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, state };
}

const runRestart = (world, extra = []) => spawnSync(process.execPath, [RESTART, '--box', 'box', '--worker', 'worker', '--wait-attempt-s', '5', '--grace-s', '6', '--restart-wait-s', '8', '--state', path.join(world.dir, 'saved.json'), ...extra], { encoding: 'utf8', env: world.env, timeout: 60000 });

test('without --kill the procedure only inspects: nothing is killed', (t) => {
    const world = fakePodman(t);
    const result = runRestart(world);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dryRun/u);
    assert.ok(!fs.existsSync(path.join(world.dir, 'calls.log')), 'no kill was issued');
});

test('--kill: kills the supervisor pid it found, sees the agent restart, finds listening recovered:true and a clean ledger: exit 0', (t) => {
    const world = fakePodman(t);
    const result = runRestart(world, ['--kill']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.pass, true);
    assert.equal(report.restartedBy, 'container-restart');
    assert.equal(fs.readFileSync(path.join(world.dir, 'calls.log'), 'utf8').trim(), '(kill -9 21) > /tmp/.rs.out 2>&1; gzip -c /tmp/.rs.out | base64 -w0; rm -f /tmp/.rs.out');
    assert.deepEqual(report.judgement.failed, []);
});

test('--kill when Ploinky does NOT restart the agent: the finding is reported and the exit code is 4; with --then the recovery is verified but the pass is withheld', (t) => {
    const stuck = fakePodman(t, { restarts: false });
    const none = runRestart(stuck, ['--kill']);
    assert.equal(none.status, 4, none.stdout + none.stderr);
    const report = JSON.parse(none.stdout);
    assert.equal(report.restartedBy, 'none');
    assert.match(report.finding, /did NOT restart/u);
    assert.match(report.next, /ploinky restart robo-work/u);
    // the manual restart happens (the fake's state flips) and --verify finishes against the saved state
    const state = JSON.parse(fs.readFileSync(stuck.state, 'utf8'));
    fs.writeFileSync(stuck.state, JSON.stringify({ ...state, restarts: true }));
    const verified = runRestart(stuck, ['--verify']);
    assert.equal(verified.status, 4, 'a manual restart: recovery passes, the autonomous restart is not shown');
    const resumed = JSON.parse(verified.stdout);
    assert.equal(resumed.judgement.pass, true);
    assert.equal(resumed.restartedBy, 'manual');
    assert.equal(resumed.pass, false);
    assert.match(resumed.note, /NOT shown/u);
});

test('--then runs the given command when Ploinky has not restarted the agent, verifies recovery, and reports restartedBy then-command (exit 4)', (t) => {
    const stuck = fakePodman(t, { restarts: false });
    const flip = `node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('${stuck.state}','utf8'));s.restarts=true;fs.writeFileSync('${stuck.state}',JSON.stringify(s))"`;
    const result = runRestart(stuck, ['--kill', '--then', flip]);
    assert.equal(result.status, 4, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.restartedBy, 'then-command');
    assert.equal(report.thenCommand.status, 0);
    assert.equal(report.judgement.pass, true);
    assert.equal(report.pass, false);
});
