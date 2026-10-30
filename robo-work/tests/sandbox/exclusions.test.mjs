import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkRelativeExclusion, dropCovered, mapVirtualExclusions, resolveExclusions, verifyExclusionMasks } from '../../server/sandbox/exclusions.mjs';

const dirFd = (dir) => fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
function tree(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-excl-'));
    const grant = path.join(root, 'grant');
    fs.mkdirSync(path.join(grant, 'docs', 'private'), { recursive: true });
    fs.writeFileSync(path.join(grant, 'docs', 'private', 'a.txt'), 'x');
    fs.writeFileSync(path.join(grant, 'notes.txt'), 'n');
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(root, 'outside', 'secret'), 's');
    const fd = dirFd(grant);
    try { return fn({ root, grant, fd }); } finally { fs.closeSync(fd); fs.rmSync(root, { recursive: true, force: true }); }
}

test('a relative exclusion must be a plain path: no absolute path, no empty . or .. component, no NUL, bounded', () => {
    assert.equal(checkRelativeExclusion('docs/private'), 'docs/private');
    for (const bad of ['/etc/passwd', '/', '..', '../x', 'a/../b', 'a/..', '.', './a', 'a/./b', 'a//b', 'a/', '', 'a\0b', 'x'.repeat(1025), `${'y'.repeat(256)}/z`, 7, null]) {
        assert.throws(() => checkRelativeExclusion(bad), { code: 'invalid_request' }, JSON.stringify(bad)?.slice(0, 40));
    }
});

test('virtual paths map to the grant-relative path of the admitted grant that holds them; anything else is refused', () => {
    const grants = [{ name: 'a', path: '/projects/a' }, { name: 'ab', path: '/projects/ab' }];
    const mapped = mapVirtualExclusions(['/projects/a/docs/private', '/projects/ab/x', '/projects/a/docs/private', '/projects/a/n.txt'], grants);
    assert.deepEqual([...mapped], [['a', ['docs/private', 'n.txt']], ['ab', ['x']]]);
    for (const bad of ['/projects/a', '/projects/a/', '/projects/c/x', '/home/robot/.ssh', '/tmp/x', 'projects/a/x', '/projects/a/../ab/x', '/projects/abc/x', '/projects/a/a\0b']) {
        assert.throws(() => mapVirtualExclusions([bad], grants), { code: 'invalid_request' }, bad);
    }
    assert.equal(mapVirtualExclusions(undefined, grants).size, 0);
});

test('resolve: an existing file or directory is found; one that does not exist is skipped and never created', () => tree(({ grant, fd }) => {
    const found = resolveExclusions(fd, ['docs/private', 'notes.txt', 'nothing/here', 'docs/missing', 'notes.txt/under-a-file']);
    assert.deepEqual(found, [{ rel: 'docs/private', kind: 'dir' }, { rel: 'notes.txt', kind: 'file' }]);
    assert.ok(!fs.existsSync(path.join(grant, 'nothing')) && !fs.existsSync(path.join(grant, 'docs', 'missing')), 'nothing was created');
}));

test('resolve: a symlink anywhere on the path, the last component included, is refused with invalid_request', () => tree(({ root, grant, fd }) => {
    fs.symlinkSync(path.join(root, 'outside'), path.join(grant, 'linkdir'));
    fs.symlinkSync(path.join(root, 'outside', 'secret'), path.join(grant, 'linkfile'));
    fs.symlinkSync('docs', path.join(grant, 'relative-link'));
    for (const rel of ['linkdir/secret', 'linkdir', 'linkfile', 'relative-link/private', 'docs/private/../../linkdir']) {
        assert.throws(() => resolveExclusions(fd, [rel]), { code: 'invalid_request' }, rel);
    }
    // a link swapped in after the lstat is caught by O_NOFOLLOW at open time
    const swapped = { open: () => { throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' }); } };
    assert.throws(() => resolveExclusions(fd, ['docs/private'], swapped), { code: 'invalid_request' });
}));

test('covered exclusions are dropped: a path equal to or below a masked directory is already hidden', () => {
    const kept = dropCovered([{ rel: 'a/b/c', kind: 'file' }, { rel: 'a/b', kind: 'dir' }, { rel: '.data/x', kind: 'file' }, { rel: 'z', kind: 'file' }, { rel: 'z', kind: 'file' }], [{ rel: '.data', kind: 'dir' }]);
    assert.deepEqual(kept.map((entry) => entry.rel), ['z', 'a/b']);
});

test('verification reads each exclusion back through the staging view: it must carry the mask\'s device and inode', () => tree(({ grant, fd }) => {
    const dirStat = fs.statSync(path.join(grant, 'docs', 'private'), { bigint: true });
    const fileStat = fs.statSync(path.join(grant, 'notes.txt'), { bigint: true });
    const entries = [{ rel: 'docs/private', kind: 'dir' }, { rel: 'notes.txt', kind: 'file' }];
    assert.deepEqual(verifyExclusionMasks(fd, entries, { dir: dirStat, file: fileStat }), { ok: true, checked: 2 });
    assert.throws(() => verifyExclusionMasks(fd, entries, { dir: dirStat, file: { dev: fileStat.dev, ino: fileStat.ino + 1n } }), { code: 'mask_unverified' });
    assert.throws(() => verifyExclusionMasks(fd, [{ rel: 'vanished', kind: 'file' }], { dir: dirStat, file: fileStat }), { code: 'mask_unverified' });
}));

// ---- M-19: read-back without following a swapped intermediate directory --------------------------------------------------

function swapTree(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-swap-'));
    const grant = path.join(root, 'grant');
    for (const name of ['a', 'b']) { fs.mkdirSync(path.join(grant, name), { recursive: true }); fs.writeFileSync(path.join(grant, name, 'x'), name); }
    const fd = dirFd(grant);
    try { return fn({ grant, fd }); } finally { fs.closeSync(fd); fs.rmSync(root, { recursive: true, force: true }); }
}

// a/x is the exclusion that was meant to be masked; the "mask" the attacker managed to have verified is the inode of b/x.
const swapAToLinkB = (grant) => { fs.renameSync(path.join(grant, 'a'), path.join(grant, 'a.orig')); fs.symlinkSync('b', path.join(grant, 'a')); };

test('M-19: verification walks per component with O_NOFOLLOW: an intermediate directory swapped for a symlink during verification is mask_unverified', () => swapTree(({ grant, fd }) => {
    const bx = fs.statSync(path.join(grant, 'b', 'x'), { bigint: true });
    const maskIds = { dir: bx, file: bx };
    const entries = [{ rel: 'a/x', kind: 'file' }];
    // sanity: without the swap, a/x is not the mask, so it is not verified either
    assert.throws(() => verifyExclusionMasks(fd, entries, maskIds), { code: 'mask_unverified' });
    // the swap happens between two components of the walk (inside open), exactly the race
    const swapping = { open: (file) => { swapAToLinkB(grant); return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); } };
    assert.throws(() => verifyExclusionMasks(fd, entries, maskIds, swapping), { code: 'mask_unverified' });
}));

test('M-19: an intermediate symlink that is already in place when verification starts is mask_unverified, not a verification of the link target', () => swapTree(({ grant, fd }) => {
    swapAToLinkB(grant);
    const bx = fs.statSync(path.join(grant, 'b', 'x'), { bigint: true });
    // the old multi-component lstat of fd/a/x would follow the link, find b/x and report the mask as present
    assert.equal(String(fs.lstatSync(`/proc/self/fd/${fd}/a/x`, { bigint: true }).ino), String(bx.ino), 'precondition: a path walk through the link does reach b/x');
    assert.throws(() => verifyExclusionMasks(fd, [{ rel: 'a/x', kind: 'file' }], { dir: bx, file: bx }), { code: 'mask_unverified' });
    // a final component that is itself a link is not a mask either
    fs.symlinkSync('b/x', path.join(grant, 'link-to-bx'));
    assert.throws(() => verifyExclusionMasks(fd, [{ rel: 'link-to-bx', kind: 'file' }], { dir: bx, file: bx }), { code: 'mask_unverified' });
}));

test('M-19: a masked, unswapped multi-component exclusion still verifies, and every descriptor opened by the walk is closed', () => swapTree(({ grant, fd }) => {
    // one mask file bind-mounted at two places shares one inode: modelled by a hard link
    fs.mkdirSync(path.join(grant, 'a', 'deep'));
    fs.linkSync(path.join(grant, 'a', 'x'), path.join(grant, 'a', 'deep', 'y'));
    const mask = fs.statSync(path.join(grant, 'a', 'x'), { bigint: true });
    const opened = [];
    const closed = [];
    const io = {
        open: (file) => { const o = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); opened.push(o); return o; },
        close: (o) => { closed.push(o); fs.closeSync(o); }
    };
    const result = verifyExclusionMasks(fd, [{ rel: 'a/x', kind: 'file' }, { rel: 'a/deep/y', kind: 'file' }], { dir: mask, file: mask }, io);
    assert.deepEqual(result, { ok: true, checked: 2 });
    assert.equal(opened.length, 3);
    assert.deepEqual([...closed].sort(), [...opened].sort(), 'no descriptor leaks');
}));

test('M-19 (confirmation): protectedScan.verifyMasks rescans per component too: a directory swapped for a symlink is not descended and the missing entry fails the count', async () => {
    const { scanProtected, verifyMasks } = await import('../../server/sandbox/protectedScan.mjs');
    swapTree(({ grant, fd }) => {
        fs.rmSync(path.join(grant, 'a', 'x')); fs.rmSync(path.join(grant, 'b', 'x'));
        fs.writeFileSync(path.join(grant, 'a', '.env'), 'a');
        fs.linkSync(path.join(grant, 'a', '.env'), path.join(grant, 'b', '.env')); // one mask inode at both places
        const { entries } = scanProtected(fd);
        const mask = fs.statSync(path.join(grant, 'a', '.env'), { bigint: true });
        assert.deepEqual(verifyMasks(fd, entries, { dir: mask, file: mask }), { ok: true, checked: 2 });
        swapAToLinkB(grant);
        assert.throws(() => verifyMasks(fd, entries, { dir: mask, file: mask }), { code: 'mask_unverified' });
    });
});
