// T0-01 survey (plan g4-apparatus-target-plan, Stage 0 table; P0 note :173; plan_codex §5.0:224, :234; G5 clock offset).
// Runs as container root inside the fixture agent container on I-0, with no keeper. Values are recorded and are
// informational. The graded part is that every survey value was recorded and that the negative control can tell a
// Unix-socket connect that is refused (/tmp, expected EACCES on fuse-overlayfs) from one that works on tmpfs.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { accessResult, run, which } from '../lib/exec.mjs';
import { CAP_FIELDS, createScanner, mountFor } from '../lib/procScan.mjs';

export const id = 'T0-01';
export const planRefs = ['p0-g1-mechanism-and-g4-proposal_claude.md:173', 'plan_codex.md:224', 'plan_codex.md:234', 'plan_codex.md:1142'];
export const rows = [];
export const expected = 'Survey values recorded: id maps, five capability sets, NNP, Seccomp, tools, bwrap version and userns flags, '
    + 'filesystem types of /tmp /run /dev/shm, bwrap child AppArmor label, max_user_namespaces, limits, cgroup controllers '
    + 'and writability, node:sqlite, three clock samples each from host, Box and agent. Kernel and '
    + 'restrict_unprivileged_unconfined recorded as drift against P0.';
export const controlCommand = 'Unix-socket listen+connect at /tmp/<marker>-s.sock, /dev/shm/<marker>-s.sock and (if tmpfs) /run/<marker>-s.sock';
export const controlExpected = '/tmp connect fails with EACCES while a tmpfs location (/dev/shm, or /run if tmpfs) succeeds';

const TOOLS = ['bwrap', 'nft', 'nsenter', 'setpriv', 'unshare', 'python3', 'pasta', 'ip', 'keyctl', 'capsh', 'getent', 'tar', 'ss', 'sh'];
const P0_REFERENCE = Object.freeze({ kernel: '7.0.0-38-generic', restrictUnprivilegedUnconfined: 'absent from the P0 note' });

function readText(file) {
    try {
        return { ok: true, value: fs.readFileSync(file, 'utf8').trim() };
    } catch (error) {
        return { ok: false, errno: error.code ?? 'ERR' };
    }
}

function socketConnect(socketPath) {
    return new Promise((resolve) => {
        const server = net.createServer((socket) => socket.end());
        const finish = (result) => {
            server.close(() => {
                try { fs.unlinkSync(socketPath); } catch { /* never created */ }
                resolve(result);
            });
        };
        server.on('error', (error) => resolve({ listen: error.code ?? 'ERR', connect: null }));
        server.listen(socketPath, () => {
            const client = net.connect(socketPath);
            const timer = setTimeout(() => { client.destroy(); finish({ listen: 'ok', connect: 'ETIMEDOUT' }); }, 3000);
            client.on('connect', () => { clearTimeout(timer); client.destroy(); finish({ listen: 'ok', connect: 'ok' }); });
            client.on('error', (error) => { clearTimeout(timer); finish({ listen: 'ok', connect: error.code ?? 'ERR' }); });
        });
    });
}

export async function collect(ctx) {
    const scanner = createScanner({ procRoot: ctx.procRoot });
    const status = scanner.status('self');
    const mounts = scanner.mountinfo('self') ?? [];
    const fsType = (target) => {
        const entry = mountFor(mounts, target);
        return entry ? { mountPoint: entry.mountPoint, fsType: entry.fsType, options: entry.options } : null;
    };
    const tools = Object.fromEntries(TOOLS.map((tool) => [tool, which(tool)]));
    const bwrap = tools.bwrap;
    const help = bwrap ? run(bwrap, ['--help']) : null;
    const helpText = help ? `${help.stdout}\n${help.stderr}` : '';
    const agentClock = [];
    for (let i = 0; i < 3; i += 1) agentClock.push({ epochMs: Date.now(), hrtimeNs: process.hrtime.bigint().toString() });
    let nodeSqlite;
    try {
        await import('node:sqlite');
        nodeSqlite = { available: true };
    } catch (error) {
        nodeSqlite = { available: false, error: error.code ?? error.message };
    }
    const observedValues = {
        kernel: os.release(),
        arch: process.arch,
        node: { execPath: process.execPath, version: process.version },
        uidMap: scanner.idMap('self', 'uid_map'),
        gidMap: scanner.idMap('self', 'gid_map'),
        caps: status ? status.caps : null,
        noNewPrivs: status ? status.noNewPrivs : null,
        seccomp: status ? status.seccomp : null,
        tools,
        bwrapVersion: bwrap ? run(bwrap, ['--version']) : null,
        bwrapHelp: help ? {
            rc: help.rc,
            disableUserns: helpText.split('\n').filter((line) => line.includes('--disable-userns')),
            assertUsernsDisabled: helpText.split('\n').filter((line) => line.includes('--assert-userns-disabled')),
        } : null,
        fsTypes: { '/tmp': fsType('/tmp'), '/run': fsType('/run'), '/dev/shm': fsType('/dev/shm') },
        selfLabel: readText(path.join(ctx.procRoot, 'self/attr/current')),
        bwrapChildLabel: bwrap ? run(bwrap, ['--dev-bind', '/', '/', '--', '/usr/bin/cat', '/proc/self/attr/current']) : null,
        maxUserNamespaces: readText(path.join(ctx.procRoot, 'sys/user/max_user_namespaces')),
        apparmorSysctls: {
            restrictUnprivilegedUserns: readText(path.join(ctx.procRoot, 'sys/kernel/apparmor_restrict_unprivileged_userns')),
            restrictUnprivilegedUnconfined: readText(path.join(ctx.procRoot, 'sys/kernel/apparmor_restrict_unprivileged_unconfined')),
        },
        limits: scanner.limits('self'),
        cgroup: {
            controllers: readText('/sys/fs/cgroup/cgroup.controllers'),
            procsWritable: accessResult('/sys/fs/cgroup/cgroup.procs', fs.constants.W_OK),
            subtreeControlWritable: accessResult('/sys/fs/cgroup/cgroup.subtree_control', fs.constants.W_OK),
        },
        nodeSqlite,
        clock: { agent: agentClock, host: ctx.clock?.host ?? null, box: ctx.clock?.box ?? null },
        p0Reference: P0_REFERENCE,
    };
    const locations = ['/tmp', '/dev/shm'];
    if (observedValues.fsTypes['/run']?.fsType === 'tmpfs' && observedValues.fsTypes['/run'].mountPoint === '/run') locations.push('/run');
    const control = {};
    for (const location of locations) {
        control[location] = await socketConnect(path.join(location, `${ctx.marker}-s.sock`));
    }
    const tmpfsOk = locations.filter((location) => location !== '/tmp' && control[location].connect === 'ok'
        && observedValues.fsTypes[location]?.fsType === 'tmpfs');
    control.runtimeRoot = tmpfsOk.includes('/run') ? '/run' : (tmpfsOk[0] ?? null);
    return {
        observed: observedValues,
        negativeControl: { command: controlCommand, expected: controlExpected, observed: control },
        measurements: { runtimeRoot: control.runtimeRoot },
        unreadable: scanner.unreadable,
    };
}

function recorded(value) {
    return value !== undefined && value !== null;
}

export function grade(observedValues, control) {
    const notes = [];
    const v = observedValues ?? {};
    const required = {
        kernel: typeof v.kernel === 'string' && v.kernel !== '',
        uidMap: Array.isArray(v.uidMap) && v.uidMap.length > 0,
        gidMap: Array.isArray(v.gidMap) && v.gidMap.length > 0,
        caps: recorded(v.caps) && CAP_FIELDS.every((name) => typeof v.caps[name] === 'string'),
        noNewPrivs: Number.isInteger(v.noNewPrivs),
        seccomp: Number.isInteger(v.seccomp),
        tools: recorded(v.tools),
        bwrapVersion: recorded(v.bwrapVersion) && (v.bwrapVersion.rc !== null || v.bwrapVersion.error !== null),
        bwrapHelp: recorded(v.bwrapHelp),
        fsTypes: ['/tmp', '/run', '/dev/shm'].every((target) => recorded(v.fsTypes?.[target]?.fsType)),
        bwrapChildLabel: recorded(v.bwrapChildLabel),
        maxUserNamespaces: v.maxUserNamespaces?.ok === true,
        limits: recorded(v.limits) && Object.keys(v.limits).length > 0,
        cgroup: recorded(v.cgroup?.controllers) && recorded(v.cgroup?.procsWritable) && recorded(v.cgroup?.subtreeControlWritable),
        nodeSqlite: typeof v.nodeSqlite?.available === 'boolean',
        clock: Array.isArray(v.clock?.agent) && v.clock.agent.length === 3
            && Array.isArray(v.clock?.host) && v.clock.host.length === 3
            && Array.isArray(v.clock?.box) && v.clock.box.length === 3,
    };
    for (const [name, ok] of Object.entries(required)) if (!ok) notes.push(`survey value not recorded: ${name}`);
    const c = control ?? {};
    const tmpRefused = c['/tmp']?.listen === 'ok' && c['/tmp']?.connect === 'EACCES';
    const tmpfsWorks = c.runtimeRoot !== null && c.runtimeRoot !== undefined && c[c.runtimeRoot]?.connect === 'ok';
    if (!tmpRefused) notes.push(`/tmp connect was ${c['/tmp']?.connect ?? 'not observed'} (listen ${c['/tmp']?.listen ?? '-'}), expected EACCES`);
    if (!tmpfsWorks) notes.push('no tmpfs location accepted the connect');
    return { expectedMet: notes.filter((note) => note.startsWith('survey')).length === 0, controlOppositeMet: tmpRefused && tmpfsWorks, notes };
}
