import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { diffManifests, sourceManifest, validateManifest } from '../../../.github/scripts/qaCopyManifest.mjs';

const script = new URL('../../../.github/scripts/qaCopyManifest.mjs', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-copy-manifest-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('records file bytes, execute permission and symlink targets without following links', t => {
    const root = fixture(t);
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'é\nfile'), 'hello');
    fs.writeFileSync(path.join(root, '-program'), 'run', { mode: 0o755 });
    fs.chmodSync(path.join(root, '-program'), 0o755);
    fs.symlinkSync('/outside/not-read', path.join(root, 'link'));
    const expected = [
        { path: '-program', type: 'file', sha256: sha('run'), executable: true },
        { path: 'link', type: 'symlink', sha256: sha('/outside/not-read') },
        { path: 'nested/é\nfile', type: 'file', sha256: sha('hello'), executable: false },
    ];
    assert.deepEqual(sourceManifest(root), expected);
    assert.deepEqual(sourceManifest(root), expected);
    const result = spawnSync(process.execPath, [script.pathname, root], { encoding: 'utf8', cwd: os.tmpdir() });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
});

test('reports additions, deletions, bytes, mode and link changes in deterministic path order', t => {
    const root = fixture(t);
    for (const name of ['bytes', 'deleted', 'mode']) fs.writeFileSync(path.join(root, name), 'one', { mode: 0o644 });
    fs.chmodSync(path.join(root, 'mode'), 0o644);
    fs.symlinkSync('first', path.join(root, 'link'));
    const baseline = sourceManifest(root);
    fs.writeFileSync(path.join(root, 'bytes'), 'two');
    fs.rmSync(path.join(root, 'deleted'));
    fs.chmodSync(path.join(root, 'mode'), 0o755);
    fs.unlinkSync(path.join(root, 'link'));
    fs.symlinkSync('second', path.join(root, 'link'));
    fs.writeFileSync(path.join(root, 'added'), 'new');
    assert.deepEqual(diffManifests(baseline, sourceManifest(root)), [
        { status: 'A', path: 'added' }, { status: 'M', path: 'bytes' }, { status: 'D', path: 'deleted' },
        { status: 'M', path: 'link' }, { status: 'M', path: 'mode' },
    ]);
    assert.deepEqual(diffManifests(baseline, JSON.parse(JSON.stringify(baseline))), []);
});

test('rejects malformed manifests and unsupported filesystem entries', t => {
    const file = { path: 'a', type: 'file', sha256: sha('x'), executable: false };
    for (const invalid of [null, {}, [file, file], [{ ...file, path: '../a' }], [{ ...file, sha256: 'bad' }],
        [{ ...file, extra: 1 }], [{ ...file, executable: 0 }], [file, { ...file, path: 'a/b' }]]) {
        assert.throws(() => validateManifest(invalid));
        assert.throws(() => diffManifests(invalid, []));
    }
    const root = fixture(t);
    const fifo = spawnSync('mkfifo', [path.join(root, 'pipe')]);
    assert.equal(fifo.status, 0);
    assert.throws(() => sourceManifest(root), /Unsupported source entry/);
    const result = spawnSync(process.execPath, [script.pathname, root], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Unsupported source entry/);
});

test('rejects symlink roots and oversized files before reading their contents', t => {
    const root = fixture(t);
    fs.mkdirSync(path.join(root, 'directory'));
    fs.symlinkSync('directory', path.join(root, 'root-link'));
    assert.throws(() => sourceManifest(path.join(root, 'root-link')), /directory/);
    const large = path.join(root, 'directory', 'large');
    fs.writeFileSync(large, '');
    fs.truncateSync(large, 2 * 1024 * 1024 * 1024 + 1);
    assert.throws(() => sourceManifest(path.join(root, 'directory')), /byte limit/);
});
