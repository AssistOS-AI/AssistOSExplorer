import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { scanProtected, verifyMasks } from '../../server/sandbox/protectedScan.mjs';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-scan-'));
    const write = (rel, data = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };
    write('.env');
    write('master-key');
    write('x.secrets');
    write('src/a.js');
    write('src/.ENV');
    write('src/.data/inner/.env');
    write('.ploinky/deep/file');
    write('a/b/c/ok.txt');
    write('a/b/c/Prod.SECRETS');
    fs.symlinkSync('/etc', path.join(root, '.roboteam'));
    fs.symlinkSync('src', path.join(root, 'link'));
    return root;
}

function withDir(root, fn) {
    const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { return fn(fd); } finally { fs.closeSync(fd); }
}

const fdCount = () => fs.readdirSync('/proc/self/fd').length;

test('finds protected entries, folds spellings, skips symlinks, does not descend', () => {
    const root = fixture();
    try {
        const before = fdCount();
        const { entries, scanned } = withDir(root, (fd) => scanProtected(fd));
        assert.equal(fdCount(), before);
        const got = Object.fromEntries(entries.map((e) => [e.rel, e.kind]));
        assert.deepEqual(got, {
            '.env': 'file', 'master-key': 'file', 'x.secrets': 'file', '.ploinky': 'dir', 'src/.ENV': 'file',
            'src/.data': 'dir', 'a/b/c/Prod.SECRETS': 'file'
        });
        assert.ok(!('.roboteam' in got), 'protected symlink is not returned');
        assert.ok(!Object.keys(got).some((k) => k.includes('inner') || k.includes('deep')), 'no descent into protected dirs');
        assert.ok(scanned >= 10);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('limits: entries, masks and depth give mask_scan_limit; unreadable gives scan_unreadable', () => {
    const root = fixture();
    try {
        withDir(root, (fd) => {
            assert.throws(() => scanProtected(fd, { maxEntries: 3 }), { code: 'mask_scan_limit' });
            assert.throws(() => scanProtected(fd, { maxMasks: 2 }), { code: 'mask_scan_limit' });
            assert.throws(() => scanProtected(fd, { maxDepth: 1 }), { code: 'mask_scan_limit' });
        });
        const before = fdCount();
        assert.throws(() => scanProtected(987654), { code: 'scan_unreadable' });
        assert.equal(fdCount(), before);
        const locked = path.join(root, 'locked');
        fs.mkdirSync(locked);
        fs.chmodSync(locked, 0);
        if (process.getuid() !== 0) {
            withDir(root, (fd) => assert.throws(() => scanProtected(fd), { code: 'scan_unreadable' }));
        }
        fs.chmodSync(locked, 0o700);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyMasks: unmasked entries fail, matching identities pass', () => {
    const root = fixture();
    try {
        withDir(root, (fd) => {
            const { entries } = scanProtected(fd);
            const dirStat = fs.statSync(path.join(root, '.ploinky'), { bigint: true });
            const fileStat = fs.statSync(path.join(root, '.env'), { bigint: true });
            const ids = { dir: { dev: dirStat.dev, ino: dirStat.ino }, file: { dev: fileStat.dev, ino: fileStat.ino } };
            // Unmasked: only .ploinky and .env happen to match; others differ.
            assert.throws(() => verifyMasks(fd, entries, ids), { code: 'mask_unverified' });
            // A set containing only matching entries passes when the rescan finds exactly that set.
            const single = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-scan1-'));
            try {
                fs.writeFileSync(path.join(single, '.env'), '');
                const st = fs.statSync(path.join(single, '.env'), { bigint: true });
                const fd2 = fs.openSync(single, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
                try {
                    const r = verifyMasks(fd2, [{ rel: '.env', kind: 'file' }], { dir: { dev: 0, ino: 0 }, file: { dev: st.dev, ino: st.ino } });
                    assert.deepEqual(r, { ok: true, checked: 1 });
                    fs.writeFileSync(path.join(single, 'new.secrets'), '');
                    assert.throws(() => verifyMasks(fd2, [{ rel: '.env', kind: 'file' }], { dir: { dev: 0, ino: 0 }, file: { dev: st.dev, ino: st.ino } }), { code: 'mask_unverified' });
                } finally { fs.closeSync(fd2); }
            } finally { fs.rmSync(single, { recursive: true, force: true }); }
        });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
