import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    O_NOFOLLOW_ANY, STRATEGIES, classifyGrantRequestPath, defaultStrategy, resolveGrant, sameGrantIdentity
} from '../../server/views/grantResolver.mjs';
import { resolveViewLimits as resolveViewLimitsDefaults } from '../../server/views/viewLimits.mjs';

// Real temporary workspace. The root is realpath'ed because /var and /tmp are symlinks on macOS and O_NOFOLLOW_ANY
// refuses them. Everything created here is removed by the test that made it.
function workspace(context) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rwv-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const directory of ['proj', 'proj/sub', 'a/b', 'other', 'outside-target', '.ploinky/repos/r1/skills', '.ploinky/run', '.data/store']) {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    return root;
}

const openFdCount = () => fs.readdirSync('/dev/fd').length;

async function resolve(root, request, extra = {}, hooks = {}) {
    return resolveGrant(request, { workspaceRoot: root, ...extra }, hooks);
}
const project = (relativePath, access = 'write', role = 'project') => ({ relativePath, access, role });

// ---------------------------------------------------------------------------------------------------------------------

test('the default strategy follows the platform: Darwin here uses darwin-nofollow-any, Linux uses linux-procfd (the real-FS tests below exercise whichever applies)', () => {
    assert.equal(defaultStrategy('darwin'), STRATEGIES.DARWIN);
    assert.equal(defaultStrategy('linux'), STRATEGIES.LINUX);
    assert.equal(defaultStrategy('win32'), null);
    assert.equal(defaultStrategy(), process.platform === 'darwin' ? STRATEGIES.DARWIN : STRATEGIES.LINUX);
    assert.equal(O_NOFOLLOW_ANY, 0x20000000);
});

test('an eligible project resolves to an open descriptor whose identity is the directory, and close releases it', async (t) => {
    const root = workspace(t);
    const before = openFdCount();
    const result = await resolve(root, project('proj/sub'));
    assert.equal(result.ok, true, JSON.stringify(result));
    const { grant } = result;
    const stat = fs.statSync(path.join(root, 'proj/sub'), { bigint: true });
    assert.deepEqual({ ...grant.identity }, { dev: String(stat.dev), ino: String(stat.ino) });
    assert.equal(grant.identityKey, `${stat.dev}:${stat.ino}`);
    const held = fs.fstatSync(grant.fd, { bigint: true });
    assert.equal(held.ino, stat.ino);
    assert.deepEqual([...grant.segments], ['proj', 'sub']);
    assert.equal(grant.strategy, defaultStrategy());
    assert.equal(openFdCount(), before + grant.segments.length + 1, 'the grant root and its walk chain are kept (D-S5-6)');
    await grant.close();
    await grant.close();
    assert.equal(openFdCount(), before);
});

test('a project that contains nested controller state and key-material names is accepted: the view masks them, the resolver does not', async (t) => {
    const root = workspace(t);
    for (const entry of ['.data', '.ploinky', '.ploinky-box', '.roboteam', 'sub/.data', 'sub/.ploinky/repos']) fs.mkdirSync(path.join(root, 'proj', entry), { recursive: true });
    for (const entry of ['.env', 'master-key', 'x.secrets', 'sub/.env']) fs.writeFileSync(path.join(root, 'proj', entry), 'x');
    const result = await resolve(root, project('proj'));
    assert.equal(result.ok, true, JSON.stringify(result));
    await result.grant.close();
});

// A table of refusals. A path that does not exist is refused exactly like one that does, so protected names are no oracle.
const REFUSALS = [
    ['', 'write', 'project', 'workspace_root_not_granted'],
    ['/etc', 'write', 'project', 'absolute_path'],
    ['..', 'write', 'project', 'traversal'],
    ['a/../b', 'write', 'project', 'traversal'],
    ['.', 'write', 'project', 'traversal'],
    ['a/./b', 'write', 'project', 'traversal'],
    ['a//b', 'write', 'project', 'invalid_component'],
    ['a/', 'write', 'project', 'invalid_component'],
    ['a\0b', 'write', 'project', 'invalid_path'],
    ['.data', 'write', 'project', 'protected_component'],
    ['.data', 'read', 'skill-source', 'protected_component'],
    ['.data/store', 'write', 'project', 'protected_component'],
    ['.data/roboteam/worker', 'write', 'project', 'protected_component'],
    ['proj/.DATA.', 'write', 'project', 'protected_component'],
    ['.ploinky', 'write', 'project', 'protected_component'],
    ['.ploinky', 'read', 'skill-source', 'protected_component'],
    ['.ploinky/run', 'write', 'project', 'protected_component'],
    ['.PLOINKY/run', 'write', 'project', 'protected_component'],
    ['.ploinky-box', 'write', 'project', 'protected_component'],
    ['.ploinky-box/x', 'write', 'project', 'protected_component'],
    ['proj/.roboteam', 'write', 'project', 'protected_component'],
    ['proj/.env', 'write', 'project', 'protected_component'],
    ['proj/x.secrets', 'write', 'project', 'protected_component'],
    ['master-key', 'write', 'project', 'protected_component'],
    ['maſter-key', 'write', 'project', 'protected_component'],
    ['proj/.e‌nv', 'write', 'project', 'protected_component'],
    ['．data', 'write', 'project', 'protected_component'],
    // Managed sources under .ploinky/repos (A35(2)).
    ['.ploinky/repos/r1', 'write', 'project', 'managed_source_writable'],
    ['.ploinky/repos/r1/skills', 'write', 'skill-source', 'managed_source_writable'],
    ['.ploinky/repos/r1/agent', 'write', 'project', 'managed_source_writable'],
    ['.ploinky/repos/r1', 'read', 'project', 'managed_source_not_project'],
    ['.ploinky/repos', 'read', 'skill-source', 'managed_source_root_not_grantable'],
    ['.ploinky/repos/r1/.ploinky/x', 'read', 'skill-source', 'protected_component'],
    ['.ploinky/repos/r1/.data', 'read', 'skill-source', 'protected_component'],
    ['.ploinky/repos/r1/.env', 'read', 'skill-source', 'protected_component'],
    ['.ploinky/Repos/r1', 'read', 'skill-source', 'protected_component']
];

for (const [relativePath, access, role, code] of REFUSALS) {
    test(`refused as ${code}: ${JSON.stringify(relativePath)} (${role}, ${access})`, async (t) => {
        const root = workspace(t);
        const before = openFdCount();
        const result = await resolve(root, project(relativePath, access, role));
        assert.equal(result.ok, false);
        assert.equal(result.code, code);
        assert.equal(openFdCount(), before, 'no descriptor survives a refusal');
    });
}

test('an explicitly selected read-only skill-source grant under .ploinky/repos is accepted, and only that', async (t) => {
    const root = workspace(t);
    for (const relativePath of ['.ploinky/repos/r1', '.ploinky/repos/r1/skills']) {
        const result = await resolve(root, project(relativePath, 'read', 'skill-source'));
        assert.equal(result.ok, true, `${relativePath}: ${JSON.stringify(result)}`);
        assert.equal(result.grant.managedSource, true);
        assert.equal(result.grant.access, 'read');
        await result.grant.close();
    }
});

test('a refused request does not touch the file system: existing and missing protected paths get the same answer', async (t) => {
    const root = workspace(t);
    const existing = await resolve(root, project('.data/store'));
    const missing = await resolve(root, project('.data/not-there'));
    const deeper = await resolve(root, project('nothing/.env'));
    for (const result of [existing, missing, deeper]) {
        assert.equal(result.ok, false);
        assert.equal(result.code, 'protected_component');
    }
    assert.equal((await resolve(root, project('nothing/ordinary'))).code, 'not_found');
});

test('the same classification is available without a file system', () => {
    assert.deepEqual(classifyGrantRequestPath(['.ploinky', 'repos', 'r1'], { access: 'read', role: 'skill-source' }), { ok: true, managedSource: true });
    assert.deepEqual(classifyGrantRequestPath(['.ploinky', 'repos', 'r1'], { access: 'write', role: 'skill-source' }), { ok: false, code: 'managed_source_writable' });
    assert.deepEqual(classifyGrantRequestPath(['p', 'q'], { access: 'write', role: 'project' }), { ok: true, managedSource: false });
});

test('malformed requests are refused as invalid', async (t) => {
    const root = workspace(t);
    for (const request of [null, [], 'proj', {}, { relativePath: 'proj', access: 'write' },
        { relativePath: 'proj', access: 'write', role: 'project', extra: true },
        { relativePath: 'proj', access: 'admin', role: 'project' },
        { relativePath: 'proj', access: 'write', role: 'robot' }]) {
        assert.equal((await resolve(root, request)).code, 'invalid_request', JSON.stringify(request));
    }
    assert.equal((await resolve(root, { relativePath: 7, access: 'write', role: 'project' })).code, 'invalid_path');
    assert.equal((await resolve(root, project('x'.repeat(2000)))).code, 'path_too_long');
    assert.equal((await resolve(root, project(Array.from({ length: 40 }, () => 'a').join('/')))).code, 'path_too_deep');
    assert.equal((await resolve(root, project('a'.repeat(300)))).code, 'invalid_component');
    assert.equal((await resolve(path.join(root, 'missing-workspace'), project('proj'))).code, 'workspace_root_unavailable');
    assert.equal((await resolve(root, project('proj'), { strategy: 'win32' })).code, 'unsupported_platform');
});

// --- symbolic links -----------------------------------------------------------------------------------------------------

test('a symbolic link is never followed: as the grant, in the middle, or pointing at controller state', async (t) => {
    const root = workspace(t);
    fs.symlinkSync('proj', path.join(root, 'link-to-proj'));
    fs.symlinkSync(path.join(root, 'outside-target'), path.join(root, 'link-outside'));
    fs.symlinkSync('.data', path.join(root, 'alias'));
    fs.symlinkSync('../..', path.join(root, 'proj/up'));
    fs.symlinkSync('a', path.join(root, 'mid'));
    for (const relativePath of ['link-to-proj', 'link-outside', 'alias', 'alias/store', 'proj/up', 'mid/b', 'link-to-proj/sub']) {
        const before = openFdCount();
        const result = await resolve(root, project(relativePath));
        assert.equal(result.ok, false, relativePath);
        assert.equal(result.code, 'symlink_in_path', relativePath);
        assert.equal(openFdCount(), before, relativePath);
    }
    const control = await resolve(root, project('a/b'));
    assert.equal(control.ok, true, 'positive control: the real path of the same directory resolves');
    await control.grant.close();
});

test('a file in the path is not a directory', async (t) => {
    const root = workspace(t);
    fs.writeFileSync(path.join(root, 'proj/file.txt'), 'x');
    assert.equal((await resolve(root, project('proj/file.txt'))).code, 'not_a_directory');
});

// --- identity-level refusals, with a file system that accepts other spellings -------------------------------------------

// Wraps fs.promises so that one path component resolves to another directory, as a case- or Unicode-insensitive file
// system would for a spelling that the name fold does not know.
function aliasingFs(root, aliases) {
    const map = (target) => {
        for (const [alias, real] of Object.entries(aliases)) {
            const prefix = path.join(root, alias);
            if (target === prefix || target.startsWith(`${prefix}/`)) return path.join(real, target.slice(prefix.length));
        }
        return target;
    };
    return {
        open: (target, flags) => fs.promises.open(map(target), flags),
        lstat: (target, options) => fs.promises.lstat(map(target), options),
        realpath: (target) => fs.promises.realpath(target)
    };
}

test('a component that resolves to controller state under another spelling is refused by identity (protected_alias)', async (t) => {
    const root = workspace(t);
    const fsApi = aliasingFs(root, { 'zdata': path.join(root, '.data'), 'zbox': path.join(root, '.ploinky') });
    for (const relativePath of ['zdata', 'zdata/store', 'zbox/run', 'zbox/repos/r1']) {
        const result = await resolve(root, project(relativePath, 'read', 'skill-source'), { fsApi, strategy: STRATEGIES.DARWIN });
        assert.equal(result.ok, false, relativePath);
        assert.equal(result.code, 'protected_alias', relativePath);
    }
});

test('a request that resolves to the workspace root or to an ancestor of it is refused by identity', async (t) => {
    const root = workspace(t);
    const fsApi = aliasingFs(root, { 'rootalias': root, 'upalias': path.dirname(root) });
    assert.equal((await resolve(root, project('rootalias'), { fsApi, strategy: STRATEGIES.DARWIN })).code, 'workspace_root_not_granted');
    assert.equal((await resolve(root, project('upalias'), { fsApi, strategy: STRATEGIES.DARWIN })).code, 'ancestor_of_workspace_not_granted');
});

// --- the other protected locations ---------------------------------------------------------------------------------------

test('the worker store, other HOMEs and management sockets are refused in both directions, and masked ones are not', async (t) => {
    const root = workspace(t);
    fs.mkdirSync(path.join(root, 'store/worker/state'), { recursive: true });
    fs.mkdirSync(path.join(root, 'homes/robot-b'), { recursive: true });
    fs.mkdirSync(path.join(root, 'run'), { recursive: true });
    fs.mkdirSync(path.join(root, 'future'), { recursive: true });
    fs.writeFileSync(path.join(root, 'run/mgmt.sock'), '');
    fs.mkdirSync(path.join(root, 'proj/.data/store'), { recursive: true });
    const protectedLocations = [
        { label: 'worker store', path: path.join(root, 'store/worker') },
        { label: 'robot HOME', path: path.join(root, 'homes/robot-b') },
        { label: 'management socket', path: path.join(root, 'run/mgmt.sock') },
        { label: 'future store', path: path.join(root, 'future/store') },
        { label: 'masked store', path: path.join(root, 'proj/.data/store') },
        { label: 'elsewhere', path: path.join(path.dirname(root), 'unrelated-dir-that-does-not-exist') }
    ];
    const expectations = [
        ['store/worker', 'inside_protected_location'],
        ['store/worker/state', 'inside_protected_location'],
        ['store', 'contains_protected_location'],
        ['homes/robot-b', 'inside_protected_location'],
        ['homes', 'contains_protected_location'],
        ['run', 'contains_protected_location'],
        ['future', 'contains_protected_location']
    ];
    for (const [relativePath, code] of expectations) {
        const before = openFdCount();
        const result = await resolve(root, project(relativePath), { protectedLocations });
        assert.equal(result.ok, false, relativePath);
        assert.equal(result.code, code, relativePath);
        assert.equal(openFdCount(), before, relativePath);
    }
    for (const relativePath of ['proj', 'other', 'a/b']) {
        const result = await resolve(root, project(relativePath), { protectedLocations });
        assert.equal(result.ok, true, `${relativePath}: ${JSON.stringify(result)}`);
        await result.grant.close();
    }
});

test('a managed-source skill grant is not refused because controller state elsewhere in .ploinky is listed as a location', async (t) => {
    const root = workspace(t);
    fs.writeFileSync(path.join(root, '.ploinky/run/mgmt.sock'), '');
    const result = await resolve(root, project('.ploinky/repos/r1', 'read', 'skill-source'),
        { protectedLocations: [{ label: 'management socket', path: path.join(root, '.ploinky/run/mgmt.sock') }] });
    assert.equal(result.ok, true, JSON.stringify(result));
    await result.grant.close();
});

// --- deterministic races ---------------------------------------------------------------------------------------------------

test('race: a component swapped for a symlink between two steps is refused and leaves no descriptor', async (t) => {
    const root = workspace(t);
    const before = openFdCount();
    const result = await resolve(root, project('a/b'), {}, {
        afterComponent: (index, name) => {
            if (name !== 'a') return;
            fs.renameSync(path.join(root, 'a'), path.join(root, 'a.old'));
            fs.symlinkSync(path.join(root, 'outside-target'), path.join(root, 'a'));
        }
    });
    assert.equal(result.ok, false);
    // Darwin: the next prefix open meets the symlink (ELOOP). Linux (inference, not run here): the descriptor of the
    // renamed-away directory keeps resolving, and the bracket sees a symlink under the old name.
    assert.equal(result.code, defaultStrategy() === STRATEGIES.DARWIN ? 'symlink_in_path' : 'substitution_detected');
    assert.equal(openFdCount(), before);
});

test('race: the last component replaced by a different directory before the bracket is detected', async (t) => {
    const root = workspace(t);
    const before = openFdCount();
    const result = await resolve(root, project('a/b'), {}, {
        beforeVerify: () => {
            fs.renameSync(path.join(root, 'a/b'), path.join(root, 'a/b.old'));
            fs.mkdirSync(path.join(root, 'a/b'));
        }
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'substitution_detected');
    assert.equal(openFdCount(), before);
});

test('race: an ancestor renamed away (rename race) before the bracket is detected', async (t) => {
    const root = workspace(t);
    const before = openFdCount();
    const result = await resolve(root, project('a/b'), {}, { beforeVerify: () => fs.renameSync(path.join(root, 'a'), path.join(root, 'moved-away')) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'substitution_detected');
    assert.equal(openFdCount(), before);
});

test('race: an ancestor replaced by a symlink before the bracket is detected', async (t) => {
    const root = workspace(t);
    const result = await resolve(root, project('a/b'), {}, {
        beforeVerify: () => {
            fs.renameSync(path.join(root, 'a'), path.join(root, 'a-held'));
            fs.symlinkSync(path.join(root, 'outside-target'), path.join(root, 'a'));
        }
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'substitution_detected');
});

test('after resolution the descriptor, not the path, is the grant: a swap of the path afterwards cannot redirect it', async (t) => {
    const root = workspace(t);
    fs.writeFileSync(path.join(root, 'proj/marker.txt'), 'original');
    const { grant } = await resolve(root, project('proj'));
    fs.renameSync(path.join(root, 'proj'), path.join(root, 'proj.moved'));
    fs.symlinkSync(path.join(root, '.data'), path.join(root, 'proj'));
    const held = fs.fstatSync(grant.fd, { bigint: true });
    assert.equal(`${held.dev}:${held.ino}`, grant.identityKey, 'the descriptor still names the original directory');
    const nowAtPath = fs.statSync(path.join(root, 'proj'), { bigint: true });
    assert.notEqual(nowAtPath.ino, held.ino, 'the path now leads somewhere else');
    assert.equal(fs.readdirSync(path.join(root, 'proj.moved')).includes('marker.txt'), true);
    await grant.close();
});

test('negative control: a path-based resolver that checks and then opens by path follows the same swap', async (t) => {
    const root = workspace(t);
    // The weak design: classify with lstat, then open by path.
    const naive = async (relativePath, swap) => {
        const target = path.join(root, relativePath);
        const stat = fs.lstatSync(target);
        assert.equal(stat.isSymbolicLink(), false);
        swap();
        const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        const ino = fs.fstatSync(fd, { bigint: true }).ino;
        fs.closeSync(fd);
        return ino;
    };
    const swap = () => {
        fs.renameSync(path.join(root, 'other'), path.join(root, 'other.old'));
        fs.symlinkSync(path.join(root, 'outside-target'), path.join(root, 'other'));
    };
    const outsideIno = fs.statSync(path.join(root, 'outside-target'), { bigint: true }).ino;
    assert.equal(await naive('other', swap), outsideIno, 'the naive resolver ends up in the outside directory');
    // The real resolver, same attack, same moment: refused. Restore the tree first.
    fs.rmSync(path.join(root, 'other'));
    fs.renameSync(path.join(root, 'other.old'), path.join(root, 'other'));
    const result = await resolve(root, project('other'), {}, { beforeVerify: swap });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'substitution_detected');
});

// --- the Linux strategy in an in-memory model ----------------------------------------------------------------------------------

// A faithful in-memory fs for the Linux strategy: a tree with stable inodes, where `/proc/self/fd/<fd>/<name>` resolves
// relative to the directory that descriptor holds. A held descriptor is keyed by INODE, so it follows its directory
// across a rename or move, as a Linux descriptor does (review finding 4): `/proc/self/fd/<fd>/<name>` resolves from the
// held directory's CURRENT path. Symbolic links and plain files are modelled as Linux treats them (Linux fix delta L-2 and
// review note M1): a path lookup FOLLOWS a symlink in the middle of the path and not the last component (lstat), and an
// open with O_DIRECTORY | O_NOFOLLOW of a trailing symlink fails with ENOTDIR. It records calls. It proves the shape of
// the Linux emulation and the outcomes against that model; behaviour on a real Linux kernel is covered by the Linux-only
// file grantResolver.linux-procfd.mjs.
function treeFs() {
    const calls = [];
    const opened = [];
    const tree = new Map([
        ['/', 1n], ['/ws', 10n], ['/ws/proj', 11n], ['/ws/proj/sub', 12n], ['/ws/.data', 13n], ['/ws/.ploinky', 14n],
        ['/ws/a', 15n], ['/ws/a/b', 16n]
    ]);
    const links = new Map();
    const files = new Map();
    const fds = new Map();
    const lstatFailures = [];
    let nextFd = 40;
    let nextIno = 100n;
    const fail = (code) => Object.assign(new Error(code), { code });
    const pathOfInode = (ino) => {
        for (const [entry, value] of tree) if (value === ino) return entry;
        return null;
    };
    const parentOf = (entry) => entry.slice(0, entry.lastIndexOf('/')) || '/';
    const join = (base, name) => `${base === '/' ? '' : base}/${name}`;
    // Resolves every component but the last through symlinks, as a path lookup does; the last is returned unresolved.
    const resolveMiddle = (target, depth = 0) => {
        const parts = target.split('/').filter(Boolean);
        let current = '/';
        for (const part of parts.slice(0, -1)) current = follow(join(current, part), depth);
        return parts.length === 0 ? '/' : join(current, parts.at(-1));
    };
    const follow = (entry, depth) => {
        if (!links.has(entry)) return entry;
        if (depth > 40) throw fail('ELOOP');
        const { target } = links.get(entry);
        const absolute = target.startsWith('/') ? target : join(parentOf(entry), target);
        const normalized = path.posix.normalize(absolute);
        return follow(resolveMiddle(normalized, depth + 1), depth + 1);
    };
    const resolvePath = (target) => {
        const match = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(target);
        if (!match) return resolveMiddle(path.posix.normalize(target));
        const base = fds.has(Number(match[1])) ? pathOfInode(fds.get(Number(match[1]))) : null;
        if (base === null) throw fail('ENOENT');
        return join(base, match[2]);
    };
    const statOf = (ino, kind) => ({ isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link', dev: 7n, ino });
    const entryStat = (entry) => {
        if (links.has(entry)) return statOf(links.get(entry).ino, 'link');
        if (files.has(entry)) return statOf(files.get(entry), 'file');
        if (tree.has(entry)) return statOf(tree.get(entry), 'dir');
        throw fail('ENOENT');
    };
    return {
        calls,
        opened,
        tree,
        lstatFailures,
        openCount: () => fds.size,
        // Another writer renames or moves an entry: it and every path below it change, inodes stay.
        move(from, to) {
            for (const map of [tree, links, files]) {
                for (const [entry, value] of [...map]) {
                    if (entry === from || entry.startsWith(`${from}/`)) {
                        map.delete(entry);
                        map.set(`${to}${entry.slice(from.length)}`, value);
                    }
                }
            }
        },
        symlink(target, linkPath) {
            nextIno += 1n;
            links.set(linkPath, { target, ino: nextIno });
        },
        file(filePath) {
            nextIno += 1n;
            files.set(filePath, nextIno);
        },
        realpath: async (target) => target,
        open: async (target, flags) => {
            calls.push(['open', target, flags]);
            let resolved = resolvePath(target);
            if (links.has(resolved)) {
                if (flags & fs.constants.O_NOFOLLOW) throw fail(flags & fs.constants.O_DIRECTORY ? 'ENOTDIR' : 'ELOOP');
                resolved = follow(resolved, 0);
            }
            if (files.has(resolved) && (flags & fs.constants.O_DIRECTORY)) throw fail('ENOTDIR');
            const { ino } = entryStat(resolved);
            nextFd += 1;
            const fd = nextFd;
            fds.set(fd, ino);
            opened.push([target, fd]);
            return {
                fd,
                stat: async () => { calls.push(['fstat', fd]); return statOf(ino, 'dir'); },
                close: async () => { calls.push(['close', fd]); fds.delete(fd); }
            };
        },
        lstat: async (target) => {
            calls.push(['lstat', target]);
            const code = lstatFailures.shift();
            if (code) throw fail(code);
            return entryStat(resolvePath(target));
        }
    };
}

test('Linux strategy call shape: each component is opened relative to the previous descriptor with O_NOFOLLOW | O_DIRECTORY, and the model resolves', async () => {
    const fsApi = treeFs();
    const result = await resolveGrant(project('proj/sub'), { workspaceRoot: '/ws', strategy: STRATEGIES.LINUX, fsApi }, {});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.grant.identityKey, '7:12');
    assert.equal(result.grant.strategy, STRATEGIES.LINUX);
    const opens = fsApi.calls.filter((call) => call[0] === 'open');
    assert.equal(opens.length, 3);
    assert.equal(opens[0][1], '/ws');
    assert.match(opens[1][1], /^\/proc\/self\/fd\/41\/proj$/);
    assert.match(opens[2][1], /^\/proc\/self\/fd\/42\/sub$/);
    for (const [, , flags] of opens) {
        assert.ok(flags & fs.constants.O_NOFOLLOW, 'O_NOFOLLOW');
        assert.ok(flags & fs.constants.O_DIRECTORY, 'O_DIRECTORY');
        assert.equal(flags & O_NOFOLLOW_ANY, 0, 'the Darwin flag is not used on Linux');
    }
    const procLstats = fsApi.calls.filter((call) => call[0] === 'lstat' && call[1].startsWith('/proc'));
    assert.equal(procLstats.length, 2, 'one bracket re-resolution per component');
    for (const [, target] of procLstats) {
        assert.match(target, /^\/proc\/self\/fd\/\d+\/[^/]+$/, 'the bracket also re-resolves relative to the parent descriptor');
    }
    assert.equal(fsApi.calls.filter((call) => call[0] === 'close').length, 0, 'the walk chain and the grant root are kept (D-S5-6)');
    await result.grant.close();
    assert.deepEqual(fsApi.calls.filter((call) => call[0] === 'close').map((call) => call[1]).sort(), [41, 42, 43], 'close releases the root and the chain');
});

test('Linux strategy model: a component replaced before the bracket is a substitution and every descriptor is closed', async () => {
    const fsApi = treeFs();
    const result = await resolveGrant(project('proj/sub'), { workspaceRoot: '/ws', strategy: STRATEGIES.LINUX, fsApi },
        { beforeVerify: () => { fsApi.tree.set('/ws/proj/sub', 99n); } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'substitution_detected');
    assert.equal(fsApi.calls.filter((call) => call[0] === 'close').length, 3);
});

test('Linux strategy model: controller state and an unknown component are refused like on Darwin', async () => {
    const fsApi = treeFs();
    assert.equal((await resolveGrant(project('.data'), { workspaceRoot: '/ws', strategy: STRATEGIES.LINUX, fsApi }, {})).code, 'protected_component');
    assert.equal((await resolveGrant(project('nothing'), { workspaceRoot: '/ws', strategy: STRATEGIES.LINUX, fsApi }, {})).code, 'not_found');
});

// --- identity comparison for continuations (A35(3), R4-8) -----------------------------------------------------------------------

test('grant identities compare by device and inode and never equal when one is missing', () => {
    assert.equal(sameGrantIdentity({ dev: '1', ino: '2' }, { dev: '1', ino: '2' }), true);
    assert.equal(sameGrantIdentity({ dev: '1', ino: '2' }, { dev: '1', ino: '3' }), false);
    assert.equal(sameGrantIdentity({ dev: '1', ino: '2' }, { dev: '9', ino: '2' }), false);
    for (const missing of [null, undefined, {}, { dev: '1' }, { ino: '2' }]) {
        assert.equal(sameGrantIdentity(missing, missing), false);
        assert.equal(sameGrantIdentity({ dev: '1', ino: '2' }, missing), false);
    }
});

test('a replaced directory has a different identity, so a continuation can refuse it', async (t) => {
    const root = workspace(t);
    const first = await resolve(root, project('proj'));
    const originalIdentity = { ...first.grant.identity };
    await first.grant.close();
    fs.renameSync(path.join(root, 'proj'), path.join(root, 'proj.old'));
    fs.mkdirSync(path.join(root, 'proj'));
    const second = await resolve(root, project('proj'));
    assert.equal(second.ok, true);
    assert.equal(sameGrantIdentity(originalIdentity, second.grant.identity), false);
    await second.grant.close();
});

// --- binding verification of the grant root and its outside ancestors (decision D-S5-6) -------------------------------------
// Real file system with the platform's default strategy: 'darwin-nofollow-any' on the Mac, 'linux-procfd' on Linux (the
// R-A apparatus run exercised these tests on Linux, host /tmp, outside the Box). Linux-specific expectations are in the
// Linux-only file grantResolver.linux-procfd.mjs; the Box file system is G4/G6 work.

const GRANT_KEYS = ['access', 'anchorIdentityKey', 'close', 'componentIdentities', 'fd', 'handle', 'identity', 'identityKey',
    'managedSource', 'role', 'segments', 'strategy', 'verifyBinding'];

async function grantFor(root, relativePath, access = 'write', role = 'project', extra = {}) {
    const result = await resolve(root, project(relativePath, access, role), extra);
    assert.equal(result.ok, true, `${relativePath}: ${JSON.stringify(result)}`);
    return result.grant;
}

const mv = (root, from, to) => fs.renameSync(path.join(root, from), path.join(root, to));

test('verifyBinding: an unchanged grant is bound, the grant exposes no chain handle, and verification opens no descriptor', async (t) => {
    const root = workspace(t);
    const before = openFdCount();
    const grant = await grantFor(root, 'a/b');
    assert.deepEqual(Object.keys(grant).sort(), GRANT_KEYS, 'the exact key set: no chain descriptor is reachable from the grant (M3)');
    assert.equal(grant.componentIdentities.length, grant.segments.length + 1);
    assert.ok(Object.isFrozen(grant.componentIdentities));
    const rootStat = fs.statSync(root, { bigint: true });
    assert.equal(grant.anchorIdentityKey, `${rootStat.dev}:${rootStat.ino}`);
    assert.equal(grant.componentIdentities.at(-1), grant.identityKey);
    const held = openFdCount();
    assert.equal(held, before + 3);
    assert.deepEqual(await grant.verifyBinding(), { state: 'bound' });
    assert.equal(openFdCount(), held, 'no descriptor growth during verification');
    await grant.close();
    await grant.close();
    assert.equal(openFdCount(), before, 'the root and the chain are released');
    assert.deepEqual(await grant.verifyBinding(), { state: 'unbound', code: 'grant_closed', index: null });
});

for (const [label, relativePath, from, to, code, index] of [
    ['the root moved into .data', 'proj', 'proj', '.data/proj', 'root_unbound', 0],
    ['the root renamed in place to a protected name', 'proj', 'proj', '.Env.', 'root_unbound', 0],
    ['an outside ancestor moved under .ploinky', 'a/b', 'a', '.ploinky/a', 'ancestor_unbound', 0],
    ['an outside ancestor renamed to .ploinky-box', 'a/b', 'a', '.ploinky-box', 'ancestor_unbound', 0],
    ['an ordinary rename of the root (risk K1: the binding cannot be proven)', 'proj', 'proj', 'proj2', 'root_unbound', 0],
    ['an ordinary rename of an outside ancestor', 'a/b', 'a', 'a2', 'ancestor_unbound', 0],
    ['the root moved within its parent chain', 'proj/sub', 'proj/sub', 'other/sub', 'root_unbound', 1]
]) {
    test(`verifyBinding: ${label} is unbound (${code})`, async (t) => {
        const root = workspace(t);
        const grant = await grantFor(root, relativePath);
        assert.deepEqual(await grant.verifyBinding(), { state: 'bound' }, 'positive control before the move');
        mv(root, from, to);
        assert.deepEqual(await grant.verifyBinding(), { state: 'unbound', code, index });
        await grant.close();
    });
}

test('verifyBinding: a root renamed away and replaced by a new directory is an identity mismatch', async (t) => {
    const root = workspace(t);
    const grant = await grantFor(root, 'proj');
    mv(root, 'proj', 'proj.old');
    fs.mkdirSync(path.join(root, 'proj'));
    assert.deepEqual(await grant.verifyBinding(), { state: 'unbound', code: 'identity_mismatch', index: 0 });
    await grant.close();
});

test('verifyBinding: an ancestor replaced by a symlink to the original directory is unbound, although the path still leads there', async (t) => {
    const root = workspace(t);
    const grant = await grantFor(root, 'a/b');
    mv(root, 'a', 'a-held');
    fs.symlinkSync('a-held', path.join(root, 'a'));
    assert.equal(fs.statSync(path.join(root, 'a/b'), { bigint: true }).ino, BigInt(grant.identity.ino), 'the scenario is real: a/b still resolves to the grant');
    assert.deepEqual(await grant.verifyBinding(), { state: 'unbound', code: 'symlink_in_path', index: 0 });
    await grant.close();
});

test('negative control: an identity-only verifier (fstat of the held root) still says bound after an ancestor move; verifyBinding does not', async (t) => {
    const root = workspace(t);
    const grant = await grantFor(root, 'a/b');
    // The weak design: the held root descriptor still names the recorded directory, so "nothing changed".
    const identityOnly = () => {
        const held = fs.fstatSync(grant.fd, { bigint: true });
        return `${held.dev}:${held.ino}` === grant.identityKey ? 'bound' : 'unbound';
    };
    mv(root, 'a', '.ploinky/a');
    assert.equal(identityOnly(), 'bound', 'the identity-only check misses the move');
    assert.equal((await grant.verifyBinding()).state, 'unbound', 'the chain verification refuses it');
    await grant.close();
});

// A wrapper of fs.promises whose lstat fails with queued error codes, armed after the resolution.
function faultyFs() {
    const failures = [];
    return {
        failures,
        open: (target, flags) => fs.promises.open(target, flags),
        lstat: async (target, options) => {
            const code = failures.shift();
            if (code) throw Object.assign(new Error(code), { code });
            return fs.promises.lstat(target, options);
        },
        realpath: (target) => fs.promises.realpath(target)
    };
}

test('verifyBinding: EACCES, EIO and EMFILE are unproven (never bound) and not sticky', async (t) => {
    const root = workspace(t);
    const fsApi = faultyFs();
    const grant = await grantFor(root, 'a/b', 'write', 'project', { fsApi });
    for (const code of ['EACCES', 'EIO', 'EMFILE']) {
        fsApi.failures.push(code);
        assert.deepEqual(await grant.verifyBinding(), { state: 'unproven', code: 'verify_failed', errno: code });
    }
    fsApi.failures.push(undefined, 'EIO');
    assert.deepEqual(await grant.verifyBinding(), { state: 'unproven', code: 'verify_failed', errno: 'EIO' },
        'a failure of the second lstat: on Darwin the index-1 prefix; on Linux the index-0 anchored path check (step 3), after the index-0 edge passed');
    assert.deepEqual(await grant.verifyBinding(), { state: 'bound' }, 'not sticky');
    await grant.close();
});

test('unproven is not sticky, through the real resolver: unproven, then bound again, then unbound after a move', async (t) => {
    const root = workspace(t);
    const fsApi = faultyFs();
    const grant = await grantFor(root, 'proj', 'write', 'project', { fsApi });
    assert.deepEqual(await grant.verifyBinding(), { state: 'bound' });
    fsApi.failures.push('EACCES');
    assert.equal((await grant.verifyBinding()).state, 'unproven');
    assert.deepEqual(await grant.verifyBinding(), { state: 'bound' });
    mv(root, 'proj', '.data/proj');
    assert.equal((await grant.verifyBinding()).code, 'root_unbound');
    await grant.close();
});

test('verifyBinding: managed sources stay bound in place and are unbound when renamed, re-cloned or moved', async (t) => {
    const root = workspace(t);
    const inPlace = await grantFor(root, '.ploinky/repos/r1', 'read', 'skill-source');
    assert.equal(inPlace.managedSource, true);
    assert.deepEqual(await inPlace.verifyBinding(), { state: 'bound' }, 'segments 0-1 are not reclassified');
    fs.writeFileSync(path.join(root, '.ploinky/repos/r1/skills/new.md'), 'pulled');
    assert.deepEqual(await inPlace.verifyBinding(), { state: 'bound' }, 'a git pull in place keeps the directory identity');
    mv(root, '.ploinky/repos/r1', '.ploinky/repos/r2');
    assert.deepEqual(await inPlace.verifyBinding(), { state: 'unbound', code: 'root_unbound', index: 2 });
    fs.mkdirSync(path.join(root, '.ploinky/repos/r1'));
    assert.deepEqual(await inPlace.verifyBinding(), { state: 'unbound', code: 'identity_mismatch', index: 2 }, 're-cloned under the same name');
    await inPlace.close();

    const moved = await grantFor(root, '.ploinky/repos/r2', 'read', 'skill-source');
    mv(root, '.ploinky/repos/r2', '.data/r1');
    assert.equal((await moved.verifyBinding()).state, 'unbound');
    await moved.close();

    const projectGrant = await grantFor(root, 'proj');
    mv(root, 'proj', '.ploinky/repos/x');
    assert.deepEqual(await projectGrant.verifyBinding(), { state: 'unbound', code: 'root_unbound', index: 0 }, 'the exemption never applies to a project grant');
    await projectGrant.close();
});

test('verifyBinding: a rename injected between two components is unbound', async (t) => {
    const root = workspace(t);
    const grant = await grantFor(root, 'a/b');
    const result = await grant.verifyBinding({ beforeComponent: (index) => { if (index === 1) mv(root, 'a', 'a.moved'); } });
    assert.equal(result.state, 'unbound');
    assert.equal(result.index, 1);
    await grant.close();
});

test('verifyBinding: a close during a verification answers grant_closed, never bound, and releases every descriptor afterwards', async (t) => {
    const root = workspace(t);
    const before = openFdCount();
    const grant = await grantFor(root, 'a/b');
    let closing;
    const result = await grant.verifyBinding({ beforeComponent: (index) => { if (index === 1) closing = grant.close(); } });
    assert.deepEqual(result, { state: 'unbound', code: 'grant_closed', index: null });
    await closing;
    assert.equal(openFdCount(), before);
});

test('verifyBinding: a grant at the maximum depth verifies, and holds depth + 1 descriptors until it is closed', async (t) => {
    const root = workspace(t);
    const depth = resolveViewLimitsDefaults().maxGrantPathDepth;
    const relativePath = Array.from({ length: depth }, (_, index) => `d${index}`).join('/');
    fs.mkdirSync(path.join(root, relativePath), { recursive: true });
    const before = openFdCount();
    const grant = await grantFor(root, relativePath);
    assert.equal(grant.segments.length, depth);
    assert.equal(openFdCount(), before + depth + 1);
    assert.deepEqual(await grant.verifyBinding(), { state: 'bound' });
    mv(root, 'd0/d1', 'd0/.data');
    assert.deepEqual(await grant.verifyBinding(), { state: 'unbound', code: 'ancestor_unbound', index: 1 });
    await grant.close();
    assert.equal(openFdCount(), before);
});

// --- the Linux procedure, in the inode-keyed model -------------------------------------------------------------------------

test('Linux model: verifyBinding issues, per component, the edge lstat and then the anchored path lstat, plus fstat of held descriptors, and opens nothing', async () => {
    const fsApi = treeFs();
    const { grant } = await resolveGrant(project('proj/sub'), { workspaceRoot: '/ws', strategy: STRATEGIES.LINUX, fsApi }, {});
    fsApi.calls.length = 0;
    assert.deepEqual(await grant.verifyBinding(), { state: 'bound' });
    // Deliberate expectation change of the Linux fix delta (L-1, option B): the anchored path follows each edge check.
    assert.deepEqual(fsApi.calls.filter((call) => call[0] === 'lstat').map((call) => call[1]),
        ['/proc/self/fd/41/proj', '/ws/proj', '/proc/self/fd/42/sub', '/ws/proj/sub']);
    assert.deepEqual(fsApi.calls.filter((call) => call[0] !== 'lstat' && call[0] !== 'fstat'), [], 'no open and no close');
    fsApi.move('/ws/proj/sub', '/ws/.data/sub');
    assert.deepEqual(await grant.verifyBinding(), { state: 'unbound', code: 'root_unbound', index: 1 });
    await grant.close();
});

test('Linux model: an outside ancestor moved under .ploinky is ancestor_unbound at index 0, although the held root is untouched', async () => {
    const fsApi = treeFs();
    const { grant } = await resolveGrant(project('a/b'), { workspaceRoot: '/ws', strategy: STRATEGIES.LINUX, fsApi }, {});
    assert.deepEqual(await grant.verifyBinding(), { state: 'bound' });
    fsApi.move('/ws/a', '/ws/.ploinky/a');
    assert.deepEqual(await grant.verifyBinding(), { state: 'unbound', code: 'ancestor_unbound', index: 0 });
    await grant.close();
});

test('negative control (Linux model): a root-only verifier says bound after the ancestor move, because the held parent follows its directory', async () => {
    const fsApi = treeFs();
    const { grant } = await resolveGrant(project('a/b'), { workspaceRoot: '/ws', strategy: STRATEGIES.LINUX, fsApi }, {});
    const parentFd = fsApi.opened.find(([target]) => /\/a$/.test(target))[1];
    // The weak design (probe F moved one level up): check only the root under its held parent.
    const rootOnly = async () => {
        const stat = await fsApi.lstat(`/proc/self/fd/${parentFd}/b`).catch(() => null);
        return stat && `${stat.dev}:${stat.ino}` === grant.componentIdentities.at(-1) ? 'bound' : 'unbound';
    };
    fsApi.move('/ws/a', '/ws/.ploinky/a');
    assert.equal(await rootOnly(), 'bound', 'the model is faithful: the held parent of the root moved with it');
    assert.equal((await grant.verifyBinding()).state, 'unbound', 'the anchored top-down verification refuses it');
    await grant.close();
});

test('Linux model: a grant root replaced under its held parent is an identity mismatch', async () => {
    const fsApi = treeFs();
    const { grant } = await resolveGrant(project('proj/sub'), { workspaceRoot: '/ws', strategy: STRATEGIES.LINUX, fsApi }, {});
    fsApi.tree.set('/ws/proj/sub', 99n);
    assert.deepEqual(await grant.verifyBinding(), { state: 'unbound', code: 'identity_mismatch', index: 1 });
    await grant.close();
});

// --- S5 Linux fix delta (L-1 option B, L-2; review notes M1-M3), in the inode-keyed Linux model ------------------------------

const linuxGrant = async (fsApi, relativePath, hooks = {}) => resolveGrant(project(relativePath), { workspaceRoot: '/ws', strategy: STRATEGIES.LINUX, fsApi }, hooks);

test('Linux model (M3): an already-verified ancestor renamed in the middle of verification is root_unbound at index 1', async () => {
    const fsApi = treeFs();
    const { grant } = await linuxGrant(fsApi, 'a/b');
    const result = await grant.verifyBinding({ beforeComponent: (index) => { if (index === 1) fsApi.move('/ws/a', '/ws/a.moved'); } });
    assert.deepEqual(result, { state: 'unbound', code: 'root_unbound', index: 1 });
    await grant.close();
});

test('negative control (M3): a Linux verifier without the anchored path step says bound for the same in-pass rename', async () => {
    const fsApi = treeFs();
    const { grant } = await linuxGrant(fsApi, 'a/b');
    const held = fsApi.opened.map(([, fd]) => fd);
    // The r5 Linux procedure: per component, the held parent and the edge only (steps 1 and 2, no step 3).
    const edgeOnly = async (beforeComponent) => {
        for (let index = 0; index < grant.segments.length; index += 1) {
            beforeComponent(index);
            const stat = await fsApi.lstat(`/proc/self/fd/${held[index]}/${grant.segments[index]}`).catch(() => null);
            if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || `${stat.dev}:${stat.ino}` !== grant.componentIdentities[index + 1]) return 'unbound';
        }
        return 'bound';
    };
    assert.equal(await edgeOnly((index) => { if (index === 1) fsApi.move('/ws/a', '/ws/a.moved'); }), 'bound', 'the edge check alone misses the move');
    fsApi.move('/ws/a.moved', '/ws/a');
    const real = await grant.verifyBinding({ beforeComponent: (index) => { if (index === 1) fsApi.move('/ws/a', '/ws/a.moved'); } });
    assert.deepEqual(real, { state: 'unbound', code: 'root_unbound', index: 1 }, 'the real verifier refuses it');
    await grant.close();
});

test('Linux model: an ancestor moved into .data in the middle of verification, and the component being checked, are refused in the pass', async () => {
    const intoData = treeFs();
    const first = (await linuxGrant(intoData, 'a/b')).grant;
    assert.deepEqual(await first.verifyBinding({ beforeComponent: (index) => { if (index === 1) intoData.move('/ws/a', '/ws/.data/a'); } }),
        { state: 'unbound', code: 'root_unbound', index: 1 });
    await first.close();
    const current = treeFs();
    const second = (await linuxGrant(current, 'a/b')).grant;
    assert.deepEqual(await second.verifyBinding({ beforeComponent: (index) => { if (index === 1) current.move('/ws/a/b', '/ws/a/b2'); } }),
        { state: 'unbound', code: 'root_unbound', index: 1 });
    await second.close();
});

test('Linux model: a rename of the workspace root after admission is ancestor_unbound at index 0, as on Darwin', async () => {
    const fsApi = treeFs();
    const { grant } = await linuxGrant(fsApi, 'a/b');
    assert.deepEqual(await grant.verifyBinding(), { state: 'bound' });
    fsApi.move('/ws', '/ws-renamed');
    assert.deepEqual(await grant.verifyBinding(), { state: 'unbound', code: 'ancestor_unbound', index: 0 });
    await grant.close();
});

test('Linux model residual (M1): an ancestor renamed in the pass and replaced by a symlink to its new place is bound in that pass and refused at the next', async () => {
    const fsApi = treeFs();
    const { grant } = await linuxGrant(fsApi, 'a/b');
    const inPass = await grant.verifyBinding({
        beforeComponent: (index) => {
            if (index !== 1) return;
            fsApi.move('/ws/a', '/ws/.data/a');
            fsApi.symlink('.data/a', '/ws/a');
        }
    });
    // The model follows the middle link on a path lstat, as Linux does, so this is the real residual and not an artefact.
    const viaLink = await fsApi.lstat('/ws/a/b');
    assert.equal(`${viaLink.dev}:${viaLink.ino}`, grant.componentIdentities[2], 'the anchored path reaches b through the link');
    assert.deepEqual(inPass, { state: 'bound' }, 'documented residual: caught only at the next renewal');
    assert.deepEqual(await grant.verifyBinding(), { state: 'unbound', code: 'symlink_in_path', index: 0 }, 'the next pass sees the link at its edge');
    await grant.close();
});

test('Linux model (L-2): a symlink as the grant or in the middle is refused as symlink_in_path; a file stays not_a_directory; nothing stays open', async () => {
    for (const [relativePath, setup, code] of [
        ['link-to-proj', (fsApi) => fsApi.symlink('proj', '/ws/link-to-proj'), 'symlink_in_path'],
        ['mid/b', (fsApi) => fsApi.symlink('a', '/ws/mid'), 'symlink_in_path'],
        ['link-to-proj/sub', (fsApi) => fsApi.symlink('proj', '/ws/link-to-proj'), 'symlink_in_path'],
        ['alias', (fsApi) => fsApi.symlink('/ws/.data', '/ws/alias'), 'symlink_in_path'],
        ['proj/file.txt', (fsApi) => fsApi.file('/ws/proj/file.txt'), 'not_a_directory']
    ]) {
        const fsApi = treeFs();
        setup(fsApi);
        const result = await linuxGrant(fsApi, relativePath);
        assert.equal(result.ok, false, relativePath);
        assert.equal(result.code, code, relativePath);
        assert.equal(fsApi.openCount(), 0, `${relativePath}: every descriptor is closed`);
    }
    const failing = treeFs();
    failing.symlink('proj', '/ws/link-to-proj');
    failing.lstatFailures.push('EIO');
    const unknown = await linuxGrant(failing, 'link-to-proj');
    assert.equal(unknown.code, 'not_a_directory', 'an lstat that fails after ENOTDIR keeps not_a_directory (nit N1)');
    assert.equal(failing.openCount(), 0, 'and closes every descriptor');
});

test('Linux model (M2): an ancestor renamed between two bracket steps of the admission is a substitution, and nothing stays open', async () => {
    const fsApi = treeFs();
    let edgeAfterMove = null;
    const result = await linuxGrant(fsApi, 'a/b', {
        beforeBracketComponent: async (index) => {
            if (index !== 1) return;
            fsApi.move('/ws/a', '/ws/a.moved');
            // The scenario is real: through the held descriptor of `a` (fd 42), the edge of `b` still resolves after the
            // move, so the edge bracket alone would accept the admission.
            edgeAfterMove = await fsApi.lstat('/proc/self/fd/42/b');
        }
    });
    assert.equal(edgeAfterMove.ino, 16n);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'substitution_detected');
    assert.equal(fsApi.openCount(), 0);
    const control = treeFs();
    const ok = await linuxGrant(control, 'a/b', { beforeBracketComponent: (index) => { if (index === 1) control.move('/ws/proj', '/ws/proj2'); } });
    assert.equal(ok.ok, true, 'positive control: a rename elsewhere in the workspace does not refuse the admission');
    await ok.grant.close();
});

test('the Linux-only test file declares its exact test count, which the Linux acceptance checks (review note M4)', () => {
    const expected = JSON.parse(fs.readFileSync(new URL('./grantResolver.linux-procfd.expected.json', import.meta.url), 'utf8'));
    const source = fs.readFileSync(new URL('./grantResolver.linux-procfd.mjs', import.meta.url), 'utf8');
    assert.deepEqual(Object.keys(expected), ['tests']);
    assert.ok(Number.isSafeInteger(expected.tests) && expected.tests > 0);
    assert.equal(source.match(/^test\(/gm).length, expected.tests, 'every top-level test of the Linux-only file is counted');
    assert.equal(/\.skip|\.todo|\{\s*skip|\{\s*todo/.test(source), false, 'the Linux-only file never skips');
});
