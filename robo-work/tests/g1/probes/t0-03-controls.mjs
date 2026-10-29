// T0-03 unfiltered controls on I-0 (plan g4-apparatus-target-plan R1.7 M-5; reviewer R-5, R-6).
// Records what an UNFILTERED process in the agent container can do, so that later G1 negative controls have a
// measured baseline: `unshare --user --map-root-user`, python3 ctypes pidfd_getfd, process_vm_readv and keyctl against
// the control's own child (with the errno of each call, so a later EPERM can be told apart from the nested profile's
// ENOSYS default), reachability of the Box gateway (8080, 8081) and of a task-owned Box-internal sentinel, whether
// /proc/sys is read-only and whether ip_forward is writable (checked with access(2); nothing is written).
// Graded part: every sub-observation is determinate, and the instrument's negative control (invalid-target calls and
// a closed port) reports failures.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { accessResult, run, which } from '../lib/exec.mjs';
import { createScanner, defaultGateway, mountFor } from '../lib/procScan.mjs';

export const id = 'T0-03';
export const planRefs = ['g4-apparatus-target-plan-2026-10-28_claude.md R1.7 M-5', 'ploinky-box/seccomp/podman-nested-pid-fallback.json:2-3'];
export const rows = [];
export const expected = 'Each control call returns a determinate result (rc and errno recorded); gateway 8080/8081 and the Box-internal sentinel '
    + 'reachability recorded; /proc/sys read-only flag and ip_forward writability recorded without writing.';
export const controlExpected = 'pidfd_getfd on a bad fd, process_vm_readv on a non-existent pid, keyctl with an unknown op and a connect to a closed '
    + 'gateway port each FAIL with a recorded errno';
export const CLOSED_PORT = 18479;

const here = path.dirname(fileURLToPath(import.meta.url));

function tcpConnect(host, port, timeoutMs = 3000) {
    return new Promise((resolve) => {
        if (!host) {
            resolve({ host, port, ok: false, errno: 'NO_GATEWAY' });
            return;
        }
        const socket = net.connect({ host, port });
        const timer = setTimeout(() => { socket.destroy(); resolve({ host, port, ok: false, errno: 'ETIMEDOUT' }); }, timeoutMs);
        socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve({ host, port, ok: true, errno: null }); });
        socket.on('error', (error) => { clearTimeout(timer); resolve({ host, port, ok: false, errno: error.code ?? 'ERR' }); });
    });
}

export async function collect(ctx) {
    const scanner = createScanner({ procRoot: ctx.procRoot });
    const unshare = which('unshare');
    const python = which('python3');
    const unshareResult = unshare ? run(unshare, ['--user', '--map-root-user', '/usr/bin/true']) : { rc: null, error: 'unshare missing' };
    let pythonResult = { error: 'python3 missing' };
    if (python) {
        const out = run(python, ['-I', path.join(here, 't0-03-controls.py'), ctx.marker], { timeoutMs: 30000 });
        try {
            pythonResult = { rc: out.rc, ...JSON.parse(out.stdout.trim().split('\n').pop()) };
        } catch {
            pythonResult = { rc: out.rc, error: 'unparsable python output', stderr: out.stderr.slice(0, 2000) };
        }
    }
    const routeText = scanner.read('net/route');
    const gateway = routeText === null ? null : defaultGateway(routeText);
    const sentinel = ctx.sentinel ?? null;
    const reach = {
        gateway8080: await tcpConnect(gateway, 8080),
        gateway8081: await tcpConnect(gateway, 8081),
        boxSentinel: sentinel ? await tcpConnect(gateway, sentinel.port) : { ok: false, errno: 'NO_SENTINEL' },
    };
    const mounts = scanner.mountinfo('self') ?? [];
    const procSys = mountFor(mounts, '/proc/sys');
    const observedValues = {
        gateway,
        unshareMapRoot: { rc: unshareResult.rc, error: unshareResult.error ?? null, stderr: (unshareResult.stderr ?? '').slice(0, 2000) },
        syscalls: pythonResult,
        reach,
        sentinel,
        procSys: procSys ? { mountPoint: procSys.mountPoint, readOnly: procSys.options.includes('ro'), options: procSys.options } : null,
        ipForwardWritable: accessResult(path.join(ctx.procRoot, 'sys/net/ipv4/ip_forward'), fs.constants.W_OK),
    };
    const control = {
        invalidCalls: pythonResult.invalid ?? null,
        closedPort: await tcpConnect(gateway, CLOSED_PORT),
    };
    return {
        observed: observedValues,
        negativeControl: { command: `t0-03-controls.py invalid targets; connect ${gateway}:${CLOSED_PORT}`, expected: controlExpected, observed: control },
        measurements: {},
        unreadable: scanner.unreadable,
    };
}

function determinate(call) {
    return call !== undefined && call !== null && Number.isInteger(call.rc) && Number.isInteger(call.errno);
}

export function grade(observedValues, control) {
    const notes = [];
    const v = observedValues ?? {};
    if (!Number.isInteger(v.unshareMapRoot?.rc)) notes.push('unshare control not determinate');
    for (const name of ['pidfd_open', 'pidfd_getfd', 'process_vm_readv', 'keyctl']) {
        if (!determinate(v.syscalls?.valid?.[name])) notes.push(`syscall control ${name} not determinate`);
    }
    for (const name of ['gateway8080', 'gateway8081', 'boxSentinel']) {
        if (typeof v.reach?.[name]?.ok !== 'boolean') notes.push(`reachability ${name} not recorded`);
    }
    if (v.reach?.boxSentinel?.errno === 'NO_SENTINEL') notes.push('no Box-internal sentinel was provided');
    if (typeof v.procSys?.readOnly !== 'boolean') notes.push('/proc/sys mount not recorded');
    if (typeof v.ipForwardWritable?.ok !== 'boolean') notes.push('ip_forward writability not recorded');
    const expectedMet = notes.length === 0;
    const invalid = control?.invalidCalls ?? {};
    const failed = (call) => determinate(call) && call.rc === -1 && call.errno !== 0;
    const controlChecks = {
        pidfd_getfd_bad_fd: failed(invalid.pidfd_getfd_bad_fd),
        process_vm_readv_bad_pid: failed(invalid.process_vm_readv_bad_pid),
        keyctl_bad_op: failed(invalid.keyctl_bad_op),
        closedPort: control?.closedPort?.ok === false && typeof control.closedPort.errno === 'string',
    };
    for (const [name, ok] of Object.entries(controlChecks)) if (!ok) notes.push(`negative control ${name} did not report a failure`);
    return { expectedMet, controlOppositeMet: Object.values(controlChecks).every(Boolean), notes };
}
