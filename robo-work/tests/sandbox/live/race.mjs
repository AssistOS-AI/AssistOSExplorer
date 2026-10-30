// M-38 P-RACE (r10 AC9): N workload starts on one project while a concurrent loop renames and symlink-swaps directories and protected names
// inside it. Each start must be either VERIFIED (inside the started sandbox no protected entry shows its real content: masks hold for every
// protected name that existed at verification) or REFUSED `mask_unverified`. Any other outcome, or any real content visible through a
// protected name, fails. sha256sum manifests of the worker store, the other HOMEs and the outside directory the swaps point at must be
// identical before and after (nothing outside the grant is ever written).
//   node race.mjs [starts=200] [pauseMs]    (env RACE_PAUSE_MS; default 4) run as container root in the nested-podman profile (or as an extra process in the Box worker)
// Prints one JSON document; exit 0 on PASS.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProcView } from '../../../server/execution/procView.mjs';
import { createWalker } from '../../../server/execution/recoveryWalk.mjs';
import { classifyGrantName } from '../../../server/views/protectedNames.mjs';
import { createRecoveryView } from '../../../server/sandbox/executionSupervisor.mjs';
import { createSandboxLauncher } from '../../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../../server/sandbox/procMasks.mjs';

const CODE = path.resolve(new URL('../../..', import.meta.url).pathname);
const SECRET = 'SECRET-DO-NOT-READ';

// Which names each racer operation can change (index = position in the racer's operation list). Used to tell a writer's rename DURING a start
// (the accepted late-name class) from a protected name that was never touched while the start ran.
const OP_TOUCHES = [
    (rel) => rel === 'sub' || rel.startsWith('sub/') || rel.startsWith('sub.real'),
    (rel) => rel.startsWith('sub/deep'),
    (rel) => rel === '.data' || rel === 'D' || rel === 'data.tmp' || rel.startsWith('.data/') || rel.startsWith('D/'),
    (rel) => rel === '.env' || rel === 'env.tmp',
    () => false,
    () => false
];

// ---- the racer (child process): tight loops of renames, symlink swaps and protected-name churn inside the project -----------------------------
if (process.argv[2] === '--racer') {
    const [, , , project, out, stopFile, pauseArg] = process.argv;
    const pauseMs = Number(pauseArg ?? 0);
    const p = (...parts) => path.join(project, ...parts);
    const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(Math.random() * 3));
    const quiet = (fn) => { try { fn(); } catch { /* the race is the point */ } };
    const ops = [
        // a directory with a protected file swapped for a symlink to OUTSIDE, and back
        () => { quiet(() => fs.renameSync(p('sub'), p('sub.real'))); quiet(() => fs.symlinkSync(out, p('sub'))); nap(); quiet(() => fs.unlinkSync(p('sub'))); quiet(() => fs.renameSync(p('sub.real'), p('sub'))); },
        // a nested directory the same way
        () => { quiet(() => fs.renameSync(p('sub', 'deep'), p('sub', 'deep.real'))); quiet(() => fs.symlinkSync(out, p('sub', 'deep'))); nap(); quiet(() => fs.unlinkSync(p('sub', 'deep'))); quiet(() => fs.renameSync(p('sub', 'deep.real'), p('sub', 'deep'))); },
        // D <-> .data (a plain directory takes a protected name, the protected one takes a plain name)
        () => { quiet(() => fs.renameSync(p('.data'), p('data.tmp'))); quiet(() => fs.renameSync(p('D'), p('.data'))); nap(); quiet(() => fs.renameSync(p('.data'), p('D'))); quiet(() => fs.renameSync(p('data.tmp'), p('.data'))); },
        // the protected file .env replaced by a symlink to outside, and back
        () => { quiet(() => fs.renameSync(p('.env'), p('env.tmp'))); quiet(() => fs.symlinkSync(path.join(out, '.env'), p('.env'))); nap(); quiet(() => fs.unlinkSync(p('.env'))); quiet(() => fs.renameSync(p('env.tmp'), p('.env'))); },
        // protected names CREATED and removed (late names: visible by the accepted limitation, but their content is not the secret; the
        // original protected files are never deleted or rewritten by the racer, only moved and swapped)
        () => { quiet(() => fs.writeFileSync(p('late.secrets'), 'LATE')); quiet(() => fs.writeFileSync(p('sub', 'late.env'), 'LATE')); quiet(() => fs.mkdirSync(p('late.data'))); nap(); quiet(() => fs.rmSync(p('late.secrets'))); quiet(() => fs.rmSync(p('sub', 'late.env'))); quiet(() => fs.rmdirSync(p('late.data'))); },
        // a protected-name symlink pointing at a project file and a dangling one
        () => { quiet(() => fs.symlinkSync('README.md', p('link.env'))); quiet(() => fs.symlinkSync(path.join(out, 'x.secrets'), p('out.secrets'))); nap(); quiet(() => fs.unlinkSync(p('link.env'))); quiet(() => fs.unlinkSync(p('out.secrets'))); }
    ];
    let count = 0;
    // The pause between operations leaves windows in which a start can complete untouched; without it nearly every start is refused and
    // the probe proves little. The operations themselves stay back-to-back inside (rename, swap, rename back).
    const pause = () => { if (pauseMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(Math.random() * 2 * pauseMs)); };
    const log = [];
    while (!fs.existsSync(stopFile)) { const i = Math.floor(Math.random() * ops.length); const t0 = Date.now(); ops[i](); log.push([i, t0, Date.now()]); count += 1; nap(); pause(); }
    process.stdout.write(`${JSON.stringify({ racerOps: count, log })}\n`);
    process.exit(0);
}

// ---- the probe that runs INSIDE every started sandbox ----------------------------------------------------------------------------------
const PROBE = String.raw`
const fs = require('fs');
import('/opt/robo-work/server/views/protectedNames.mjs').then(({ classifyGrantName }) => {
    const found = { protectedSeen: 0, violations: [] };
    const walk = (dir, depth) => {
        let names; try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) {
            const file = dir + '/' + name; let st; try { st = fs.lstatSync(file); } catch { continue; }
            if (st.isSymbolicLink()) continue;
            if (classifyGrantName(name) !== null) {
                found.protectedSeen += 1;
                if (st.isDirectory()) { let inside = []; try { inside = fs.readdirSync(file); } catch {} if (inside.includes('inside')) found.violations.push({ path: file.slice(0, 120), dev: String(st.dev), ino: String(st.ino), what: 'the protected directory\'s real content' }); continue; }
                let text = ''; try { text = fs.readFileSync(file, 'utf8').slice(0, 200); } catch {}
                if (text.includes('` + SECRET + String.raw`')) found.violations.push({ path: file.slice(0, 120), dev: String(st.dev), ino: String(st.ino), what: 'real content' });
                continue;
            }
            if (st.isDirectory() && depth < 8) walk(file, depth + 1);
        }
    };
    walk('/projects/p', 0);
    process.stdout.write('RESULT ' + JSON.stringify(found) + '\n');
});
`;

// ---- setup -------------------------------------------------------------------------------------------------------------------------------
const starts = Number(process.argv[2] ?? 200);
const pauseMs = Number(process.argv[3] ?? process.env.RACE_PAUSE_MS ?? 4);
// A PASS with (almost) no verified start proves nothing: at least 25 % of the starts (and 30, when there are that many) must verify.
const verifiedFloor = Math.min(starts, Math.max(30, Math.ceil(starts * 0.25)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-race-'));
const project = path.join(root, 'project');
const out = path.join(root, 'outside');
const store = path.join(root, 'worker-store');
const homes = path.join(root, 'homes');
const home = path.join(homes, 'robotA');
const stopFile = path.join(root, 'STOP');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
for (const [file, text] of [
    [path.join(project, '.env'), SECRET], [path.join(project, 'README.md'), 'hello'], [path.join(project, '.data', 'inside'), SECRET], [path.join(project, 'D', 'plain.txt'), 'plain'],
    [path.join(project, 'sub', '.env'), SECRET], [path.join(project, 'sub', 'x.secrets'), SECRET], [path.join(project, 'sub', 'deep', '.env'), SECRET], [path.join(project, 'sub', 'deep', 'ok.txt'), 'ok'],
    [path.join(out, '.env'), `OUTSIDE-${SECRET}`], [path.join(out, 'x.secrets'), `OUTSIDE-${SECRET}`], [path.join(out, 'untouched.txt'), 'outside'],
    [path.join(store, 'robots', 'r1', 'session.json'), '{"s":1}'], [path.join(store, 'state.sqlite'), 'sqlite-bytes'],
    [path.join(homes, 'robotB', '.codex', 'auth.json'), '{"token":"other robot"}'], [path.join(homes, 'robotC', 'notes.md'), 'notes'], [path.join(home, 'file.txt'), 'home of A']
]) write(file, text);

function manifest(...dirs) {
    const lines = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const file = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) lines.push(`L ${file} ${fs.readlinkSync(file)}`);
            else if (entry.isDirectory()) { lines.push(`D ${file}`); walk(file); } else lines.push(`${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')} ${file}`);
        }
    };
    for (const dir of dirs) walk(dir);
    return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}
// An inventory of the project taken by THIS script, not by prep (and not from prep's record): every object (no link followed) with the name it
// has, and whether the name is protected. Taken just before each start, it lets the harness say which unmasked protected names were already
// there before the start (a failure) and which only appeared by a writer's rename or creation afterwards (the accepted limitation).
function inventory() {
    const objects = new Map();
    const walk = (dir, rel) => {
        let names; try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) {
            const file = path.join(dir, name); let st; try { st = fs.lstatSync(file, { bigint: true }); } catch { continue; }
            if (st.isSymbolicLink()) continue;
            const here = rel === '' ? name : `${rel}/${name}`;
            objects.set(`${st.dev}:${st.ino}`, { rel: here, protectedName: classifyGrantName(name) !== null });
            if (st.isDirectory() && !(classifyGrantName(name) !== null)) walk(file, here);
            else if (st.isDirectory()) { try { for (const inner of fs.readdirSync(file)) { const innerStat = fs.lstatSync(path.join(file, inner), { bigint: true }); objects.set(`${innerStat.dev}:${innerStat.ino}`, { rel: `${here}/${inner}`, protectedName: false }); } } catch { /* raced away */ } }
        }
    };
    walk(project, '');
    return objects;
}
const protectedDirs = [store, path.join(homes, 'robotB'), path.join(homes, 'robotC'), out];
const before = protectedDirs.map((dir) => manifest(dir));

const view = createProcView({ runtimeRoot: path.join(root, 'runtime') });
const launcher = createSandboxLauncher({ view, procMasks: readProcMasks() });
const walker = createWalker({ view: createRecoveryView(view), clock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, releaseDeadlineMs: 6000, pollMs: 100, sandboxRecord: () => null });
const runtimeDir = path.join(root, 'rt');
for (const dir of ['channels', 'ctl', 'stage', 'tmp']) fs.mkdirSync(path.join(runtimeDir, dir), { recursive: true });
const fdOf = (target) => fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
const homeFd = fdOf(home);
const projectFd = fdOf(project);
const stableCandidates = [];
const result = { starts, verified: 0, refusedMaskUnverified: 0, refusedByBwrapAfterPrep: 0, otherOutcomes: {}, violations: [], protectedSeenInVerified: 0, lateNames: 0, lateRenamed: 0, lateCreated: 0, verifiedFloor, racerPauseMs: pauseMs, bwrapRefusals: [], maskedObjectsTotal: 0, errors: [] };

const racer = spawn(process.execPath, [new URL(import.meta.url).pathname, '--racer', project, out, stopFile, String(pauseMs)], { stdio: ['ignore', 'pipe', 'inherit'] });
let racerText = '';
racer.stdout.on('data', (chunk) => { racerText += chunk; });
await new Promise((resolve) => setTimeout(resolve, 300));
const began = Date.now();
for (let index = 0; index < starts; index += 1) {
    const marker = crypto.randomBytes(16).toString('base64url');
    let sandbox = null;
    let bwrapRefusal = null;
    const tPre = Date.now();
    const preScan = inventory();
    try {
        sandbox = await launcher.launch({
            role: 'workload', marker, runtimeDir, netMode: 'none', cwd: '/', argv: ['/usr/local/bin/node', '-e', PROBE], env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
            roBinds: [{ source: '/usr', dest: '/usr' }, { source: CODE, dest: '/opt/robo-work' }],
            symlinks: [{ target: 'usr/bin', dest: '/bin' }, { target: 'usr/lib', dest: '/lib' }, { target: 'usr/lib64', dest: '/lib64' }],
            home: { path: home, fd: homeFd }, grants: [{ name: 'p', path: project, fd: projectFd, mode: 'rw' }], channelsDir: path.join(runtimeDir, 'channels'),
            stdio: ['ignore', 'pipe', 'pipe'], onIdentity: async () => {}, verifyTimeoutMs: 8000, reportMasks: true
        });
        let text = '';
        let errText = '';
        sandbox.stdio[1].on('data', (chunk) => { text += chunk; });
        sandbox.stdio[2].on('data', (chunk) => { errText += chunk; });
        const closed = new Promise((resolve) => { sandbox.stdio[1].once('close', resolve); setTimeout(resolve, 3000); });
        const exit = await sandbox.wait();
        await closed; // the output arrives on a pipe and may be delivered after the exit event
        const line = text.split('\n').find((candidate) => candidate.startsWith('RESULT '));
        if (!line) {
            // The chain passed prep and bwrap then failed to build the view because a protected path it had to remount was renamed away
            // by the racer in between ("Unable to apply mount flags: remount ... No such file"): the command never ran, so this is a refused
            // start (no sandbox ran, nothing was exposed), counted apart from the mask_unverified refusals and never as a verified start.
            if (/^bwrap: /mu.test(errText) && exit.exitCode === 1) { result.refusedByBwrapAfterPrep += 1; bwrapRefusal = { index, stderr: errText.slice(0, 120) }; continue; }
            result.otherOutcomes.no_probe_result = (result.otherOutcomes.no_probe_result ?? 0) + 1;
            result.errors.push(`start ${index}: the sandbox probe printed no result (exit ${JSON.stringify(exit)}, stderr ${errText.slice(0, 200)})`);
            continue;
        }
        const found = JSON.parse(line.slice(7));
        result.verified += 1;
        result.protectedSeenInVerified += found.protectedSeen;
        // The invariant is about OBJECTS: every protected-named object that existed at verification (prep recorded its device and inode
        // before covering it) must never show its real content in the started sandbox. A protected NAME that a writer attaches to some
        // other object after verification (the D <-> .data rename) is the accepted limitation, reported as `lateNames`.
        const maskedObjects = new Set(Object.values(sandbox.masked ?? {}).flat().map((entry) => `${entry.dev}:${entry.ino}`));
        if (sandbox.masked === null || sandbox.masked === undefined) result.errors.push(`start ${index}: no evidence of what was masked`);
        for (const violation of found.violations) {
            const key = `${violation.dev}:${violation.ino}`;
            const rel = violation.path.replace(/^\/projects\/p\//u, '');
            const known = preScan.get(key);
            if (maskedObjects.has(key)) result.violations.push(`start ${index}: ${violation.path} (${violation.what}) is an object that was masked at verification`);
            else if (known !== undefined && known.protectedName && known.rel === rel) {
                // The same object already had this same protected name before the start and nothing masked it. That is a failure unless the writer
                // touched the name while the start ran (a protected symlink at verification, restored afterwards, is not masked by design): decided
                // at the end from the racer's own log of what it touched and when.
                stableCandidates.push({ index, rel, path: violation.path, what: violation.what, tPre, tPost: Date.now() });
            } else if (known !== undefined) result.lateRenamed += 1; // an object that existed before the start, seen under a protected name only because a writer renamed it
            else { result.lateCreated += 1; result.violations.push(`start ${index}: ${violation.path} (${violation.what}) is an object that did not exist before the start`); }
        }
        result.maskedObjectsTotal += maskedObjects.size;
    } catch (error) {
        const code = error?.code ?? 'error';
        if (code === 'mask_unverified') result.refusedMaskUnverified += 1;
        else { result.otherOutcomes[code] = (result.otherOutcomes[code] ?? 0) + 1; result.errors.push(`start ${index}: ${code} ${String(error?.message ?? error).slice(0, 120)}`); }
    } finally {
        if (sandbox) {
            const verdict = await sandbox.release();
            if (!verdict.absent || verdict.stageRemoved === false) result.errors.push(`start ${index}: release ${JSON.stringify(verdict)}`);
            if (bwrapRefusal !== null) {
                // A start that passed prep and failed in bwrap leaves what a failed start leaves: its blocker (the process tree as the ledger would
                // record it) must be released, with no sandbox process and no staging directory left.
                const outcome = await walker.walk({ kind: 'process-tree', identity: sandbox.identity, locator: { marker: sandbox.marker } });
                result.bwrapRefusals.push({ ...bwrapRefusal, releaseAbsent: verdict.absent, stageRemoved: verdict.stageRemoved, blockerOutcome: outcome });
                if (outcome !== 'released') result.errors.push(`start ${index}: the blocker of a start refused by bwrap was ${outcome}`);
            }
        }
    }
}
result.ms = Date.now() - began;
fs.writeFileSync(stopFile, '');
await new Promise((resolve) => racer.once('exit', resolve));
const racerReport = JSON.parse(racerText.trim().split('\n').at(-1) ?? '{}');
result.racerOps = racerReport.racerOps ?? 0;
const racerLog = racerReport.log ?? [];
// A protected name seen unmasked that was already there before the start is a failure UNLESS the writer touched that name while the start ran.
for (const candidate of stableCandidates) {
    const touched = racerLog.some(([i, t0, t1]) => OP_TOUCHES[i](candidate.rel) && t0 <= candidate.tPost && t1 >= candidate.tPre);
    if (touched) result.lateRenamed += 1;
    else result.violations.push(`start ${candidate.index}: ${candidate.path} (${candidate.what}) had this protected name before the start, the writer did not touch it during the start, and it was not masked`);
}
result.lateNames = result.lateRenamed + result.lateCreated;
const after = protectedDirs.map((dir) => manifest(dir));
result.manifestsEqual = before.every((hash, index) => hash === after[index]);
result.leftSandboxProcesses = view.listProcesses().filter((entry) => entry.cmdline.includes('/projects/p') || entry.cmdline.some((arg) => arg.startsWith('/opt/robo-work/server/sandbox/stage'))).length;
result.pass = result.verified >= verifiedFloor && result.violations.length === 0 && result.errors.length === 0 && result.manifestsEqual && result.verified + result.refusedMaskUnverified + result.refusedByBwrapAfterPrep === starts && result.racerOps > 0 && result.leftSandboxProcesses === 0;
fs.closeSync(homeFd);
fs.closeSync(projectFd);
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
process.exit(result.pass ? 0 : 1);
