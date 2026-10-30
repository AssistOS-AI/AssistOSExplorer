// Classic-BPF seccomp compiler (plan Revision 10, section C). The output is for `bwrap --seccomp <fd>`: a Buffer of
// 8-byte little-endian `struct sock_filter { u16 code; u8 jt; u8 jf; u32 k }` entries.
//
// Program layout: load arch; if it is not the expected audit arch -> KILL_PROCESS; load nr; on x86_64 a set x32 bit ->
// KILL_PROCESS; each denied nr -> ERRNO(EPERM); otherwise ALLOW.
//
//   compileSeccomp(profile, arch)       profile 'orchestration' | 'workload', arch 'x86_64' | 'aarch64'
//   evaluateSeccomp(buf, {arch, nr})    'allow' | 'eperm' | 'kill'   (test interpreter; nr/arch as in seccomp_data)
//
// Unknown profile or arch throws.

import { AUDIT_ARCH, DENIED_ALL, DENIED_ORCHESTRATION_EXTRA, SYSCALLS, X32_SYSCALL_BIT } from './syscallTables.mjs';

export const PROFILES = Object.freeze(['orchestration', 'workload']);

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JSET_K = 0x45;
const BPF_RET_K = 0x06;

const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const EPERM = 1;

const OFFSET_NR = 0;
const OFFSET_ARCH = 4;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function compileSeccomp(profile, arch) {
    if (!PROFILES.includes(profile)) throw new Error(`Unknown seccomp profile: ${String(profile)}`);
    if (typeof arch !== 'string' || !hasOwn(AUDIT_ARCH, arch)) throw new Error(`Unknown seccomp architecture: ${String(arch)}`);
    const names = profile === 'orchestration' ? [...DENIED_ALL, ...DENIED_ORCHESTRATION_EXTRA] : [...DENIED_ALL];
    const numbers = names.map((name) => SYSCALLS[arch][name]);

    // Instructions are built with symbolic targets, resolved once the tail positions are known.
    const program = [];
    const emit = (code, k, jt = null, jf = null) => program.push({ code, k, jt, jf });
    emit(BPF_LD_W_ABS, OFFSET_ARCH);
    emit(BPF_JMP_JEQ_K, AUDIT_ARCH[arch], 'next', 'kill');
    emit(BPF_LD_W_ABS, OFFSET_NR);
    if (arch === 'x86_64') emit(BPF_JMP_JSET_K, X32_SYSCALL_BIT, 'kill', 'next');
    for (const nr of numbers) emit(BPF_JMP_JEQ_K, nr, 'eperm', 'next');
    const allowAt = program.length;
    emit(BPF_RET_K, SECCOMP_RET_ALLOW);
    const epermAt = program.length;
    emit(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM);
    const killAt = program.length;
    emit(BPF_RET_K, SECCOMP_RET_KILL_PROCESS);

    const targets = { eperm: epermAt, kill: killAt };
    const buffer = Buffer.alloc(program.length * 8);
    program.forEach((ins, index) => {
        const resolve = (target) => {
            if (target === null) return 0;
            const absolute = target === 'next' ? index + 1 : targets[target];
            const offset = absolute - index - 1;
            if (offset < 0 || offset > 255) throw new Error('BPF jump out of range');
            return offset;
        };
        buffer.writeUInt16LE(ins.code, index * 8);
        buffer.writeUInt8(resolve(ins.jt), index * 8 + 2);
        buffer.writeUInt8(resolve(ins.jf), index * 8 + 3);
        buffer.writeUInt32LE(ins.k >>> 0, index * 8 + 4);
    });
    if (allowAt !== epermAt - 1) throw new Error('BPF layout error');
    return buffer;
}

// Minimal cBPF interpreter for the three instruction forms the compiler emits.
export function evaluateSeccomp(buffer, { arch, nr }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length % 8 !== 0) throw new Error('Invalid BPF program');
    if (typeof arch !== 'string' || !hasOwn(AUDIT_ARCH, arch)) throw new Error(`Unknown seccomp architecture: ${String(arch)}`);
    const data = Buffer.alloc(8);
    data.writeUInt32LE(nr >>> 0, OFFSET_NR);
    data.writeUInt32LE(AUDIT_ARCH[arch], OFFSET_ARCH);
    let accumulator = 0;
    let pc = 0;
    for (let steps = 0; steps < 4096 && pc < buffer.length / 8; steps += 1) {
        const code = buffer.readUInt16LE(pc * 8);
        const jt = buffer.readUInt8(pc * 8 + 2);
        const jf = buffer.readUInt8(pc * 8 + 3);
        const k = buffer.readUInt32LE(pc * 8 + 4);
        if (code === BPF_LD_W_ABS) {
            accumulator = data.readUInt32LE(k);
            pc += 1;
        } else if (code === BPF_JMP_JEQ_K) {
            pc += 1 + (accumulator === k ? jt : jf);
        } else if (code === BPF_JMP_JSET_K) {
            pc += 1 + ((accumulator & k) !== 0 ? jt : jf);
        } else if (code === BPF_RET_K) {
            if (k === SECCOMP_RET_ALLOW) return 'allow';
            if (k === (SECCOMP_RET_ERRNO | EPERM)) return 'eperm';
            if (k === SECCOMP_RET_KILL_PROCESS) return 'kill';
            throw new Error(`Unexpected BPF return value: ${k}`);
        } else {
            throw new Error(`Unsupported BPF opcode: ${code}`);
        }
    }
    throw new Error('BPF program did not return');
}
