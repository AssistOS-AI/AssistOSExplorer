import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const READER_MODULE = '/run/ploinky-cgroup/cgroupRecoveryReceipt.mjs';
const WORKLOADS = '/run/ploinky/cgroup/workloads';
const CHILD = /^\/run\/ploinky\/cgroup\/workloads\/x-[a-f0-9]{32}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/u;
const MAX_IDENTITY = 18446744073709551615n;

function invalid() {
    return Object.assign(new Error('The runtime cgroup recovery receipt is not available.'), { code: 'PLOINKY_CGROUP_RECOVERY_INVALID' });
}

function decimal(value, positive = false) {
    return typeof value === 'string' && DECIMAL.exec(value)?.[0] === value && BigInt(value) <= MAX_IDENTITY && (!positive || value !== '0');
}

function contextKey(context) {
    if (!context || !decimal(context.dev) || !decimal(context.ino, true) || !decimal(context.namespace, true)) return null;
    return `${context.dev}:${context.ino}:${context.namespace}`;
}

function physicalKey(context) {
    if (context?.workloads?.workerPath !== WORKLOADS) return null;
    return contextKey({ dev: context.workloads.dev, ino: context.workloads.ino, namespace: context.workerCgroupNamespace });
}

// The runtime-owned reader authenticates the full signed envelope, fixed RO delivery and current kernel/recipient
// context. This adapter neither reads an alternate receipt nor implements another signature or filesystem authority.
// reader/fsApi are unit-test seams; production always imports the fixed runtime helper with the authoritative env.
export async function loadCgroupRecoveryProof({ env = process.env, reader, fsApi = fs } = {}) {
    if (!Object.hasOwn(env, 'PLOINKY_CGROUP_SUBTREE')) return null;
    try {
        if (env.PLOINKY_CGROUP_SUBTREE !== WORKLOADS) throw invalid();
        const canonicalWorkspace = fsApi.realpathSync(env.PLOINKY_WORKSPACE_ROOT);
        if (typeof canonicalWorkspace !== 'string' || !path.isAbsolute(canonicalWorkspace) || canonicalWorkspace === '/') throw invalid();
        const workspacePathHash = crypto.createHash('sha256').update(canonicalWorkspace, 'utf8').digest('hex');
        const read = reader ?? (await import(READER_MODULE)).readVerifiedCgroupRecoveryReceipt;
        if (typeof read !== 'function') throw invalid();
        const result = await read({ env });
        const payload = result?.payload;
        if (payload?.schema !== 'ploinky.cgroup-recovery.v1' || payload.owner?.workspacePathHash !== workspacePathHash
            || payload.owner?.principal !== env.PLOINKY_AGENT_ID || !Array.isArray(payload.priorContexts) || payload.priorContexts.length > 64
            || typeof result.envelopeSha256 !== 'string' || result.envelopeSha256.length !== 64 || !/^[a-f0-9]{64}$/u.test(result.envelopeSha256)) throw invalid();
        const current = physicalKey(payload.recipient?.context);
        if (current === null) throw invalid();
        const prior = new Set();
        for (const entry of payload.priorContexts) {
            const key = physicalKey(entry.context);
            if (key === null || entry.proof?.kind !== 'exact-engine-and-native-root-absence') throw invalid();
            if (key !== current) prior.add(key);
        }
        // Snapshot only validated scalar keys. Even a mutable synthetic reader result cannot retarget the predicate.
        return Object.freeze((locator) => {
            if (typeof locator?.path !== 'string' || locator.path.length !== WORKLOADS.length + 35 || !CHILD.test(locator.path)) return false;
            const key = contextKey(locator.context);
            return key !== null && key !== current && prior.has(key);
        });
    } catch {
        throw invalid();
    }
}
