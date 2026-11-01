import fs from 'node:fs';
import path from 'node:path';
import { environmentError } from './environmentRootfs.mjs';

export function effectiveCgroupSubtree(env = process.env) {
    // An explicitly invalid override must never silently select the provider's different delegation.
    const value = Object.hasOwn(env, 'ROBO_WORK_CGROUP_SUBTREE') ? env.ROBO_WORK_CGROUP_SUBTREE : env.PLOINKY_CGROUP_SUBTREE;
    if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || value.includes('\0')
        || value.includes('//') || value.endsWith('/') || value.split('/').some((part) => part === '.' || part === '..')) return null;
    return value;
}

export function createEnvironmentCgroup({ path: target, subtree, limits = {}, fsImpl = fs } = {}) {
    const fail = () => { throw environmentError('limits_unavailable'); };
    if (!subtree || typeof target !== 'string' || path.dirname(target) !== subtree || !/^x-[a-f0-9]{32}$/u.test(path.basename(target))) fail();
    const memory = limits.memoryBytes ?? 4 * 1024 ** 3;
    const cpus = limits.cpus ?? 2;
    const pids = limits.pids ?? 4096;
    if (!Number.isSafeInteger(memory) || memory < 1 || !Number.isFinite(cpus) || cpus <= 0
        || !Number.isSafeInteger(Math.round(cpus * 100000)) || !Number.isSafeInteger(pids) || pids < 1) fail();
    let identity;
    try {
        const st = fsImpl.lstatSync(subtree);
        if (!st.isDirectory() || st.isSymbolicLink() || Number(fsImpl.statfsSync(subtree).type) !== 0x63677270) fail();
        const controllers = new Set(fsImpl.readFileSync(`${subtree}/cgroup.controllers`, 'utf8').trim().split(/\s+/u));
        if (['memory', 'cpu', 'pids'].some((controller) => !controllers.has(controller))) fail();
        fsImpl.writeFileSync(`${subtree}/cgroup.subtree_control`, '+memory +cpu +pids');
        fsImpl.mkdirSync(target, { mode: 0o700 });
        const child = fsImpl.lstatSync(target, { bigint: true });
        identity = { path: target, dev: String(child.dev), ino: String(child.ino) };
        for (const [file, value] of Object.entries({ 'memory.max': String(memory), 'memory.swap.max': '0', 'memory.oom.group': '1',
            'cpu.max': `${Math.round(cpus * 100000)} 100000`, 'pids.max': String(pids) })) {
            fsImpl.writeFileSync(`${target}/${file}`, value);
            if (fsImpl.readFileSync(`${target}/${file}`, 'utf8').trim() !== value) fail();
        }
    } catch { fail(); }
    return {
        identity,
        attach(pid) {
            if (!Number.isSafeInteger(pid) || pid < 1) fail();
            try {
                const st = fsImpl.lstatSync(target, { bigint: true });
                if (String(st.dev) !== identity.dev || String(st.ino) !== identity.ino || !st.isDirectory() || st.isSymbolicLink()) fail();
                fsImpl.writeFileSync(`${target}/cgroup.procs`, String(pid));
                if (!fsImpl.readFileSync(`${target}/cgroup.procs`, 'utf8').trim().split(/\s+/u).includes(String(pid))) fail();
            } catch { fail(); }
        },
        async release() {
            try { fsImpl.rmdirSync(target); } catch (error) { if (error.code !== 'ENOENT') throw environmentError('limits_unavailable'); }
            return this.verifyAbsent();
        },
        verifyAbsent() {
            try { fsImpl.lstatSync(target); return { absent: false, problems: ['cgroup'] }; }
            catch (error) { return { absent: error.code === 'ENOENT', problems: error.code === 'ENOENT' ? [] : ['cgroup'] }; }
        },
    };
}

export function attachEnvironmentCgroup({ path: target, subtree = path.dirname(target), limits, pid, fsImpl } = {}) {
    const group = createEnvironmentCgroup({ path: target, subtree, limits, fsImpl });
    group.attach(pid);
    return group;
}
