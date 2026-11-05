import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HIDDEN_WORKSPACE_ENTRIES, alaWorkspaceOptions, assertShowableRoot, isHiddenWorkspaceEntry, parseMountinfo,
    podmanWorkspaceArguments, workspaceView, writableSubmounts } from '../server/workspace-view.mjs';
import { RobotPaths } from '../server/robot-paths.mjs';

const ROBOT = 'robot-a';

async function fixture(t, name = 'workspace') {
    const base = await fs.realpath(await fs.mkdtemp('/tmp/rw-view-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const root = path.join(base, name);
    await fs.mkdir(root);
    return { base, root, view: options => workspaceView(root, { robotId: ROBOT, platform: 'darwin', ...options }) };
}

const line = (id, mountPoint, options, rest = '- ext4 /dev/sda1 rw') => `${id} 1 8:1 / ${mountPoint} ${options} shared:1 ${rest}`;

test('an empty root has no mask and keeps its canonical path', async t => {
    const { root, view } = await fixture(t);
    assert.deepEqual(await view(), { root, masks: [], writableSubmounts: [] });
});

test('each hidden entry is masked by its own type: directory, file, and a quarantined Box sibling', async t => {
    const { root, view } = await fixture(t);
    for (const name of ['.data', '.ploinky', '.ploinky-box', '.ploinky-box.old-1']) await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, '.env'), 'SECRET=1');
    await fs.mkdir(path.join(root, 'project'));
    await fs.mkdir(path.join(root, '.ploinkyish'));
    const found = await view();
    assert.deepEqual(found.masks, [
        { path: path.join(root, '.data'), directory: true }, { path: path.join(root, '.env'), directory: false },
        { path: path.join(root, '.ploinky'), directory: true }, { path: path.join(root, '.ploinky-box'), directory: true },
        { path: path.join(root, '.ploinky-box.old-1'), directory: true }]);
    assert.deepEqual(HIDDEN_WORKSPACE_ENTRIES, ['.data', '.ploinky', '.ploinky-box', '.env']);
    assert.ok(isHiddenWorkspaceEntry('.ploinky-box.x') && isHiddenWorkspaceEntry('.env'));
    assert.ok(!isHiddenWorkspaceEntry('.ploinkyish') && !isHiddenWorkspaceEntry('.env.local') && !isHiddenWorkspaceEntry('project'));
});

test('only entries that exist are masked; a robot cannot create the missing ones in a read-only root', async t => {
    const { root, view } = await fixture(t);
    await fs.mkdir(path.join(root, '.data'));
    assert.deepEqual((await view()).masks, [{ path: path.join(root, '.data'), directory: true }]);
});

test('links: inside the root the real target is masked; dangling and outward links show nothing; links to the root or above are refused', async t => {
    const { base, root, view } = await fixture(t);
    await fs.mkdir(path.join(root, 'real'));
    await fs.writeFile(path.join(root, 'real', 'env-file'), 'x');
    await fs.mkdir(path.join(root, 'real', 'data-dir'));
    await fs.symlink(path.join(root, 'real', 'env-file'), path.join(root, '.env'));
    await fs.symlink('real/data-dir', path.join(root, '.data'));
    await fs.symlink(path.join(root, 'missing'), path.join(root, '.ploinky'));
    await fs.mkdir(path.join(base, 'outside'));
    await fs.symlink(path.join(base, 'outside'), path.join(root, '.ploinky-box'));
    assert.deepEqual((await view()).masks, [{ path: path.join(root, 'real', 'data-dir'), directory: true },
        { path: path.join(root, 'real', 'env-file'), directory: false }]);
    for (const place of ['root', 'base', '/']) {
        const other = await fixture(t);
        const target = place === '/' ? place : other[place];
        await fs.symlink(target, path.join(other.root, '.data'));
        await assert.rejects(other.view(), { code: 'WORKSPACE_UNAVAILABLE', statusCode: 409 }, target);
    }
});

test('a mask inside another mask directory is covered by it and not listed twice', async t => {
    const { root, view } = await fixture(t);
    await fs.mkdir(path.join(root, '.data', 'inner'), { recursive: true });
    await fs.symlink(path.join(root, '.data', 'inner'), path.join(root, '.ploinky'));
    await fs.symlink(path.join(root, '.data'), path.join(root, '.ploinky-box'));
    assert.deepEqual((await view()).masks, [{ path: path.join(root, '.data'), directory: true }]);
});

test('a socket or a fifo in place of a hidden entry refuses the view', async t => {
    const socketRoot = await fixture(t);
    const server = net.createServer();
    await new Promise(resolve => server.listen(path.join(socketRoot.root, '.env'), resolve));
    t.after(() => server.close());
    await assert.rejects(socketRoot.view(), { code: 'WORKSPACE_UNAVAILABLE' });
    const fifoRoot = await fixture(t);
    execFileSync('mkfifo', [path.join(fifoRoot.root, '.data')]);
    await assert.rejects(fifoRoot.view(), { code: 'WORKSPACE_UNAVAILABLE' });
});

test('a root that is not an existing directory is refused', async t => {
    const { base } = await fixture(t);
    await assert.rejects(workspaceView(path.join(base, 'missing'), { robotId: ROBOT, platform: 'darwin' }), { code: 'WORKSPACE_UNAVAILABLE' });
    await fs.writeFile(path.join(base, 'file'), 'x');
    await assert.rejects(workspaceView(path.join(base, 'file'), { robotId: ROBOT, platform: 'darwin' }), { code: 'WORKSPACE_UNAVAILABLE' });
    await assert.rejects(workspaceView(base, { platform: 'darwin' }), { code: 'WORKSPACE_UNAVAILABLE' });
});

test('the root cannot be /workspace, the filesystem root or overlap the robot home; /workspace/sub and other homes are fine', () => {
    for (const [root, robot] of [['/workspace', ROBOT], ['/', ROBOT], ['/home', ROBOT], ['/home/admin/explorerQaWorkspace', 'admin'],
        ['/home/admin', 'admin']]) {
        assert.throws(() => assertShowableRoot(root, robot), { code: 'WORKSPACE_UNAVAILABLE', statusCode: 409 }, root);
    }
    assertShowableRoot('/workspace/sub', ROBOT);
    assertShowableRoot('/home/admin/explorerQaWorkspace', 'robot-a');
    assertShowableRoot('/srv/ws', 'admin');
});

test('a root with a space and Unicode keeps its path intact in the view and the container arguments', async t => {
    const { root, view } = await fixture(t, 'proiecte știri');
    await fs.mkdir(path.join(root, '.data'));
    const found = await view();
    assert.equal(found.root, root);
    const args = podmanWorkspaceArguments(found, { cwd: path.join(root, 'app') });
    assert.deepEqual(args.slice(0, 2), ['--volume', `${root}:${root}:ro,rbind`]);
    assert.ok(args.some(value => value.startsWith(`${path.join(root, '.data')}:ro,`)));
});

test('RobotPaths names the validated robot for its own workspace root', async t => {
    const { root } = await fixture(t);
    await fs.mkdir(path.join(root, '.ploinky-box'));
    const paths = new RobotPaths({ dataDir: '/tmp/unused-data', workspaceRoot: root });
    assert.deepEqual(await paths.workspaceView(ROBOT, { platform: 'darwin' }), { root, masks: [{ path: path.join(root, '.ploinky-box'), directory: true }], writableSubmounts: [] });
    await assert.rejects(paths.workspaceView('../x', { platform: 'darwin' }), { code: 'INVALID_INPUT' });
});

test('the mount table decodes escapes and keeps Unicode; a malformed line, an empty table and garbage are refused', () => {
    const entries = parseMountinfo([line(1, '/srv/with\\040space/ünï', 'rw,relatime'), line(2, '/tmp/back\\134slash', 'ro')].join('\n') + '\n');
    assert.deepEqual(entries.map(entry => entry.mountPoint), ['/srv/with space/ünï', '/tmp/back\\slash']);
    assert.deepEqual(entries[0].options, ['rw', 'relatime']);
    for (const bad of ['garbage', '1 2 3', line(1, '/a', 'rw').replace(' - ext4', ' ext4'), line('x', '/a', 'rw'), line(1, 'relative', 'rw'),
        '1 1 8:1 / /a rw shared:1 -']) {
        assert.throws(() => parseMountinfo(bad + '\n'), { code: 'WORKSPACE_UNAVAILABLE' }, bad);
    }
    assert.deepEqual(parseMountinfo(''), []);
});

test('writable submounts: rw below the root and outside the masks only; the last entry per mount point wins', () => {
    const root = '/srv/ws';
    const masks = [{ path: '/srv/ws/.data', directory: true }, { path: '/srv/ws/.env', directory: false }];
    const entries = parseMountinfo([
        line(1, '/srv/ws', 'rw'),
        line(2, '/srv/ws/AdvancedLanguageAgent', 'rw,relatime'),
        line(3, '/srv/ws/.data', 'rw'), line(4, '/srv/ws/.data/.private', 'rw'), line(5, '/srv/ws/.env', 'rw'),
        line(6, '/srv/ws/readonly', 'ro,relatime'),
        line(7, '/srv/ws/flipped', 'rw'), line(8, '/srv/ws/flipped', 'ro'),
        line(9, '/srv/ws/restored', 'ro'), line(10, '/srv/ws/restored', 'rw'),
        line(11, '/srv/ws/with\\040space/ünï', 'rw'),
        line(12, '/srv/other', 'rw'), line(13, '/srv/wsx', 'rw'), line(14, '/', 'rw'),
    ].join('\n'));
    assert.deepEqual(writableSubmounts(entries, root, masks),
        ['/srv/ws/AdvancedLanguageAgent', '/srv/ws/restored', '/srv/ws/with space/ünï']);
});

test('on Linux the mount table is read for this namespace; an unreadable or malformed one refuses the launch', async t => {
    const { root, view } = await fixture(t);
    await fs.mkdir(path.join(root, '.data'));
    const table = [line(1, root, 'rw'), line(2, `${root}/checkout`, 'rw'), line(3, `${root}/.data/.private`, 'rw')].join('\n');
    const reads = [];
    const found = await view({ platform: 'linux', readFile: async file => { reads.push(file); return Buffer.from(table); } });
    assert.deepEqual(reads, ['/proc/self/mountinfo']);
    assert.deepEqual(found.writableSubmounts, [`${root}/checkout`]);
    await assert.rejects(view({ platform: 'linux', readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), { code: 'WORKSPACE_UNAVAILABLE' });
    await assert.rejects(view({ platform: 'linux', readFile: async () => 'not a mount table\n' }), { code: 'WORKSPACE_UNAVAILABLE' });
    // Other platforms have no such table and a missing one is not an error there.
    assert.deepEqual((await view({ platform: 'darwin', readFile: async () => { throw new Error('unused'); } })).writableSubmounts, []);
});

const sample = () => ({ root: '/srv/ws', writableSubmounts: ['/srv/ws/checkout', '/srv/ws/project/vendor'],
    masks: [{ path: '/srv/ws/.data', directory: true }, { path: '/srv/ws/.env', directory: false }] });

test('Podman receives the root read-only and recursive, each writable submount read-only, and masks that cannot copy up', () => {
    assert.deepEqual(podmanWorkspaceArguments(sample(), { cwd: '/srv/ws/project' }), [
        '--volume', '/srv/ws:/srv/ws:ro,rbind',
        '--volume', '/srv/ws/checkout:/srv/ws/checkout:ro',
        '--tmpfs', '/srv/ws/.data:ro,size=64k,mode=0555,nosuid,nodev,noexec,notmpcopyup',
        '--volume', '/dev/null:/srv/ws/.env:ro',
    ]);
    assert.deepEqual(podmanWorkspaceArguments(sample(), { cwd: '/srv/ws/project', volumeFlag: '-v' }).filter(value => value === '-v' || value === '--volume'),
        ['-v', '-v', '-v']);
    // A submount at or below the working folder is left to the folder's own writable mount; one above it is still read-only.
    assert.ok(!podmanWorkspaceArguments(sample(), { cwd: '/srv/ws/project' }).some(value => value.includes('project/vendor')));
    assert.ok(podmanWorkspaceArguments(sample(), { cwd: '/srv/ws/checkout/deeper' }).includes('/srv/ws/checkout:/srv/ws/checkout:ro'));
    assert.ok(podmanWorkspaceArguments(sample()).includes('/srv/ws/project/vendor:/srv/ws/project/vendor:ro'));
    for (const value of podmanWorkspaceArguments(sample()).filter(value => value.includes('/.data:'))) assert.match(value, /notmpcopyup/u);
});

test('Podman arguments refuse paths a volume option cannot carry, a mask over the working folder and a missing view', () => {
    for (const bad of ['/srv/w:s', '/srv/w,s', '/srv/w\ns']) {
        assert.throws(() => podmanWorkspaceArguments({ ...sample(), root: bad }), { code: 'WORKSPACE_UNAVAILABLE' }, bad);
        assert.throws(() => podmanWorkspaceArguments({ ...sample(), writableSubmounts: [bad] }), { code: 'WORKSPACE_UNAVAILABLE' }, bad);
        assert.throws(() => podmanWorkspaceArguments({ ...sample(), masks: [{ path: bad, directory: true }] }), { code: 'WORKSPACE_UNAVAILABLE' }, bad);
    }
    for (const cwd of ['/srv/ws/.data', '/srv/ws/.data/inner', '/srv/ws/.env/x']) {
        assert.throws(() => podmanWorkspaceArguments(sample(), { cwd }), { code: 'WORKSPACE_UNAVAILABLE' }, cwd);
        assert.throws(() => alaWorkspaceOptions(sample(), { cwd }), { code: 'WORKSPACE_UNAVAILABLE' }, cwd);
    }
    assert.throws(() => podmanWorkspaceArguments({ ...sample(), masks: [{ path: '/srv/ws/project/secret', directory: true }] }, { cwd: '/srv/ws/project' }), { code: 'WORKSPACE_UNAVAILABLE' });
    for (const view of [undefined, null, {}, { root: 'relative', masks: [], writableSubmounts: [] }, { root: '/srv', masks: [], writableSubmounts: undefined }]) {
        assert.throws(() => podmanWorkspaceArguments(view), { code: 'WORKSPACE_UNAVAILABLE' });
        assert.throws(() => alaWorkspaceOptions(view, {}), { code: 'WORKSPACE_UNAVAILABLE' });
    }
});

test('ALA receives the root as a plain read-only folder and the masks as ignored paths, and no Environment mask', () => {
    const native = alaWorkspaceOptions(sample(), { cwd: '/srv/ws/project', home: '/data/robots/robot-a/home' });
    assert.deepEqual(native.folders, [{ source: '/srv/ws' }]);
    assert.deepEqual(native.ignoredPaths, ['/srv/ws/project/.roboteam', '/srv/ws/.data', '/srv/ws/.env']);
    // The workspace folder itself is never an exposed export.
    assert.equal(native.folders[0].expose, undefined);
    assert.equal(native.folders[0].alias, undefined);
    assert.equal(native.folders[0].at, undefined);
    // In a container the masks exist at the Podman layer only: ALA cannot name a character device as an ignored path.
    assert.deepEqual(alaWorkspaceOptions(sample(), { cwd: '/srv/ws/project', home: '/home/robot-a', environment: true }).ignoredPaths, ['/srv/ws/project/.roboteam']);
    // In the robot home there is no private project data to mask.
    assert.deepEqual(alaWorkspaceOptions(sample(), { cwd: '/data/robots/robot-a/home', home: '/data/robots/robot-a/home' }).ignoredPaths, ['/srv/ws/.data', '/srv/ws/.env']);
    assert.deepEqual(alaWorkspaceOptions(sample(), { home: '/home/robot-a' }).ignoredPaths, ['/srv/ws/.data', '/srv/ws/.env']);
});
