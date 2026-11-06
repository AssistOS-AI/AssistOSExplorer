import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alaWorkspaceOptions, workspaceView } from '../server/workspace-view.mjs';
import { resolveAlaInstallation } from '../server/ala-installation.mjs';
import { resolveAlaCommand } from '../server/ala-command.mjs';

// A real Bubblewrap check of the workspace view on Linux. It plants real mounts in a private user and mount namespace,
// because a view is only as good as its behaviour over mounts that sit below the root. The test file runs itself a second
// time inside `unshare -Urm`; that run holds every assertion that needs the namespace.
//
// Without Linux, Bubblewrap and `unshare` it skips, which proves nothing. `ROBOWORK_REQUIRE_BWRAP=1` turns a missing
// prerequisite into a failure, so the apparatus gate cannot pass with a skip.
const WORKER = 'ROBOWORK_VIEW_SANDBOX_WORKER';
const SENTINEL = 'ROBOWORK_VIEW_SANDBOX_OK';
const entry = process.env.ACHILLES_ALA_COMMAND || resolveAlaCommand();
const { packageRoot } = await resolveAlaInstallation({ entry });
const load = file => import(pathToFileURL(path.join(packageRoot, 'src', file)).href);

// Every probe prints what it observed; the parent and the worker only compare.
const PROBE = `const fs = require('node:fs'), cp = require('node:child_process');
const [root, own, sibling, escape] = process.argv.slice(1);
const attempt = operation => { try { return { ok: true, value: operation() }; } catch (error) { return { ok: false, code: error.code }; } };
const result = {
    data: attempt(() => fs.readdirSync(root + '/.data')),
    dataPrivate: attempt(() => fs.readdirSync(root + '/.data/.private')),
    createInData: attempt(() => fs.writeFileSync(root + '/.data/new', 'x')),
    env: attempt(() => fs.readFileSync(root + '/.env', 'utf8')),
    writeEnv: attempt(() => fs.writeFileSync(root + '/.env', 'x')),
    ploinky: attempt(() => fs.readdirSync(root + '/.ploinky')),
    box: attempt(() => fs.readdirSync(root + '/.ploinky-box')),
    boxReal: attempt(() => fs.readdirSync(root + '/boxreal')),
    boxOld: attempt(() => fs.readdirSync(root + '/.ploinky-box.old')),
    rootList: attempt(() => fs.readdirSync(root).sort()),
    createInRoot: attempt(() => fs.writeFileSync(root + '/new', 'x')),
    createInSubmount: attempt(() => fs.writeFileSync(root + '/rwmount/new', 'x')),
    siblingRead: attempt(() => fs.readFileSync(sibling + '/own', 'utf8')),
    siblingWrite: attempt(() => fs.writeFileSync(sibling + '/new', 'x')),
    ownWrite: attempt(() => fs.writeFileSync(own + '/new', 'x')),
    roboteam: attempt(() => fs.readdirSync(own + '/.roboteam')),
    createInRoboteam: attempt(() => fs.writeFileSync(own + '/.roboteam/new', 'x')),
};
if (escape) {
    // A robot with a user namespace of its own tries to take a mask away: unmount it, bind the root without its submounts,
    // and bind it recursively. Nothing may print SHOWN or UNMOUNTED.
    const script = [
        'R=$1', 'umount "$R/.data" 2>/dev/null && echo UNMOUNTED', 'umount "$R/.env" 2>/dev/null && echo UNMOUNTED',
        'mkdir -p /tmp/nr /tmp/rb', 'mount --bind "$R" /tmp/nr 2>/dev/null', 'mount --rbind "$R" /tmp/rb 2>/dev/null',
        'for base in "$R" /tmp/nr /tmp/rb; do', '  [ -e "$base/.data/.private/marker-B" ] && echo SHOWN', '  [ -s "$base/.env" ] && echo SHOWN',
        '  [ -e "$base/.ploinky/inside" ] && echo SHOWN', 'done', 'exit 0'].join('\\n');
    const outcome = cp.spawnSync('unshare', ['-Urm', '/bin/sh', '-c', script, 'sh', root], { encoding: 'utf8', timeout: 20000 });
    result.escape = { status: outcome.status, stdout: outcome.stdout, stderr: outcome.stderr, error: outcome.error?.code };
}
console.log(JSON.stringify(result));`;

function prerequisite() {
    if (process.platform !== 'linux') return 'needs Linux';
    const unshare = spawnSync('unshare', ['-Urm', 'true'], { encoding: 'utf8' });
    if (unshare.status !== 0) return `unshare -Urm is unavailable: ${unshare.error?.code || unshare.stderr.trim()}`;
    return '';
}

async function workerMain() {
    const sandbox = await load('coding-agents/sandbox.mjs');
    const { runProcess } = await load('coding-agents/process.mjs');
    assert.ok(sandbox.canStartBubblewrap() && sandbox.canMountPrivateProc(), 'Bubblewrap with a private /proc is required');
    const run = (command, args) => {
        const result = spawnSync(command, args, { encoding: 'utf8' });
        assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
    };
    run('mount', ['--make-rprivate', '/']);
    const base = fs.realpathSync(fs.mkdtempSync('/tmp/rw-view-sbx-'));
    const mounts = [];
    const mountTmpfs = target => { run('mount', ['-t', 'tmpfs', 'tmpfs', target]); mounts.push(target); };
    try {
        // A root with a space and Unicode in its name keeps every argument intact.
        const root = path.join(base, 'proiecte știri');
        const [projA, projB] = ['projA', 'projB'].map(name => path.join(root, name));
        for (const directory of [path.join(root, '.data', '.private'), path.join(root, '.ploinky'), path.join(root, 'boxreal'),
            path.join(root, '.ploinky-box.old'), path.join(root, 'rwmount'), path.join(projA, '.roboteam'), path.join(projB, '.roboteam')]) {
            fs.mkdirSync(directory, { recursive: true });
        }
        // The victim's marker is real, and a mask covers it with an empty tmpfs, as Ploinky does for `.data/.private`.
        fs.writeFileSync(path.join(root, '.data', '.private', 'marker-B'), 'B');
        mountTmpfs(path.join(root, '.data', '.private'));
        fs.writeFileSync(path.join(root, 'rwmount', 'underneath'), 'u');
        mountTmpfs(path.join(root, 'rwmount'));
        fs.writeFileSync(path.join(root, 'rwmount', 'inside'), 'w');
        fs.writeFileSync(path.join(root, '.ploinky', 'inside'), 'p');
        fs.writeFileSync(path.join(root, 'boxreal', 'state'), 's');
        fs.symlinkSync('boxreal', path.join(root, '.ploinky-box'));
        fs.writeFileSync(path.join(root, '.env'), 'SECRET');
        fs.writeFileSync(path.join(projA, 'own'), 'A-own');
        fs.writeFileSync(path.join(projB, 'own'), 'B-own');

        const view = await workspaceView(root, { robotId: 'robot-a' });
        assert.deepEqual(view.masks.map(mask => mask.path).sort(), ['.data', '.env', '.ploinky', '.ploinky-box.old', 'boxreal'].map(name => path.join(root, name)).sort());
        // The link `.ploinky-box` leads to `boxreal`, so the real target is what gets masked.
        assert.ok(!view.masks.some(mask => mask.path === path.join(root, '.ploinky-box')));
        // A writable mount below the root is listed for Podman, which needs it; the one beneath a mask is covered by it.
        assert.deepEqual(view.writableSubmounts, [path.join(root, 'rwmount')]);

        // Control: the marker is real and sits under the mask. A bind of the root without its submounts shows it.
        const flat = path.join(base, 'flat'), deep = path.join(base, 'deep');
        fs.mkdirSync(flat); fs.mkdirSync(deep);
        run('mount', ['--bind', root, flat]); mounts.push(flat);
        assert.ok(fs.readdirSync(path.join(flat, '.data', '.private')).includes('marker-B'), 'The fixture cannot show its marker, so it proves nothing');
        run('mount', ['--rbind', root, deep]); mounts.push(deep);
        assert.deepEqual(fs.readdirSync(path.join(deep, '.data', '.private')), []);

        const sandboxed = async ({ cwd, sibling, ignore, escape = false, withRoot = root, folders = [{ source: withRoot }] }) => {
            const result = await runProcess({ binary: process.execPath, cwd, args: ['-e', PROBE, root, cwd, sibling, escape ? 'escape' : ''],
                sandbox: { backend: 'codex', hostWorkspace: cwd, workspaceTarget: cwd, folders, ignoredPaths: ignore } });
            assert.equal(result.code, 0, result.stderr);
            return JSON.parse(result.stdout);
        };
        const optionsFor = cwd => alaWorkspaceOptions(view, { cwd, home: '/home/robot-a' });

        // Bubblewrap's bind is recursive: without a mask the mount below `.data` is still the empty tmpfs, not the marker.
        const unmasked = await sandboxed({ cwd: projA, sibling: projB, ignore: [path.join(projA, '.roboteam')] });
        assert.deepEqual(unmasked.dataPrivate, { ok: true, value: [] });
        assert.deepEqual(unmasked.data, { ok: true, value: ['.private'] });
        assert.deepEqual(unmasked.createInSubmount, { ok: false, code: 'EROFS' }, 'A submount of the root is read-only too');

        // Two robots in sibling folders, each writing its own and reading the other's.
        const [a, b] = await Promise.all([
            sandboxed({ cwd: projA, sibling: projB, ignore: optionsFor(projA).ignoredPaths, escape: true, folders: optionsFor(projA).folders }),
            sandboxed({ cwd: projB, sibling: projA, ignore: optionsFor(projB).ignoredPaths, folders: optionsFor(projB).folders }),
        ]);
        const refused = outcome => outcome.ok === false && ['EROFS', 'EACCES', 'EPERM'].includes(outcome.code);
        const rootEntries = ['.data', '.env', '.ploinky', '.ploinky-box', '.ploinky-box.old', 'boxreal', 'projA', 'projB', 'rwmount'];
        for (const [seen, siblingContent] of [[a, 'B-own'], [b, 'A-own']]) {
            assert.deepEqual(seen.data, { ok: true, value: [] });
            assert.deepEqual(seen.dataPrivate, { ok: false, code: 'ENOENT' });
            assert.ok(refused(seen.createInData));
            // A masked file reads as empty or is refused; its bytes never appear, and nothing can write it.
            assert.ok(seen.env.ok ? seen.env.value === '' : seen.env.code === 'EACCES', JSON.stringify(seen.env));
            assert.ok(refused(seen.writeEnv));
            for (const name of ['ploinky', 'box', 'boxReal', 'boxOld']) assert.deepEqual(seen[name], { ok: true, value: [] }, name);
            assert.deepEqual(seen.rootList, { ok: true, value: rootEntries });
            assert.ok(refused(seen.createInRoot));
            assert.ok(refused(seen.createInSubmount));
            assert.deepEqual(seen.siblingRead, { ok: true, value: siblingContent });
            assert.ok(refused(seen.siblingWrite));
            assert.deepEqual(seen.ownWrite, { ok: true });
            assert.deepEqual(seen.roboteam, { ok: true, value: [] });
            assert.ok(refused(seen.createInRoboteam));
        }
        // No mask can be removed from inside. A refused `unshare` is a pass of its own kind, and only a permission refusal is one.
        const { escape } = a;
        assert.doesNotMatch(escape.stdout, /SHOWN|UNMOUNTED/u, JSON.stringify(escape));
        if (escape.status !== 0) assert.match(escape.stderr, /not permitted|denied/iu, JSON.stringify(escape));

        // Entries that show nothing are skipped and the sandbox still starts: ALA would otherwise exit on them.
        const other = path.join(base, 'other');
        fs.mkdirSync(path.join(other, 'project', '.roboteam'), { recursive: true });
        fs.mkdirSync(path.join(base, 'outside'));
        fs.symlinkSync(path.join(other, 'missing'), path.join(other, '.env'));
        fs.symlinkSync(path.join(base, 'outside'), path.join(other, '.data'));
        fs.writeFileSync(path.join(other, 'project', 'own'), 'o');
        const bare = await workspaceView(other, { robotId: 'robot-a' });
        assert.deepEqual(bare.masks, []);
        const project = path.join(other, 'project');
        const shown = alaWorkspaceOptions(bare, { cwd: project, home: '/home/robot-a' });
        const result = await runProcess({ binary: process.execPath, cwd: project, args: ['-e', "console.log(JSON.stringify(require('node:fs').readdirSync(process.argv[1]).sort()))", other],
            sandbox: { backend: 'codex', hostWorkspace: project, workspaceTarget: project, folders: shown.folders, ignoredPaths: shown.ignoredPaths } });
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), ['.data', '.env', 'project']);
        process.stdout.write(`${SENTINEL}\n`);
    } finally {
        for (const target of mounts.reverse()) spawnSync('umount', ['-l', target]);
        fs.rmSync(base, { recursive: true, force: true });
    }
}

if (process.env[WORKER]) {
    try { await workerMain(); process.exitCode = 0; }
    catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
} else {
    const required = process.env.ROBOWORK_REQUIRE_BWRAP === '1';
    const missing = prerequisite();
    test('Bubblewrap shows the workspace read-only with its masks over planted mounts and no robot can remove a mask', {
        skip: missing && !required ? missing : false, timeout: 180000,
    }, () => {
        assert.equal(missing, '', 'A required prerequisite is missing');
        const env = { ...process.env, [WORKER]: '1' };
        delete env.NODE_TEST_CONTEXT;
        const outcome = spawnSync('unshare', ['-Urm', process.execPath, fileURLToPath(import.meta.url)], { encoding: 'utf8', env, timeout: 170000 });
        assert.equal(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
        assert.ok(outcome.stdout.includes(SENTINEL), outcome.stdout);
    });
}
