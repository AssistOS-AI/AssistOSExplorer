import test from 'node:test';
import assert from 'node:assert/strict';
import { residentProcReadBridge, buildBoxProcReadProgram } from './robowork-proc-evidence.mjs';
import { spawnSync } from 'node:child_process';

function fixture() {
    const proof = { pid: 41, ppid: 40, startToken: '141', pidNamespace: 'pid:[100]', executable: '/usr/bin/pasta' };
    const context = { proof, pid: 41, ppid: 40, stamp: '141', code: 'EACCES', direct: null };
    const fs = {
        readlinkSync() { if (context.direct) return context.direct; throw Object.assign(Error('denied'), { code: context.code }); },
        readFileSync(file) {
            assert.equal(file, '/proc/41/stat');
            return `${context.pid} (pasta) S ${context.ppid} ${Array(17).fill('0').join(' ')} ${context.stamp}\n`;
        },
    };
    context.bridge = () => residentProcReadBridge(fs, [proof]);
    return context;
}

test('only EACCES namespace/exe reads can use a Box proof for the exact live owner incarnation', () => {
    const f = fixture(), bridge = f.bridge();
    assert.equal(bridge.io.readlinkSync('/proc/41/ns/pid'), f.proof.pidNamespace);
    assert.equal(bridge.io.readlinkSync('/proc/41/exe'), f.proof.executable);
    assert.deepEqual([...bridge.used], [41]);
    f.direct = 'pid:[321]';
    assert.equal(bridge.io.readlinkSync('/proc/41/ns/pid'), f.direct, 'Readable kernel evidence is never replaced.');
});

test('PID reuse, another parent, missing fields, unknown PID and other errors cannot use a fallback', () => {
    for (const mutate of [
        f => { f.pid = 42; }, f => { f.ppid = 39; }, f => { f.stamp = '142'; },
        f => { f.proof.pidNamespace = ''; }, f => { f.code = 'ENOENT'; }, f => { f.code = 'EIO'; },
    ]) { const f = fixture(); mutate(f); assert.throws(() => f.bridge().io.readlinkSync('/proc/41/ns/pid')); }
    const f = fixture();
    for (const path of ['/proc/42/ns/pid', '/proc/41/root/data/private', '/proc/41/environ']) assert.throws(() => f.bridge().io.readlinkSync(path));
    delete f.proof.executable; assert.throws(() => f.bridge().io.readlinkSync('/proc/41/exe'));
});

test('Box proof serialization is bounded and self-contained and a missing init cannot emit evidence', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', buildBoxProcReadProgram(0)], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), 'Invalid exact Box process-link proof');
});
