import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SKILLS_VIEW, SKILL_STAGE_NAME, buildBwrapArgs } from '../../server/sandbox/bwrapArgs.mjs';
import { runPrep } from '../../server/sandbox/sandboxPrep.mjs';
import { createSandboxLauncher } from '../../server/sandbox/sandboxLauncher.mjs';
import { markerSlot } from '../../server/sandbox/marker.mjs';
import { readProcMasks } from '../../server/sandbox/procMasks.mjs';
import { createExecutionSupervisor } from '../../server/sandbox/executionSupervisor.mjs';
import { SUPERVISOR_PID, createFakeSpawn, createFakeView, fakeClock } from './helpers/fakes.mjs';

// The M-22 skills view (T2, SPEC S1/S2 unit level): skills are staged by prep exactly like grants (anchored re-open with the recorded
// identity, scan, mask, rescan, verify) under a reserved stage name, then bound read-only into /run/robo-work/skills/<name> over a
// read-only tmpfs. Live S2 (EROFS, a planted .env reads 0 bytes, an unselected sibling is absent) runs on the Box.

const MARKER = 'rwMarker0123456789_-ab';
const base = { marker: MARKER, seccompFd: 5, blockFd: 6, infoFd: 7, jsonStatusFd: 8, roBinds: [{ source: '/usr', dest: '/usr' }] };
const workload = {
    ...base, role: 'workload', netMode: 'join', stagingDir: '/run/rw/stage', channelsDir: '/run/rw/x/r1/channels', stageScript: '/opt/robo-work/stage.sh',
    cwd: '/projects/g0', grants: [{ name: 'g0', mode: 'rw' }], env: { HOME: '/home/robot' }, argv: ['/bin/echo', 'hi']
};
const parse = (buf) => buf.toString('utf8').slice(0, -1).split('\0');
const refused = (spec) => assert.throws(() => buildBwrapArgs(spec), { code: 'invalid_request' });
const skill = (name, stage, extra = {}) => ({ name: stage, mode: 'ro', skill: name, ...extra });

test('bwrapArgs: every workload gets the read-only view; each skill is one read-only bind of its staged copy; then the tmpfs is remounted read-only', () => {
    const args = parse(buildBwrapArgs({ ...workload, grants: [...workload.grants, skill('search', 's0'), skill('human-report', 's1')] }));
    const line = args.join(' ');
    assert.ok(line.includes(`--perms 0555 --tmpfs ${SKILLS_VIEW} --ro-bind /run/rw/stage/projects/s0 ${SKILLS_VIEW}/search --ro-bind /run/rw/stage/projects/s1 ${SKILLS_VIEW}/human-report --remount-ro ${SKILLS_VIEW}`), line);
    assert.ok(!line.includes('/projects/s0 /projects/s0') && !line.includes(' /projects/s1'), 'a skill is never mounted as a project');
    assert.ok(line.includes('--bind /run/rw/stage/projects/g0 /projects/g0'));
    assert.ok(line.indexOf('--remount-ro') > line.lastIndexOf(`--ro-bind /run/rw/stage/projects/s1`), 'the remount follows every skill bind');
    // Zero skills: the empty read-only view (the prompt's path always exists and holds nothing).
    const none = parse(buildBwrapArgs(workload)).join(' ');
    assert.ok(none.includes(`--perms 0555 --tmpfs ${SKILLS_VIEW} --remount-ro ${SKILLS_VIEW}`));
    // A terminal sandbox has no skills view (M-8 is out of scope here) and refuses a skill entry.
    assert.ok(!parse(buildBwrapArgs({ ...workload, role: 'terminal' })).join(' ').includes(SKILLS_VIEW));
    refused({ ...workload, role: 'terminal', grants: [skill('search', 's0')] });
});

test('bwrapArgs: reserved stage names fail closed in both directions; a skill is read-only with a valid, unique name', () => {
    refused({ ...workload, grants: [{ name: 's0', mode: 'ro' }] });
    refused({ ...workload, grants: [{ name: 'g1', mode: 'ro', skill: 'search' }] });
    refused({ ...workload, grants: [skill('search', 's0', { mode: 'rw' })] });
    refused({ ...workload, grants: [skill('search', 's0'), skill('search', 's1')] });
    for (const name of ['..', '.hidden', 'a/b', '', 'x'.repeat(65), 'naïve', 7]) refused({ ...workload, grants: [skill(name, 's0')] });
    buildBwrapArgs({ ...workload, grants: [skill('x'.repeat(64), 's0'), skill('A1._-z', 's63')] });
    assert.ok(SKILL_STAGE_NAME.test('s0') && SKILL_STAGE_NAME.test('s63') && !SKILL_STAGE_NAME.test('g0') && !SKILL_STAGE_NAME.test('s100'));
});

// ---- prep -------------------------------------------------------------------------------------------------------------------------

const FIXTURE = fs.readFileSync(fileURLToPath(new URL('./fixtures/podman-nested-mountinfo.txt', import.meta.url)), 'utf8');
const PREP_MARKER = 'rw-TestMarker0123456789_a';
function prepWorld() {
    const calls = [];
    let info = FIXTURE;
    return {
        calls, readFile: () => info, readlink: () => 'mnt:[4026500001]', pid: 4242,
        runTool: (command, args) => {
            calls.push([command, ...args]);
            if (command === 'umount') info = info.split('\n').filter((line) => line.split(' ')[4] !== args[2]).join('\n');
            return { status: 0, stderr: '' };
        }
    };
}
const idOf = (dir) => { const st = fs.statSync(dir, { bigint: true }); return { path: dir, dev: String(st.dev), ino: String(st.ino) }; };

function skillTree(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-skillprep-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const skillDir = path.join(root, 'skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: s\n---\n');
    fs.writeFileSync(path.join(skillDir, '.env'), 'SECRET=1');
    const stage = path.join(root, 'stage');
    fs.mkdirSync(path.join(stage, 'projects', 's0'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'mask-dir'), { mode: 0o555 });
    fs.writeFileSync(path.join(stage, 'mask-file'), '', { mode: 0o444 });
    return { root, skillDir, stage };
}
const prepSpec = (stage, grants) => ({ supervisorMntNs: '4026500000', stageDir: stage, maskDir: `${stage}/mask-dir`, maskFile: `${stage}/mask-file`, grants, binds: [] });

test('prep: a skill is staged through scan -> mask -> verify like a grant (its .env is masked) and needs a regular SKILL.md', (t) => {
    const { skillDir, stage } = skillTree(t);
    const world = prepWorld();
    const reopen = () => fs.openSync(skillDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    runPrep(PREP_MARKER, prepSpec(stage, [{ name: 's0', ...idOf(skillDir) }]), { ...world, openDir: reopen, verify: () => ({ ok: true }) });
    const mounts = world.calls.filter((call) => call[0] === 'mount').map((call) => call.slice(1).join(' '));
    assert.match(mounts[0], new RegExp(`^--no-canonicalize --bind /proc/4242/fd/\\d+ ${stage}/projects/s0$`), 'anchored re-open with the recorded identity, bound from the descriptor');
    assert.deepEqual(mounts.slice(1), [`--no-canonicalize --bind -o ro ${stage}/mask-file ${stage}/projects/s0/.env`], 'the protected name inside the skill is masked');
});

test('prep (error injection): a SKILL.md swapped for a symlink (or removed) during prep is mask_unverified; a project grant is not checked', (t) => {
    const { root, skillDir, stage } = skillTree(t);
    const world = prepWorld();
    fs.writeFileSync(path.join(root, 'elsewhere.md'), 'x');
    // The swap happens after admission (the factory saw a regular file): the staged view now shows a link.
    fs.rmSync(path.join(skillDir, 'SKILL.md'));
    fs.symlinkSync(path.join(root, 'elsewhere.md'), path.join(skillDir, 'SKILL.md'));
    const reopen = () => fs.openSync(skillDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    assert.throws(() => runPrep(PREP_MARKER, prepSpec(stage, [{ name: 's0', ...idOf(skillDir) }]), { ...prepWorld(), openDir: reopen, verify: () => ({ ok: true }) }), { code: 'mask_unverified' });
    fs.rmSync(path.join(skillDir, 'SKILL.md'));
    assert.throws(() => runPrep(PREP_MARKER, prepSpec(stage, [{ name: 's0', ...idOf(skillDir) }]), { ...prepWorld(), openDir: reopen, verify: () => ({ ok: true }) }), { code: 'mask_unverified' });
    // The same tree as a project grant (not a reserved name) needs no SKILL.md.
    fs.mkdirSync(path.join(stage, 'projects', 'g0'));
    runPrep(PREP_MARKER, prepSpec(stage, [{ name: 'g0', ...idOf(skillDir) }]), { ...world, openDir: reopen, verify: () => ({ ok: true }) });
});

// ---- cross-module: supervisor -> real launcher -> prep spec and bwrap buffer --------------------------------------------------------

const MASKS = readProcMasks({ readFile: () => FIXTURE });
const TOOLS = { setpriv: '/usr/bin/setpriv', unshare: '/usr/bin/unshare', mount: '/usr/bin/mount', umount: '/usr/bin/umount', node: '/usr/bin/node', nsenter: '/usr/bin/nsenter' };

test('cross-module: skill entries pass through the REAL launcher: prep receives them as grants with dev/ino, the bwrap buffer binds them into the view', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-skilllaunch-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const name of ['home', 'proj', 'skillA', 'skillB']) fs.mkdirSync(path.join(dir, name));
    const fds = Object.fromEntries(['home', 'proj', 'skillA', 'skillB'].map((name) => [name, fs.openSync(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)]));
    t.after(() => { for (const fd of Object.values(fds)) fs.closeSync(fd); });
    const view = createFakeView();
    const { spawnImpl, spawned } = createFakeSpawn(view, {});
    const fsWithBwrap = { ...fs, existsSync: (file) => file === '/usr/bin/bwrap' || fs.existsSync(file) };
    const launcher = createSandboxLauncher({
        view, spawnImpl, signal: () => {}, clock: fakeClock(), procMasks: MASKS, tools: TOOLS, supervisorPid: SUPERVISOR_PID,
        openNamespace: (pid, type) => { const entry = view.process(pid); return { inode: type === 'pid' ? entry.pidNs : entry.mntNs, close: () => {} }; },
        stageScript: '/opt/robo-work/server/sandbox/stage.sh', arch: 'x86_64', fsImpl: fsWithBwrap
    });
    // The supervisor's own wiring: the skill entries come from `skills`, not from the request's folders. Its launch is recorded and
    // refused here (only the spec matters), then that exact recorded spec goes through the real launcher.
    let launched = null;
    const recordingLauncher = { launch: async (spec) => { launched = spec; throw Object.assign(new Error('recorded'), { code: 'recorded' }); } };
    const supervisor = createExecutionSupervisor({
        launcher: recordingLauncher, view, admission: { inventory: [], streamDirectory: '/stream' },
        roles: { orchestration: {}, endpoint: {}, workload: { roBinds: [{ source: '/usr', dest: '/usr' }], symlinks: [] } },
        home: { path: path.join(dir, 'home'), fd: fds.home },
        grants: [{ name: 'g0', path: '/projects/g0', hostPath: path.join(dir, 'proj'), access: 'write', fd: fds.proj }],
        skills: [{ name: 'search', stageName: 's0', path: path.join(dir, 'skillA'), fd: fds.skillA }, { name: 'human-report', stageName: 's1', path: path.join(dir, 'skillB'), fd: fds.skillB }]
    });
    await supervisor.create({ kind: 'runtime-dir', resourceId: 'rt', marker: 'rwRtMarker0123456789012', locator: { path: path.join(dir, 'x', 'rt') } });
    await assert.rejects(supervisor.create({
        kind: 'process-tree', resourceId: 'w1', marker: 'rw-TestMarker0123456789_a',
        spec: { role: 'workload', request: { network: 'none', folders: [], exclusions: [], cwd: '/home/robot', home: '/home/robot', env: {}, executable: '/usr/bin/echo', args: ['hi'] }, streams: {} }
    }), { code: 'recorded' });
    assert.deepEqual(launched.grants.map(({ name, mode, skill: skillName }) => [name, mode, skillName ?? null]), [['s0', 'ro', 'search'], ['s1', 'ro', 'human-report']],
        'no folder selects the project grant, but every admitted skill is there');
    await launcher.launch({ ...launched, runtimeDir: dir, netMode: 'none', verifyTimeoutMs: 200 });
    const [record] = spawned;
    const prep = record.args.indexOf('prep');
    const prepGrants = JSON.parse(record.args[prep + 5]).grants;
    assert.deepEqual(prepGrants, [
        { name: 's0', ...idOf(path.join(dir, 'skillA')) },
        { name: 's1', ...idOf(path.join(dir, 'skillB')) }
    ]);
    const stage = `${dir}/stage/${markerSlot('rw-TestMarker0123456789_a')}`;
    const buffer = record.fdContents.args.toString('utf8').split('\0').join(' ');
    assert.ok(buffer.includes(`--perms 0555 --tmpfs ${SKILLS_VIEW} --ro-bind ${stage}/projects/s0 ${SKILLS_VIEW}/search --ro-bind ${stage}/projects/s1 ${SKILLS_VIEW}/human-report --remount-ro ${SKILLS_VIEW}`), buffer);
    assert.ok(!buffer.includes('/projects/s0 /projects/s0'));
});

// ---- M-22 / M-70: masks and exclusions inside a skill; M-69 Q2: a read-only root ---------------------------------------------------

test('M-70 (case B): an ignore path inside a skill that is also inside the cwd grant is masked in BOTH places: the project grant and the skill view', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-skillexcl-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'proj');
    const skillDir = path.join(project, 'tools', 'sk');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'skill');
    fs.writeFileSync(path.join(skillDir, 'secret.txt'), 'SECRET');
    const stage = path.join(root, 'stage');
    for (const name of ['g0', 's0']) fs.mkdirSync(path.join(stage, 'projects', name), { recursive: true });
    fs.mkdirSync(path.join(stage, 'mask-dir'), { mode: 0o555 });
    fs.writeFileSync(path.join(stage, 'mask-file'), '', { mode: 0o444 });
    const world = prepWorld();
    const fds = { g0: project, s0: skillDir };
    const reopen = (file) => fs.openSync(fds[path.basename(file)], fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    runPrep(PREP_MARKER, prepSpec(stage, [{ name: 'g0', ...idOf(project), exclusions: ['tools/sk/secret.txt'] }, { name: 's0', ...idOf(skillDir), exclusions: ['secret.txt'] }]),
        { ...world, openDir: reopen, verify: () => ({ ok: true }), verifyExclusions: () => ({ ok: true }) });
    const masks = world.calls.filter((call) => call[0] === 'mount' && call.includes('-o')).map((call) => call.at(-1));
    assert.deepEqual(masks.sort(), [`${stage}/projects/g0/tools/sk/secret.txt`, `${stage}/projects/s0/secret.txt`].sort());
});

test('M-70 (plus): protected names inside a skill folder (.env, .data, master-key, x.secrets, .ploinky, .roboteam) are masked in the view as at /projects', (t) => {
    const { skillDir, stage } = skillTree(t);
    fs.mkdirSync(path.join(skillDir, '.data'));
    fs.mkdirSync(path.join(skillDir, '.ploinky'));
    fs.mkdirSync(path.join(skillDir, '.roboteam'));
    fs.writeFileSync(path.join(skillDir, 'master-key'), 'k');
    fs.writeFileSync(path.join(skillDir, 'x.secrets'), 's');
    const world = prepWorld();
    const reopen = () => fs.openSync(skillDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    runPrep(PREP_MARKER, prepSpec(stage, [{ name: 's0', ...idOf(skillDir) }]), { ...world, openDir: reopen, verify: () => ({ ok: true }) });
    const masked = world.calls.filter((call) => call[0] === 'mount' && call.includes('-o')).map((call) => [call.at(-2).endsWith('mask-dir') ? 'dir' : 'file', path.basename(call.at(-1))]);
    assert.deepEqual(masked.sort(), [['dir', '.data'], ['dir', '.ploinky'], ['dir', '.roboteam'], ['file', '.env'], ['file', 'master-key'], ['file', 'x.secrets']].sort());
});

test('M-70: the supervisor passes each skill\'s exclusions to the launcher, and the real launcher hands them to prep', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-skillexcl-launch-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const name of ['home', 'skillA']) fs.mkdirSync(path.join(dir, name));
    const fds = { home: fs.openSync(path.join(dir, 'home'), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY), skillA: fs.openSync(path.join(dir, 'skillA'), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY) };
    t.after(() => { for (const fd of Object.values(fds)) fs.closeSync(fd); });
    const view = createFakeView();
    let launched = null;
    const supervisor = createExecutionSupervisor({
        launcher: { launch: async (spec) => { launched = spec; throw Object.assign(new Error('recorded'), { code: 'recorded' }); } }, view,
        admission: { inventory: [], streamDirectory: '/stream' }, roles: { orchestration: {}, endpoint: {}, workload: { roBinds: [{ source: '/usr', dest: '/usr' }], symlinks: [] } },
        home: { path: path.join(dir, 'home'), fd: fds.home }, grants: [],
        skills: [{ name: 'search', stageName: 's0', path: path.join(dir, 'skillA'), fd: fds.skillA, exclusions: ['secret.txt', 'docs/private'] }]
    });
    await supervisor.create({ kind: 'runtime-dir', resourceId: 'rt', marker: 'rwRtMarker0123456789012', locator: { path: path.join(dir, 'x', 'rt') } });
    await assert.rejects(supervisor.create({ kind: 'process-tree', resourceId: 'w1', marker: 'rw-TestMarker0123456789_a',
        spec: { role: 'workload', request: { network: 'none', folders: [], exclusions: [], cwd: '/home/robot', home: '/home/robot', env: {}, executable: '/usr/bin/echo', args: ['hi'] }, streams: {} } }), { code: 'recorded' });
    assert.deepEqual(launched.grants.map((grant) => [grant.name, grant.skill, grant.exclusions]), [['s0', 'search', ['secret.txt', 'docs/private']]]);
    const { spawnImpl, spawned } = createFakeSpawn(view, {});
    const launcher = createSandboxLauncher({
        view, spawnImpl, signal: () => {}, clock: fakeClock(), procMasks: MASKS, tools: TOOLS, supervisorPid: SUPERVISOR_PID,
        openNamespace: (pid, type) => { const entry = view.process(pid); return { inode: type === 'pid' ? entry.pidNs : entry.mntNs, close: () => {} }; },
        stageScript: '/opt/robo-work/server/sandbox/stage.sh', arch: 'x86_64', fsImpl: { ...fs, existsSync: (file) => file === '/usr/bin/bwrap' || fs.existsSync(file) }
    });
    await launcher.launch({ ...launched, runtimeDir: dir, netMode: 'none', verifyTimeoutMs: 200 });
    const prep = spawned[0].args.indexOf('prep');
    assert.deepEqual(JSON.parse(spawned[0].args[prep + 5]).grants, [{ name: 's0', ...idOf(path.join(dir, 'skillA')), exclusions: ['secret.txt', 'docs/private'] }]);
});

test('M-69 Q2: a workload\'s /run/robo-work is a read-only tmpfs with only the channels and skills binds, and its root is remounted read-only after every mount', () => {
    const args = parse(buildBwrapArgs({ ...workload, tmpDir: '/run/rw/x/r1/tmp', grants: [...workload.grants, skill('search', 's0')] }));
    const at = (seq) => { for (let i = 0; i + seq.length <= args.length; i += 1) if (seq.every((value, j) => args[i + j] === value)) return i; return -1; };
    const runTmpfs = at(['--perms', '0555', '--tmpfs', '/run/robo-work']);
    const skillsTmpfs = at(['--perms', '0555', '--tmpfs', SKILLS_VIEW]);
    const channels = at(['--ro-bind', '/run/rw/x/r1/channels', '/run/robo-work/channels']);
    const runRemount = at(['--remount-ro', '/run/robo-work']);
    const tmp = at(['--bind', '/run/rw/x/r1/tmp', '/tmp']);
    const rootRemount = at(['--remount-ro', '/']);
    assert.ok(runTmpfs >= 0 && runTmpfs < skillsTmpfs && skillsTmpfs < channels && channels < runRemount && runRemount < rootRemount && tmp < rootRemount, JSON.stringify({ runTmpfs, skillsTmpfs, channels, runRemount, tmp, rootRemount }));
    // Every mount option comes before the root remount: nothing is mounted after the root became read-only.
    const mountOps = new Set(['--bind', '--ro-bind', '--tmpfs', '--dev-bind', '--symlink', '--dir', '--proc', '--dev']);
    assert.equal(args.slice(rootRemount + 2).some((arg) => mountOps.has(arg)), false);
    // The terminal role (T1's) is unchanged here.
    const terminal = parse(buildBwrapArgs({ ...workload, role: 'terminal' })).join(' ');
    assert.ok(!terminal.includes('--remount-ro /') && !terminal.includes('--tmpfs /run/robo-work'));
});
