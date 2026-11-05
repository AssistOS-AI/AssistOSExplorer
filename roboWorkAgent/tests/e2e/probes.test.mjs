import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertDeniedPaths, parseMountinfo, runIsolationProbe, victimPaths, visibleMounts, writableWorkspaceMounts } from './isolation.mjs';
import { checkPersistence } from './persistence.mjs';

// One failing control per probe: each probe must be able to fail.
const options = { robot: 'robot-a', victim: 'robot-b', workspace: '/fixture' };
const denied = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };

test('paths probe fails on a readable sibling path and on a leaked marker, anywhere in the file system or in the workspace', async () => {
    const files = victimPaths({ ...options, servicePid: 42 });
    assert.throws(() => assertDeniedPaths(files, { openSync: (file, flags) => flags === 'r' ? 9 : denied(), closeSync() {} }), /Protected path admitted/u);
    const io = { openSync: denied };
    const search = (global, workspace) => async (command, args) => ({ stdout: args[0] === '/' ? global : workspace });
    await runIsolationProbe({ ...options, probe: 'paths' }, { io, run: search('', '') });
    await assert.rejects(runIsolationProbe({ ...options, probe: 'paths' }, { io, run: search('/leaked/marker-B\n', '') }));
    // The workspace is a separate mount, so the search of the root file system does not enter it.
    await assert.rejects(runIsolationProbe({ ...options, probe: 'paths' }, { io, run: search('', '/fixture/.data/x/marker-B\n') }), /\/fixture\/\.data\/x\/marker-B/u);
    await assert.rejects(runIsolationProbe({ ...options, probe: 'hostlink', project: '/fixture/app' }, { io, run: search('', '/fixture/other/marker-B\n') }));
    // A victim home readable through the workspace fails the probe as well.
    await assert.rejects(runIsolationProbe({ ...options, probe: 'paths' }, { io: { openSync: (file, flags) => file.startsWith('/fixture/.data/.private') ? 9 : denied(), closeSync() {} }, run: search('', '') }),
        /Protected path admitted r access: \/fixture\/\.data\/\.private/u);
});

test('service probe fails on a leaked credential', async () => {
    await assert.rejects(runIsolationProbe({ ...options, probe: 'service', router: 'http://router/tool' }, {
        run: async () => ({ stdout: '' }), request: async () => ({ status: 403 }), env: { PLOINKY_AGENT_SECRET: 'synthetic' },
    }));
});

test('GUI probe fails when a forbidden port answers', async () => {
    const input = { ...options, probe: 'gui', denied: 'http://127.0.0.1:7000', own: 'http://127.0.0.1:4567' };
    await assert.rejects(runIsolationProbe(input, { run: async () => ({ stdout: '' }) }));
});

const inside = (root, value) => value === root || value.startsWith(`${root}/`);
const mount = (id, parent, mountPoint, flags) => `${id} ${parent} 0:${id} / ${mountPoint} ${flags} shared:1 - ext4 /dev/sda1 rw`;
const MOUNTS = () => [mount(10, 1, '/fixture', 'ro,relatime'), mount(11, 10, '/fixture/app', 'rw,relatime'),
    mount(12, 10, '/fixture/.data', 'ro,nosuid,nodev,noexec,relatime')];

// The workspace as one probe sees it from a project folder: a small in-memory file system with the kernel's answers.
function workspaceModel(change = () => {}) {
    const model = {
        dirs: { '/fixture': ['.data', '.env', '.ploinky', '.ploinky-box', 'app', 'other'], '/fixture/.data': [], '/fixture/.ploinky': [], '/fixture/.ploinky-box': [],
            '/fixture/app': ['.roboteam', 'control'], '/fixture/app/.roboteam': [], '/fixture/other': ['readme'] },
        files: { '/fixture/.env': '', '/fixture/app/control': 'c', '/fixture/other/readme': 'r' },
        writable: ['/fixture/app'], readonly: ['/fixture/app/.roboteam'], unreadable: [], mountinfo: MOUNTS().join('\n') + '\n', sockets: '',
        devices: {}, findError: null,
    };
    change(model);
    const refuse = code => { throw Object.assign(new Error(code), { code }); };
    let opened;
    const exists = file => file in model.dirs || file in model.files;
    const io = {
        lstatSync: file => exists(file) ? {} : refuse('ENOENT'),
        readdirSync: directory => model.dirs[directory] ?? refuse('ENOENT'),
        openSync: (file, flags) => {
            if (model.unreadable.includes(file)) refuse('EACCES');
            if (flags === 'r') return exists(file) ? 9 : refuse('ENOENT');
            const allowed = model.writable.some(root => inside(root, file)) && !model.readonly.some(root => inside(root, file));
            if (!allowed) refuse('EROFS');
            if (flags === 'r+' && !exists(file)) refuse('ENOENT');
            opened = file;
            return 9;
        },
        statSync: file => file === '/dev/null' ? { rdev: 259, isCharacterDevice: () => true } : refuse('ENOENT'),
        fstatSync: () => ({ rdev: model.devices[opened] ?? 0, isCharacterDevice: () => opened in model.devices }),
        closeSync() {}, unlinkSync() {},
        readFileSync: (file, encoding) => {
            if (file === '/proc/self/mountinfo') return model.mountinfo;
            if (model.unreadable.includes(file)) refuse('EACCES');
            return file in model.files ? model.files[file] : refuse('ENOENT');
        },
    };
    return { model, io, run: async () => { if (model.findError) throw Object.assign(new Error('find failed'), model.findError); return { stdout: model.sockets }; } };
}
const maskOptions = { ...options, probe: 'masks', control: '/fixture/app/control', sibling: '/fixture/other/readme', env: 'present' };
const maskProbe = (change, extra = {}) => { const { io, run } = workspaceModel(change); return runIsolationProbe({ ...maskOptions, ...extra }, { io, run }); };

test('masks probe passes a read-only workspace with empty masks and fails each hole it can see', async () => {
    const passed = await maskProbe(() => {});
    assert.ok(passed.checks.length >= 9);
    await maskProbe(model => { delete model.files['/fixture/.env']; model.dirs['/fixture'] = model.dirs['/fixture'].filter(name => name !== '.env'); }, { env: 'absent' });
    // Each control removes one protection from a probe that otherwise passes.
    const fails = async (name, change, pattern, extra) => assert.rejects(maskProbe(change, extra), pattern, name);
    for (const name of ['.data', '.ploinky', '.ploinky-box']) {
        await fails(`${name} lists an entry`, model => { model.dirs[`/fixture/${name}`] = ['leak']; }, new RegExp(`${name} is not empty`, 'u'));
        await fails(`${name} accepts a new file`, model => { model.writable.push(`/fixture/${name}`); }, /A new file was admitted/u);
        await fails(`${name} is absent`, model => { delete model.dirs[`/fixture/${name}`]; }, /ENOENT/u);
    }
    await fails('a quarantined Box sibling lists an entry', model => { model.dirs['/fixture'].push('.ploinky-box.old'); model.dirs['/fixture/.ploinky-box.old'] = ['state']; }, /\.ploinky-box\.old is not empty/u);
    await fails('root .env readable with content', model => { model.files['/fixture/.env'] = 'SECRET=1'; }, /content is readable/u);
    await fails('root .env missing though expected', model => { delete model.files['/fixture/.env']; }, /ENOENT/u);
    await fails('root .env present though expected absent', () => {}, /ENOENT|did not throw|Missing expected/u, { env: 'absent' });
    await fails('root .env is a writable regular file', model => { model.writable.push('/fixture/.env'); }, /writable open was admitted/u);
    await fails('root .env is some other writable device', model => { model.writable.push('/fixture/.env'); model.devices['/fixture/.env'] = 7; }, /writable open was admitted/u);
    // A Podman bind of /dev/null over the file may open for writing, and a write to it goes nowhere.
    await maskProbe(model => { model.writable.push('/fixture/.env'); model.devices['/fixture/.env'] = 259; });
    await fails('sibling opens r+', model => { model.writable.push('/fixture/other/readme'); }, /writable open was admitted/u);
    await fails('a new file in the sibling folder succeeds', model => { model.writable.push('/fixture/other'); model.readonly.push('/fixture/other/readme'); }, /A new file was admitted/u);
    await fails('sibling unreadable', model => { model.unreadable.push('/fixture/other/readme'); }, /EACCES/u);
    await fails('the root accepts a new file', model => { model.writable.push('/fixture'); model.readonly.push('/fixture/.data', '/fixture/.env', '/fixture/.ploinky', '/fixture/.ploinky-box', '/fixture/other', '/fixture/app/.roboteam'); }, /A new file was admitted: \/fixture\/robowork-probe/u);
    await fails('the root lacks the sibling first segment', model => { model.dirs['/fixture'] = model.dirs['/fixture'].filter(name => name !== 'other'); }, /does not list/u);
    await fails('the root lacks the working folder first segment', model => { model.dirs['/fixture'] = model.dirs['/fixture'].filter(name => name !== 'app'); }, /does not list/u);
    await fails('the victim home is readable through the workspace', model => {
        model.files['/fixture/.data/.private/roboWorkAgent/robots/robot-b/home/marker-B'] = 'B';
    }, /Protected path admitted/u);
    await fails('the control file is not writable', model => { model.writable = []; }, /EROFS/u);
    await fails('the working folder .roboteam lists an entry', model => { model.dirs['/fixture/app/.roboteam'] = ['conversation']; }, /\.roboteam is not empty/u);
    await fails('the working folder .roboteam accepts a file', model => { model.readonly = []; }, /A new file was admitted/u);
    await fails('a socket is found outside the working folder', model => { model.sockets = '/fixture/other/run.sock\n'; }, /not strictly equal|Expected values/u);
    await fails('a socket is found although find also reports an unreadable directory', model => { model.sockets = '/fixture/other/run.sock\n'; model.findError = { code: 1, stdout: model.sockets }; }, /not strictly equal|Expected values/u);
    // An unreadable directory makes `find` exit 1; its empty output still decides.
    await maskProbe(model => { model.findError = { code: 1, stdout: '' }; });
    await fails('find fails for another reason', model => { model.findError = { code: 2, stdout: '' }; }, /without bounded evidence/u);
    await fails('no control file', () => {}, /control file/u, { control: undefined });
    await fails('control outside a project folder', () => {}, /control file/u, { control: '/fixture/control' });
    await fails('sibling inside the working folder', () => {}, /sibling file/u, { sibling: '/fixture/app/nested/readme' });
    await fails('sibling in a parent of the working folder', () => {}, /sibling file/u, { sibling: '/fixture/readme' });
    await fails('no sibling', () => {}, /sibling file/u, { sibling: undefined });
    await fails('the root .env state is not named', () => {}, /present or absent/u, { env: undefined });
});

test('masks probe judges only visible writable mounts: a mask stacked on a mount hides it, a mount on top of the mask is visible', async () => {
    const withMounts = extra => ({ mountinfo: [...MOUNTS(), ...extra].join('\n') + '\n' });
    const fails = (extra, pattern) => assert.rejects(maskProbe(model => Object.assign(model, withMounts(extra))), pattern);
    const passes = extra => maskProbe(model => Object.assign(model, withMounts(extra)));
    // Podman: `ro,rbind` copies the `.data` mount as rw (id 20, parent: the root mount), and `--tmpfs` stacks the mask on it, so the
    // mask's parent is the copied mount and its mount point the same. The copy and everything below it are hidden.
    const copied = [mount(20, 10, '/fixture/.data', 'rw,relatime'), mount(22, 20, '/fixture/.data/.private', 'rw,relatime')];
    const without = MOUNTS().filter(line => !line.startsWith('12 '));
    const withCopied = extra => ({ mountinfo: [...without, ...copied, ...extra].join('\n') + '\n' });
    await maskProbe(model => Object.assign(model, withCopied([mount(21, 20, '/fixture/.data', 'ro,nosuid,nodev,noexec,relatime')])));
    // The same copy without the stacked mask is exactly the hole: a writable mount that shows.
    await assert.rejects(maskProbe(model => Object.assign(model, withCopied([]))), /\/fixture\/\.data/u);
    // A mount placed on the mask's own tmpfs is visible, and so is one stacked over the mask.
    await assert.rejects(maskProbe(model => Object.assign(model, withCopied([mount(21, 20, '/fixture/.data', 'ro,relatime'), mount(23, 21, '/fixture/.data/x', 'rw')]))), /\/fixture\/\.data\/x/u);
    await assert.rejects(maskProbe(model => Object.assign(model, withCopied([mount(21, 20, '/fixture/.data', 'ro,relatime'), mount(23, 21, '/fixture/.data', 'rw')]))), /\/fixture\/\.data/u);
    // Bubblewrap and a mask mounted beside a copied mount: the later sibling above it covers it, whatever the order.
    await passes([mount(9, 10, '/fixture/.data/.private', 'rw,relatime')]);
    await passes([mount(9, 10, '/fixture/.data/.private', 'rw,relatime'), mount(13, 9, '/fixture/.data/.private/deep', 'rw')]);
    // A stacked pair counts by the top one: each mount is attached to the one it covers.
    await passes([mount(13, 10, '/fixture/other', 'rw'), mount(14, 13, '/fixture/other', 'ro')]);
    await fails([mount(13, 10, '/fixture/other', 'ro'), mount(14, 13, '/fixture/other', 'rw')], /\/fixture\/other/u);
    // A mount below a stacked pair belongs to the covered mount and is lost with it; one on the top mount shows.
    await passes([mount(13, 10, '/fixture/other', 'ro'), mount(15, 13, '/fixture/other/old', 'rw'), mount(14, 13, '/fixture/other', 'ro')]);
    await fails([mount(13, 10, '/fixture/other', 'ro'), mount(14, 13, '/fixture/other', 'ro'), mount(15, 14, '/fixture/other/new', 'rw')], /\/fixture\/other\/new/u);
    await fails([mount(13, 10, '/fixture/other', 'rw,relatime')], /\/fixture\/other/u);
    await fails([mount(13, 10, '/fixture/.ploinky/repos', 'rw')], /\/fixture\/\.ploinky\/repos/u);
    // The root itself must be read-only, and the working folder may be writable, and so may a mount inside it.
    await fails([mount(13, 1, '/fixture', 'rw')], /\/fixture/u);
    await passes([mount(13, 11, '/fixture/app/vendor', 'rw')]);
    // Escaped and non-ASCII mount points are compared by their real names.
    await fails([mount(13, 10, '/fixture/with\\040space/ünï', 'rw')], /with space\/ünï/u);
    // A malformed table is an error, never an empty list.
    await assert.rejects(maskProbe(model => { model.mountinfo = 'not a mount table\n'; }), /malformed/u);
    assert.deepEqual(writableWorkspaceMounts(withMounts([mount(13, 10, '/fixture/other', 'rw')]).mountinfo, '/fixture', '/fixture/app'), ['/fixture/other']);
    assert.deepEqual(visibleMounts(parseMountinfo(withMounts([mount(9, 10, '/fixture/.data/.private', 'rw')]).mountinfo)).map(entry => entry.id), [10, 11, 12]);
    assert.deepEqual(visibleMounts(parseMountinfo(withCopied([mount(21, 20, '/fixture/.data', 'ro')]).mountinfo)).map(entry => entry.id), [10, 11, 21]);
});

test('showthrough probe fails when a mask is bypassed, when unshare is missing or fails for another reason, and passes a permission refusal', async () => {
    const input = { ...options, probe: 'showthrough' };
    const refusal = stderr => Object.assign(new Error('Command failed'), { code: 1, stderr });
    const probe = run => runIsolationProbe(input, { run });
    const arguments_ = [];
    const clean = await probe(async (command, args) => { arguments_.push([command, args]); return { stdout: '' }; });
    assert.deepEqual(clean.checks, ['no mask can be unmounted or bypassed from a namespace of the robot']);
    assert.deepEqual(arguments_[0][1].slice(0, 3), ['-Urm', '/bin/sh', '-c']);
    assert.deepEqual(arguments_[0][1].slice(4), ['sh', '/fixture', 'robot-b']);
    // The script tries all three attacks on the real masks and reports any success.
    assert.match(arguments_[0][1][3], /umount .*\.data[\s\S]*mount --bind[\s\S]*mount --rbind[\s\S]*SHOWN/u);
    for (const output of ['SHOWN\n', 'UNMOUNTED\n', 'ok\nSHOWN\n']) await assert.rejects(probe(async () => ({ stdout: output })), /A mask was bypassed/u);
    assert.deepEqual((await probe(async () => { throw refusal('unshare: unshare failed: Operation not permitted'); })).checks, ['unshare is refused by permission, so no mask can be attacked']);
    assert.deepEqual((await probe(async () => { throw refusal('unshare: Permission denied'); })).checks.length, 1);
    await assert.rejects(probe(async () => { throw Object.assign(new Error('spawn unshare ENOENT'), { code: 'ENOENT' }); }), /unshare is required/u);
    await assert.rejects(probe(async () => { throw refusal('unshare: unrecognized option'); }), /other than a permission refusal/u);
    await assert.rejects(probe(async () => { throw refusal(''); }), /other than a permission refusal/u);
});

test('fd probe fails on an inherited descriptor', async () => {
    // Four links, so only the descriptor checks can make this fail, not the count.
    const line = (fd, target) => `lr-x------ 1 root root 64 Oct 1 00:00 ${fd} -> ${target}\n`;
    const inventory = line(0, '/dev/null') + line(1, 'pipe:[123]') + line(2, 'pipe:[124]');
    await runIsolationProbe({ ...options, probe: 'fds' }, { run: async () => ({ stdout: inventory }) });
    await assert.rejects(runIsolationProbe({ ...options, probe: 'fds' }, { run: async () => ({ stdout: inventory + line(9, '/data/robots/robot-b/home/marker-B') }) }));
    await assert.rejects(runIsolationProbe({ ...options, probe: 'fds' }, { run: async () => ({ stdout: inventory + line(9, 'socket:[555]') }) }), /Unexpected inherited descriptor/u);
});

test('persistence fails on changed bytes or a symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'robowork-probe-'));
    const local = path.join(root, 'marker'); fs.writeFileSync(local, 'owned marker');
    const marker = '/home/robot-a/marker';
    const map = file => file === marker ? local : file;
    const io = new Proxy(fs, { get(target, key) {
        if (['lstatSync', 'openSync'].includes(key)) return (file, ...args) => target[key](map(file), ...args);
        return target[key];
    } });
    const input = { robot: 'robot-a', marker, stage: 'restart', sha256: createHash('sha256').update('owned marker').digest('hex') };
    try {
        fs.writeFileSync(local, 'changed'); assert.throws(() => checkPersistence(input, io), /changed or disappeared/u);
        fs.unlinkSync(local); fs.symlinkSync(path.join(root, 'elsewhere'), local); assert.throws(() => checkPersistence(input, io));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed probe prints no success sentinel', () => {
    const script = fileURLToPath(new URL('./isolation.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--probe', 'symlink', '--robot', 'robot-a', '--victim', 'robot-b', '--workspace', '/fixture'], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /controller acceptance/u);
});
