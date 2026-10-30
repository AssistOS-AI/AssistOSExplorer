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
