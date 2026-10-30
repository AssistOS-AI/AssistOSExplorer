import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { exitCodeFor, main, openAnchored, runPrep } from '../../server/sandbox/sandboxPrep.mjs';
import { PREP_EXIT } from '../../server/sandbox/sandboxErrors.mjs';

const FIXTURE = fs.readFileSync(fileURLToPath(new URL('./fixtures/podman-nested-mountinfo.txt', import.meta.url)), 'utf8');
const PREP = fileURLToPath(new URL('../../server/sandbox/sandboxPrep.mjs', import.meta.url));
const MARKER = 'rw-TestMarker0123456789_a';

function tree(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-prep-'));
    try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// A grant tree with protected names, and the staging layout the launcher makes.
function layout(root) {
    const grant = path.join(root, 'grant');
    fs.mkdirSync(path.join(grant, 'sub', '.data'), { recursive: true });
    fs.writeFileSync(path.join(grant, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(grant, 'sub', 'x.secrets'), 's');
    fs.writeFileSync(path.join(grant, 'README.md'), 'ok');
    const stage = path.join(root, 'stage');
    fs.mkdirSync(path.join(stage, 'projects', 'a'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'mask-dir'), { mode: 0o555 });
    fs.writeFileSync(path.join(stage, 'mask-file'), '', { mode: 0o444 });
    return { grant, stage };
}

// Fakes: a mountinfo that loses the /proc masks as umount is called, and a recorder for every tool call.
function rig({ privateNs = true, failTool = null, mountinfo = FIXTURE } = {}) {
    const calls = [];
    let info = mountinfo;
    const runTool = (command, args) => {
        calls.push([command, ...args]);
        if (failTool && `${command} ${args.join(' ')}`.includes(failTool)) return { status: 32, stderr: 'boom' };
        if (command === 'umount') info = info.split('\n').filter((line) => line.split(' ')[4] !== args[2]).join('\n');
        return { status: 0, stderr: '' };
    };
    return {
        calls, runTool, readFile: () => info,
        readlink: () => (privateNs ? 'mnt:[4026500001]' : 'mnt:[4026500000]'), pid: 4242
    };
}

const idOf = (dir) => { const st = fs.statSync(dir, { bigint: true }); return { path: dir, dev: String(st.dev), ino: String(st.ino) }; };
// `grant` is a grant directory (or null for a role without mounts); `binds` extra staged directories.
const spec = (grant, stage, extra = {}) => ({
    supervisorMntNs: '4026500000', stageDir: stage, maskDir: `${stage}/mask-dir`, maskFile: `${stage}/mask-file`,
    grants: grant === null ? [] : [{ name: 'a', ...idOf(grant) }], binds: [], ...extra
});

test('refuses to run in the supervisor mount namespace, before touching any mount', () => tree((root) => {
    const { stage } = layout(root);
    const world = rig({ privateNs: false });
    assert.throws(() => runPrep(MARKER, spec(null, stage), world), { code: 'setup_failed' });
    assert.deepEqual(world.calls, []);
}));

test('unmounts exactly the classified /proc masks, deepest first, then verifies none remain (no grants needed)', () => {
    const world = rig();
    runPrep(MARKER, spec(null, '/x'), world);
    const unmounted = world.calls.filter((call) => call[0] === 'umount');
    assert.equal(unmounted.length, 13);
    assert.ok(unmounted.every((call) => call[1] === '-l' && call[2] === '--' && call[3].startsWith('/proc/')));
    assert.ok(world.calls.every((call) => call[0] === 'umount'), 'nothing else is run without grants');
    const depth = unmounted.map((call) => call[3].split('/').length);
    assert.deepEqual(depth, [...depth].sort((a, b) => b - a));
});

test('an unclassified /proc submount, a failed umount, or a submount that remains is setup_failed; /dev and /sys are never unmounted', () => {
    const odd = `${FIXTURE.trimEnd()}\n9000 7333 0:200 / /proc/odd rw - ext4 /dev/sda1 rw\n`;
    const a = rig({ mountinfo: odd });
    assert.throws(() => runPrep(MARKER, spec(null, '/x'), a), { code: 'setup_failed' });
    assert.equal(a.calls.length, 0);
    assert.throws(() => runPrep(MARKER, spec(null, '/x'), rig({ failTool: 'umount -l -- /proc/kcore' })), { code: 'setup_failed' });
    const stuck = rig();
    const original = stuck.runTool;
    stuck.runTool = (command, args) => { original(command, args); return { status: 0, stderr: '' }; };
    stuck.readFile = () => FIXTURE; // umount "succeeds" but the table still shows the masks
    assert.throws(() => runPrep(MARKER, spec(null, '/x'), stuck), { code: 'setup_failed' });
    for (const call of [...a.calls, ...stuck.calls]) assert.ok(!call.join(' ').match(/\s\/(dev|sys)\b/));
});

test('mounts: opened here by an anchored walk, identity proven, bound from /proc/<pid>/fd/<n>; one read-only mask bind per protected entry; verified on a fresh staging fd', () => tree((root) => {
    const { grant, stage } = layout(root);
    const homeDir = path.join(root, 'home');
    fs.mkdirSync(homeDir);
    fs.mkdirSync(path.join(stage, 'binds', 'home'), { recursive: true });
    const world = rig();
    const opened = [];
    let verified = null;
    runPrep(MARKER, spec(grant, stage, { binds: [{ name: 'home', ...idOf(homeDir) }] }), {
        ...world,
        openDir: (file) => { opened.push(file); return fs.openSync(grant, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); },
        verify: (fd, entries, maskIds) => { verified = { fd, entries, maskIds }; return { ok: true }; }
    });
    const mounts = world.calls.filter((call) => call[0] === 'mount').map((call) => call.slice(1));
    assert.match(mounts[0].join(' '), new RegExp(`^--no-canonicalize --bind /proc/4242/fd/\\d+ ${stage}/binds/home$`));
    assert.match(mounts[1].join(' '), new RegExp(`^--no-canonicalize --bind /proc/4242/fd/\\d+ ${stage}/projects/a$`));
    assert.deepEqual(mounts.slice(2).sort(), [
        ['--no-canonicalize', '--bind', '-o', 'ro', `${stage}/mask-dir`, `${stage}/projects/a/sub/.data`],
        ['--no-canonicalize', '--bind', '-o', 'ro', `${stage}/mask-file`, `${stage}/projects/a/.env`],
        ['--no-canonicalize', '--bind', '-o', 'ro', `${stage}/mask-file`, `${stage}/projects/a/sub/x.secrets`]
    ].sort());
    assert.deepEqual(opened, [`${stage}/projects/a`], 'the staging bind is re-opened by path for the rescan');
    assert.equal(verified.entries.length, 3);
    assert.ok(verified.maskIds.dir.ino !== verified.maskIds.file.ino);
}));

test('a directory whose identity differs from the supervisor\'s record is never bound (swap between admission and start)', () => tree((root) => {
    const { grant, stage } = layout(root);
    const world = rig();
    const wrong = { name: 'a', ...idOf(grant), ino: String(BigInt(idOf(grant).ino) + 1n) };
    assert.throws(() => runPrep(MARKER, spec(null, stage, { grants: [wrong] }), world), { code: 'setup_failed' });
    assert.equal(world.calls.filter((call) => call[0] === 'mount').length, 0);
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    assert.throws(() => runPrep(MARKER, spec(null, stage, { grants: [{ name: 'a', ...idOf(other), path: grant }] }), world), { code: 'setup_failed' });
    assert.equal(world.calls.filter((call) => call[0] === 'mount').length, 0);
}));

test('openAnchored follows no symlink at any component and refuses odd paths', () => tree((root) => {
    const real = path.join(root, 'real', 'deep');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    const fd = openAnchored(real);
    assert.equal(fs.fstatSync(fd).ino, fs.statSync(real).ino);
    fs.closeSync(fd);
    assert.throws(() => openAnchored(path.join(root, 'link', 'deep')), { code: 'setup_failed' });
    assert.throws(() => openAnchored(path.join(root, 'missing')), { code: 'setup_failed' });
    assert.throws(() => runPrep(MARKER, spec(null, '/x', { grants: [{ name: 'a', path: `${root}/real/../real`, dev: '1', ino: '1' }] }), rig()), { code: 'setup_failed' });
    assert.throws(() => runPrep(MARKER, spec(null, '/x', { binds: [{ name: 'Bad Name', path: real, dev: '1', ino: '1' }] }), rig()), { code: 'setup_failed' });
}));

test('real verification of an unmasked staging view fails mask_unverified (exit 21); diagnostics carry no file names', () => tree((root) => {
    const { grant, stage } = layout(root);
    const world = rig();
    const reopen = () => fs.openSync(grant, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    assert.throws(() => runPrep(MARKER, spec(grant, stage), { ...world, openDir: reopen }), { code: 'mask_unverified' });
    const lines = [];
    const code = main([MARKER, JSON.stringify(spec(grant, stage))], { ...rig(), openDir: reopen }, { write: (text) => lines.push(text) });
    assert.equal(code, PREP_EXIT.mask_unverified);
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['detail', 'error']);
    assert.ok(!lines[0].includes('.env'), 'no entry names in the diagnostic');
}));

test('a failed bind or mask mount stops the start; scan limits map to mask_scan_limit (exit 20)', () => tree((root) => {
    const { grant, stage } = layout(root);
    assert.throws(() => runPrep(MARKER, spec(grant, stage), rig({ failTool: '--bind /proc/4242' })), { code: 'setup_failed' });
    assert.throws(() => runPrep(MARKER, spec(grant, stage), rig({ failTool: '-o ro' })), { code: 'mask_unverified' });
    const lines = [];
    const code = main([MARKER, JSON.stringify(spec(grant, stage, { limits: { maxMasks: 2 } }))], rig(), { write: (text) => lines.push(text) });
    assert.equal(code, PREP_EXIT.mask_scan_limit);
    assert.equal(JSON.parse(lines[0]).error, 'mask_scan_limit');
}));

test('a missing mount binary is sandbox_unavailable (exit 23); other errors are setup_failed (22); bad input never throws', () => {
    const missing = rig();
    missing.runTool = () => { const error = new Error('x'); error.code = 'sandbox_unavailable'; throw error; };
    const lines = [];
    assert.equal(main([MARKER, JSON.stringify(spec(null, '/x'))], missing, { write: (t) => lines.push(t) }), PREP_EXIT.sandbox_unavailable);
    assert.equal(main(['x', 'not json'], rig(), { write: () => {} }), PREP_EXIT.setup_failed);
    assert.equal(main([MARKER], rig(), { write: () => {} }), PREP_EXIT.setup_failed);
    assert.equal(main(['-bad', JSON.stringify(spec(null, '/x'))], rig(), { write: () => {} }), PREP_EXIT.setup_failed);
    assert.equal(main([MARKER, JSON.stringify({ ...spec(null, '/x'), grants: [{ name: '../x', path: '/tmp', dev: '1', ino: '1' }] })], rig(), { write: () => {} }), PREP_EXIT.setup_failed);
    assert.equal(exitCodeFor(new Error('boom')).status, PREP_EXIT.setup_failed);
});

test('as a program: bad arguments exit 22 with one JSON line on stderr and never exec', () => {
    const result = spawnSync(process.execPath, [PREP, MARKER, '{}'], { encoding: 'utf8' });
    assert.equal(result.status, PREP_EXIT.setup_failed);
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.equal(JSON.parse(result.stderr).error, 'setup_failed');
});

test('E: exclusions are masked like protected names, only when they exist, verified, and counted toward the mask limit', () => tree((root) => {
    const { grant, stage } = layout(root);
    fs.mkdirSync(path.join(grant, 'docs'));
    fs.writeFileSync(path.join(grant, 'docs', 'plan.md'), 'p');
    fs.writeFileSync(path.join(grant, 'notes.txt'), 'n');
    fs.mkdirSync(path.join(grant, '.data'));
    fs.writeFileSync(path.join(grant, '.data', 'inside'), 'i');
    const world = rig();
    let extraChecked = null;
    const reopen = () => fs.openSync(grant, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const withExclusions = (exclusions, limits) => spec(null, stage, { grants: [{ name: 'a', ...idOf(grant), exclusions }], ...(limits ? { limits } : {}) });
    runPrep(MARKER, withExclusions(['docs/plan.md', 'notes.txt', 'absent/file', 'sub/.env', '.data/inside']), {
        ...world, openDir: reopen, verify: () => ({ ok: true }), verifyExclusions: (fd, entries) => { extraChecked = entries; return { ok: true }; }
    });
    const masks = world.calls.filter((call) => call[0] === 'mount' && call.includes('-o')).map((call) => call.at(-1).replace(`${stage}/projects/a/`, ''));
    assert.deepEqual(masks.sort(), ['.data', '.env', 'docs/plan.md', 'notes.txt', 'sub/.data', 'sub/x.secrets']);
    assert.deepEqual(extraChecked.map((entry) => entry.rel).sort(), ['docs/plan.md', 'notes.txt'], 'the absent one is skipped, the ones under protected names are covered already');
    assert.ok(!fs.existsSync(path.join(grant, 'absent')), 'nothing created');

    // protected entries (.env, .data, sub/.data, sub/x.secrets = 4) plus two exclusions: the sixth mask is one too many at limit 5
    assert.throws(() => runPrep(MARKER, withExclusions(['docs/plan.md', 'notes.txt'], { maxMasks: 5 }), { ...rig(), openDir: reopen, verify: () => ({ ok: true }), verifyExclusions: () => ({ ok: true }) }), { code: 'mask_scan_limit' });
    runPrep(MARKER, withExclusions(['docs/plan.md', 'notes.txt'], { maxMasks: 6 }), { ...rig(), openDir: reopen, verify: () => ({ ok: true }), verifyExclusions: () => ({ ok: true }) });
}));

test('E: an exclusion through a symlink is refused with invalid_request (exit 24) before any mask is mounted; real verification catches an unmasked exclusion', () => tree((root) => {
    const { grant, stage } = layout(root);
    fs.symlinkSync(root, path.join(grant, 'escape'));
    fs.writeFileSync(path.join(grant, 'notes.txt'), 'n');
    const reopen = () => fs.openSync(grant, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const world = rig();
    const lines = [];
    const code = main([MARKER, JSON.stringify(spec(null, stage, { grants: [{ name: 'a', ...idOf(grant), exclusions: ['escape/x'] }] }))], { ...world, openDir: reopen }, { write: (text) => lines.push(text) });
    assert.equal(code, PREP_EXIT.invalid_request);
    assert.equal(JSON.parse(lines[0]).error, 'invalid_request');
    assert.equal(world.calls.filter((call) => call[0] === 'mount' && call.includes('-o')).length, 0, 'refused before mounting any mask');
    for (const bad of ['/abs', '../up', 'a/../b']) {
        const rejected = [];
        assert.equal(main([MARKER, JSON.stringify(spec(null, stage, { grants: [{ name: 'a', ...idOf(grant), exclusions: [bad] }] }))], rig(), { write: (t) => rejected.push(t) }), PREP_EXIT.invalid_request, bad);
    }
    // the mounts "succeed" in the fake but nothing is really masked: the read-back fails
    assert.throws(() => runPrep(MARKER, spec(null, stage, { grants: [{ name: 'a', ...idOf(grant), exclusions: ['notes.txt'] }] }), { ...rig(), openDir: reopen, verify: () => ({ ok: true }) }), { code: 'mask_unverified' });
}));
