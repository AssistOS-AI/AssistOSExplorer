import test from 'node:test';
import assert from 'node:assert/strict';
import { residentProcReadBridge } from './robowork-proc-evidence.mjs';

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

test('PID reuse, another parent, missing fields, unknown PID and other errors cannot use a fallback', () => {
    for (const mutate of [
        f => { f.pid = 42; }, f => { f.ppid = 39; }, f => { f.stamp = '142'; },
        f => { f.proof.pidNamespace = ''; }, f => { f.code = 'ENOENT'; }, f => { f.code = 'EIO'; },
    ]) { const f = fixture(); mutate(f); assert.throws(() => f.bridge().io.readlinkSync('/proc/41/ns/pid')); }
    const f = fixture();
    for (const path of ['/proc/42/ns/pid', '/proc/41/root/data/private', '/proc/41/environ']) assert.throws(() => f.bridge().io.readlinkSync(path));
    delete f.proof.executable; assert.throws(() => f.bridge().io.readlinkSync('/proc/41/exe'));
});
