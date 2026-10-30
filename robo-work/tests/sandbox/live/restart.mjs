// AC12 real restart check (r10 P-CRASH, the part crash.mjs cannot do): in the DEPLOYED Box, while a task attempt is running in the
// robo-work worker, kill the worker supervisor (`node /code/server/main.mjs`) with SIGKILL and watch Ploinky restart the agent. On the
// worker's own restart, recovery must run by itself and leave nothing behind.
//
// Run on the HOST (the machine with podman), not inside the worker: the kill ends the worker's entrypoint and, with it, the container.
//   node restart.mjs                         inspect only: waits for a running attempt, prints what a kill would affect (dry run)
//   node restart.mjs --kill                  kill the supervisor, wait for the restart, verify (exit 0 = PASS)
//   node restart.mjs --kill --then "<cmd>"   if Ploinky has not restarted the agent after --grace-s, run <cmd> on the host
//                                            (e.g. "ploinky restart robo-work") and continue
//   node restart.mjs --verify                skip the kill: verify against the state saved by an earlier --kill run (use it after a manual
//                                            `ploinky restart robo-work` when Ploinky did not restart the agent by itself)
// Options: --box <name> --worker <name> --wait-attempt-s 300 --grace-s 60 --restart-wait-s 180 --state <file>
//
// Steps and what is required (all of it shows in the JSON printed at the end):
//   1. A RUNNING attempt exists (start a task in RoboTeam first; the script waits for one). Its blockers, sandbox processes and every rw*
//      network object, runtime directory are recorded.
//   2. SIGKILL of the main.mjs process; the time is noted.
//   3. Ploinky restarts the agent by itself within --grace-s. If it does not, the report says so (restartedBy: "none") and the exit code is
//      4, unless --then restarts it (restartedBy: "then-command"): that is the finding to report, not a pass of "Ploinky restarts it".
//   4. The worker logs `listening` with `recovered:true` after the kill.
//   5. In the ledger: the interrupted attempt is `interrupted` (never still `running`/`stopping`), every one of its blockers is `released`,
//      nothing is unsettled, and the generation is not recovery-pending.
//   6. Nothing left behind: none of the old rw* netns files, veth ends or nft tables, none of the old runtime directories, no process
//      carrying an old reservation marker. (rw* objects that belong to a NEW attempt started after the restart are not leftovers: they must
//      match a committed network blocker.)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const DEFAULTS = { box: 'ploinky-box-testexplorerfresh-9d2ec627469d', worker: 'ploinky_AchillesIDE_robo-work_testExplorerFresh_9d2ec627' };

// ---- what runs inside the worker (one node script, read-only: /proc, ip, nft, a COPY of the SQLite store) ---------------------------------
export const INSPECT_JS = String.raw`
const fs = require('fs'); const cp = require('child_process');
const out = { at: new Date().toISOString() };
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const read = (f) => safe(() => fs.readFileSync(f, 'utf8'), '');
out.processes = fs.readdirSync('/proc').filter((n) => /^[0-9]+$/.test(n)).map((n) => {
    const stat = read('/proc/' + n + '/stat'); const close = stat.lastIndexOf(')'); const fields = stat.slice(close + 2).split(' ');
    const cmdline = safe(() => fs.readFileSync('/proc/' + n + '/cmdline').toString().split('\0').filter(Boolean), []);
    return { pid: Number(n), ppid: Number(fields[1]), start: fields[19], state: fields[0], cmdline };
}).filter((p) => p.start !== undefined);
const main = out.processes.find((p) => p.cmdline[0] === 'node' && p.cmdline[1] === '/code/server/main.mjs');
out.main = main ? { pid: main.pid, start: main.start } : null;
out.net = {
    netns: safe(() => fs.readdirSync('/run/netns').filter((n) => /^rw[0-9a-f]{16}$/.test(n)), []),
    links: [...new Set((safe(() => cp.execFileSync('ip', ['-o', 'link', 'show'], { encoding: 'utf8' }), '').match(/ (rw[0-9a-f]{10}[hn])[@:]/g) || []).map((m) => m.slice(1, -1)))],
    tables: (safe(() => cp.execFileSync('nft', ['list', 'tables'], { encoding: 'utf8' }), '').match(/rw_[0-9a-f]{16}/g) || [])
};
out.runtimeDirs = safe(() => fs.readdirSync('/var/lib/robo-work/runtime/x'), []);
const storeDir = '/var/lib/robo-work/state/execution-store';
out.db = safe(() => {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync('/tmp/.rsdb', { recursive: true });
    for (const f of ['worker-state.sqlite', 'worker-state.sqlite-wal', 'worker-state.sqlite-shm']) safe(() => fs.copyFileSync(storeDir + '/' + f, '/tmp/.rsdb/' + f));
    const db = new DatabaseSync('/tmp/.rsdb/worker-state.sqlite', { readOnly: true });
    const result = {
        generations: db.prepare('select id, state, prior_id, recovery_pending from generation order by rowid').all(),
        attempts: db.prepare('select execution_id, attempt_id, robot_id, state, generation_id from admission order by rowid').all(),
        blockers: db.prepare('select resource_id, execution_id, attempt_id, kind, release_state, process_bearing, locator, identity from resource_blocker order by rowid').all()
    };
    safe(() => fs.rmSync('/tmp/.rsdb', { recursive: true, force: true }));
    return result;
}, { error: 'store unreadable' });
console.log(JSON.stringify(out));
`;

// ---- pure helpers (unit-tested) ------------------------------------------------------------------------------------------------------------
export const parseJsonLines = (text) => String(text).split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));

// The first `listening` event after `sinceIso` (the restart's own), and the recovery-related events logged between the kill and then.
export function readRestartLog(text, sinceIso) {
    const events = parseJsonLines(text).filter((event) => typeof event.at === 'string' && event.at >= sinceIso);
    const listening = events.find((event) => event.event === 'listening') ?? null;
    const recovery = events.filter((event) => /recover/u.test(String(event.event)) || event.event === 'attempt_end' || event.event === 'execution_failed' || event.event === 'end_failed');
    return { listening, recovery, events: events.length };
}

const marker = (blocker) => { try { return JSON.parse(blocker.locator).marker ?? null; } catch { return null; } };
const netnsNames = (blockers) => blockers.filter((blocker) => blocker.kind === 'netns').map((blocker) => { try { return JSON.parse(blocker.identity); } catch { return null; } }).filter(Boolean);

// before / after: INSPECT_JS results; killed: the S0 attempts that were running; log: readRestartLog; opts: { restartedBy }
export function judge({ before, after, log, restartedBy }) {
    const checks = {};
    const check = (name, ok, detail = {}) => { checks[name] = { ok, ...detail }; };
    const running = before.db.attempts.filter((attempt) => attempt.state === 'running');
    check('an attempt was running at the kill', running.length > 0, { attempts: running.map((attempt) => attempt.execution_id) });
    check('the agent was restarted (not necessarily by Ploinky: see restartedBy)', restartedBy !== 'none', { restartedBy });
    check('the worker logged listening with recovered:true after the kill', log.listening?.recovered === true, { listening: log.listening });
    const afterById = new Map(after.db.attempts.map((attempt) => [attempt.attempt_id, attempt]));
    for (const attempt of running) {
        const now = afterById.get(attempt.attempt_id);
        check(`attempt ${attempt.attempt_id} is interrupted in the ledger`, now?.state === 'interrupted', { state: now?.state ?? 'missing' });
        const blockers = after.db.blockers.filter((blocker) => blocker.attempt_id === attempt.attempt_id);
        const notReleased = blockers.filter((blocker) => blocker.release_state !== 'released');
        check(`every blocker of attempt ${attempt.attempt_id} is released`, blockers.length > 0 && notReleased.length === 0, { blockers: blockers.length, notReleased: notReleased.map((blocker) => [blocker.kind, blocker.release_state]) });
    }
    const unsettled = after.db.blockers.filter((blocker) => blocker.release_state === 'reserved' || blocker.release_state === 'committed');
    const newAttemptIds = new Set(after.db.attempts.filter((attempt) => !before.db.attempts.some((old) => old.attempt_id === attempt.attempt_id)).map((attempt) => attempt.attempt_id));
    const unsettledOld = unsettled.filter((blocker) => !newAttemptIds.has(blocker.attempt_id));
    check('no blocker of an earlier attempt is left unsettled', unsettledOld.length === 0, { left: unsettledOld.map((blocker) => [blocker.kind, blocker.release_state]) });
    const lastGeneration = after.db.generations.at(-1);
    check('the generation is not recovery-pending', lastGeneration?.recovery_pending === 0, { generation: lastGeneration });

    // leftovers: whatever existed before the kill must be gone, unless a NEW attempt (started after the restart) owns it
    const ownedNow = new Set(netnsNames(after.db.blockers.filter((blocker) => newAttemptIds.has(blocker.attempt_id) && blocker.release_state === 'committed')).flatMap((identity) => [identity.name, identity.host, identity.peer, identity.table]));
    const gone = (listBefore, listAfter) => listBefore.filter((name) => listAfter.includes(name) && !ownedNow.has(name));
    const staleNetns = gone(before.net.netns, after.net.netns);
    const staleLinks = gone(before.net.links, after.net.links);
    const staleTables = gone(before.net.tables, after.net.tables);
    check('none of the old rw* network namespaces, veth ends or nft tables remain', staleNetns.length + staleLinks.length + staleTables.length === 0, { staleNetns, staleLinks, staleTables });
    const staleDirs = before.runtimeDirs.filter((name) => after.runtimeDirs.includes(name));
    check('none of the old runtime directories remain', staleDirs.length === 0, { staleDirs });
    const oldMarkers = new Set(before.db.blockers.filter((blocker) => running.some((attempt) => attempt.attempt_id === blocker.attempt_id)).map(marker).filter(Boolean));
    const survivors = after.processes.filter((process) => process.cmdline.some((arg) => oldMarkers.has(arg)));
    check('no process carries an old reservation marker', survivors.length === 0, { survivors: survivors.map((process) => process.pid) });
    const oldSandbox = before.processes.filter((process) => process.cmdline.some((arg) => oldMarkers.has(arg)));
    const alive = oldSandbox.filter((old) => after.processes.some((process) => process.pid === old.pid && process.start === old.start));
    check('none of the old sandbox processes is alive (same pid and start time)', alive.length === 0, { alive: alive.map((process) => process.pid), checked: oldSandbox.length });
    const failed = Object.entries(checks).filter(([, value]) => !value.ok).map(([name]) => name);
    return { checks, failed, pass: failed.length === 0 };
}

// ---- driving podman ----------------------------------------------------------------------------------------------------------------------
function args(argv) {
    const options = { ...DEFAULTS, kill: false, verify: false, waitAttemptS: 300, graceS: 60, restartWaitS: 180, state: '/tmp/robo-work-restart-state.json', then: null };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => argv[(index += 1)];
        if (arg === '--kill') options.kill = true;
        else if (arg === '--verify') options.verify = true;
        else if (arg === '--box') options.box = next();
        else if (arg === '--worker') options.worker = next();
        else if (arg === '--then') options.then = next();
        else if (arg === '--state') options.state = next();
        else if (arg === '--wait-attempt-s') options.waitAttemptS = Number(next());
        else if (arg === '--grace-s') options.graceS = Number(next());
        else if (arg === '--restart-wait-s') options.restartWaitS = Number(next());
        else throw new Error(`unknown option ${arg}`);
    }
    return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(argv) {
    const options = args(argv);
    const podman = (...parts) => spawnSync('podman', parts, { encoding: 'utf8', timeout: 90000 });
    const inBox = (...parts) => podman('exec', options.box, ...parts);
    // Runs a shell command inside the worker; output returned whole through gzip+base64 (nested exec truncates stdout at 8 KiB). null when the worker is down.
    const inWorker = (command) => {
        const wrapped = `(${command}) > /tmp/.rs.out 2>&1; gzip -c /tmp/.rs.out | base64 -w0; rm -f /tmp/.rs.out`;
        const result = inBox('podman', 'exec', options.worker, 'sh', '-c', wrapped);
        if (result.status !== 0 || !result.stdout) return null;
        try { return zlib.gunzipSync(Buffer.from(result.stdout.trim(), 'base64')).toString('utf8'); } catch { return null; }
    };
    const inspect = () => {
        const install = inBox('podman', 'exec', options.worker, 'sh', '-c', `echo ${zlib.gzipSync(INSPECT_JS).toString('base64')} | base64 -d | gunzip > /tmp/.rsinspect.js`);
        if (install.status !== 0) return null;
        const text = inWorker('node --no-warnings /tmp/.rsinspect.js; rm -f /tmp/.rsinspect.js');
        try { return text ? JSON.parse(text.trim().split('\n').at(-1)) : null; } catch { return null; }
    };
    const containerState = () => {
        const result = inBox('podman', 'inspect', options.worker, '--format', '{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}');
        if (result.status !== 0) return null;
        const [status, startedAt, restartCount] = result.stdout.trim().split('|');
        return { status, startedAt, restartCount: Number(restartCount) };
    };
    const report = { options: { ...options }, errors: [] };
    const finish = (code) => { process.stdout.write(`${JSON.stringify(report, null, 1)}\n`); process.exit(code); };

    let saved;
    if (options.verify) {
        saved = JSON.parse(fs.readFileSync(options.state, 'utf8'));
        report.resumedFrom = options.state;
    } else {
        // 1. wait for a running attempt, record the "before" picture
        let before = null;
        for (const deadline = Date.now() + options.waitAttemptS * 1000; Date.now() < deadline;) {
            before = inspect();
            if (before?.db?.attempts?.some((attempt) => attempt.state === 'running')) break;
            before = null;
            process.stderr.write('[restart] waiting for a running task attempt in the worker (start a task in RoboTeam)\n');
            await sleep(5000);
        }
        if (!before) { report.errors.push('no running attempt appeared'); finish(2); }
        report.before = { main: before.main, container: containerState(), attempts: before.db.attempts.filter((attempt) => attempt.state === 'running'), net: before.net, runtimeDirs: before.runtimeDirs,
            sandboxProcesses: before.processes.filter((process) => process.cmdline[0] === '/usr/bin/bwrap').length };
        if (!options.kill) { report.dryRun = 'nothing was killed; pass --kill to kill the supervisor'; finish(0); }

        // 2. the kill
        const killedAt = new Date().toISOString();
        report.killedAt = killedAt;
        if (before.main === null) { report.errors.push('no node /code/server/main.mjs process found in the worker'); finish(2); }
        inWorker(`kill -9 ${before.main.pid}`);
        const containerBefore = report.before.container;
        saved = { before, killedAt, containerBefore };
        fs.writeFileSync(options.state, JSON.stringify(saved));

        // 3. does Ploinky restart the agent by itself?
        let restartedBy = 'none';
        const restarted = () => {
            const state = containerState();
            if (state && containerBefore && (state.startedAt !== containerBefore.startedAt || state.restartCount !== containerBefore.restartCount) && state.status === 'running') return 'container-restart';
            const now = state?.status === 'running' ? inspect() : null;
            if (now?.main && now.main.pid !== before.main.pid) return 'process-restart';
            return null;
        };
        for (const deadline = Date.now() + options.graceS * 1000; Date.now() < deadline && restartedBy === 'none';) {
            await sleep(2000);
            restartedBy = restarted() ?? 'none';
        }
        report.restartedBy = restartedBy;
        if (restartedBy === 'none') {
            report.finding = `Ploinky did NOT restart the agent within ${options.graceS}s after SIGKILL of the supervisor`;
            if (!options.then) { report.next = 'run `ploinky restart robo-work`, then `node restart.mjs --verify`'; saved.restartedBy = 'manual'; fs.writeFileSync(options.state, JSON.stringify(saved)); finish(4); }
            const ran = spawnSync('sh', ['-c', options.then], { encoding: 'utf8', timeout: 300000 });
            report.thenCommand = { command: options.then, status: ran.status, stdout: (ran.stdout ?? '').slice(-400), stderr: (ran.stderr ?? '').slice(-400) };
            restartedBy = 'then-command';
            report.restartedBy = restartedBy;
        }
        saved.restartedBy = restartedBy;
        fs.writeFileSync(options.state, JSON.stringify(saved));
    }
    if (options.verify) report.restartedBy = saved.restartedBy ?? 'unknown';

    // 4. wait for the restarted worker's own `listening` line, then judge
    let log = { listening: null, recovery: [], events: 0 };
    for (const deadline = Date.now() + options.restartWaitS * 1000; Date.now() < deadline;) {
        const logs = inBox('podman', 'logs', '--since', saved.killedAt, options.worker);
        log = readRestartLog(`${logs.stdout ?? ''}\n${logs.stderr ?? ''}`, saved.killedAt);
        if (log.listening) break;
        await sleep(3000);
    }
    report.log = log;
    let after = null;
    for (const deadline = Date.now() + 60000; Date.now() < deadline && !after;) { after = inspect(); if (!after) await sleep(3000); }
    if (!after) { report.errors.push('the worker could not be inspected after the restart'); finish(3); }
    report.after = { main: after.main, net: after.net, runtimeDirs: after.runtimeDirs, attempts: after.db.attempts.filter((attempt) => saved.before.db.attempts.some((old) => old.attempt_id === attempt.attempt_id)).map((attempt) => ({ attempt_id: attempt.attempt_id, state: attempt.state })) };
    report.judgement = judge({ before: saved.before, after, log, restartedBy: report.restartedBy === 'none' ? 'none' : report.restartedBy });
    // Passing needs the agent to have come back BY ITSELF (Ploinky's restart policy). Recovery that was verified after a manual or --then restart
    // is reported as such (exit 4): the recovery claim holds, "Ploinky restarts the agent after a SIGKILL" is not shown.
    const autonomous = ['container-restart', 'process-restart'].includes(report.restartedBy);
    report.pass = report.judgement.pass && autonomous;
    if (!autonomous) report.note = `recovery was ${report.judgement.pass ? 'verified' : 'NOT verified'}, but the agent was restarted by "${report.restartedBy}", not by Ploinky itself: "Ploinky restarts the agent after SIGKILL" is NOT shown`;
    finish(report.pass ? 0 : (report.judgement.pass ? 4 : 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch((error) => { process.stdout.write(`${JSON.stringify({ fatal: String(error?.message ?? error) })}\n`); process.exit(1); });
}
