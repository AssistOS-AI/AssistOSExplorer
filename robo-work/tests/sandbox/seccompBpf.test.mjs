import assert from 'node:assert/strict';
import test from 'node:test';

import { compileSeccomp, evaluateSeccomp } from '../../server/sandbox/seccompBpf.mjs';
import { SYSCALLS } from '../../server/sandbox/syscallTables.mjs';

const ARCHES = ['x86_64', 'aarch64'];
const AUDIT = { x86_64: 0xc000003e, aarch64: 0xc00000b7 };

for (const arch of ARCHES) {
    for (const profile of ['orchestration', 'workload']) {
        test(`${profile} ${arch}: length is a multiple of 8, keyctl eperm, read allow`, () => {
            const buf = compileSeccomp(profile, arch);
            assert.equal(buf.length % 8, 0);
            assert.ok(buf.length > 0);
            assert.equal(evaluateSeccomp(buf, { arch, nr: SYSCALLS[arch].keyctl }), 'eperm');
            assert.equal(evaluateSeccomp(buf, { arch, nr: SYSCALLS[arch].read }), 'allow');
            for (const name of ['bpf', 'mount', 'io_uring_setup', 'mount_setattr', 'open_by_handle_at', 'kexec_load']) {
                assert.equal(evaluateSeccomp(buf, { arch, nr: SYSCALLS[arch][name] }), 'eperm', name);
            }
        });
    }
    test(`ptrace family on ${arch}: eperm in orchestration, allowed in workload`, () => {
        const orchestration = compileSeccomp('orchestration', arch);
        const workload = compileSeccomp('workload', arch);
        for (const name of ['ptrace', 'process_vm_readv', 'process_vm_writev', 'pidfd_getfd']) {
            assert.equal(evaluateSeccomp(orchestration, { arch, nr: SYSCALLS[arch][name] }), 'eperm', name);
            assert.equal(evaluateSeccomp(workload, { arch, nr: SYSCALLS[arch][name] }), 'allow', name);
        }
    });
}

test('a filter for one architecture kills on the other (arch check first)', () => {
    const x86 = compileSeccomp('workload', 'x86_64');
    const arm = compileSeccomp('workload', 'aarch64');
    // The interpreter stamps data.arch from the argument; build the mismatch by running each program against the other arch.
    assert.equal(evaluateSeccomp(x86, { arch: 'aarch64', nr: 0 }), 'kill');
    assert.equal(evaluateSeccomp(arm, { arch: 'x86_64', nr: 0 }), 'kill');
    assert.equal(x86.readUInt32LE(12), AUDIT.x86_64);
    assert.equal(arm.readUInt32LE(12), AUDIT.aarch64);
});

test('x86_64 x32 bit kills, even for an allowed or denied number', () => {
    const buf = compileSeccomp('workload', 'x86_64');
    assert.equal(evaluateSeccomp(buf, { arch: 'x86_64', nr: 0x40000000 | SYSCALLS.x86_64.read }), 'kill');
    assert.equal(evaluateSeccomp(buf, { arch: 'x86_64', nr: 0x40000000 | SYSCALLS.x86_64.keyctl }), 'kill');
});

test('unknown profile or arch throws', () => {
    assert.throws(() => compileSeccomp('nope', 'x86_64'));
    assert.throws(() => compileSeccomp('workload', 'riscv64'));
    assert.throws(() => compileSeccomp('workload', '__proto__'));
    assert.throws(() => evaluateSeccomp(compileSeccomp('workload', 'aarch64'), { arch: 'mips', nr: 0 }));
});
