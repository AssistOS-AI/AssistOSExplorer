export const GPU_HELP = [
    'GPU shares use NVIDIA MPS and are best-effort, not a security boundary.',
    'Share clients use the same Box user as the MPS daemon. They can issue control commands, widen settings, stop the daemon and alter its writable pipe-directory entries.',
    'A process that drops the MPS environment can use the GPU outside MPS in DEFAULT compute mode.',
    'The MPS device-memory limit applies to each CUDA process, not to the sum of every process in an agent.',
    'A RAM cgroup limit does not cap dedicated GPU memory.',
    'Only the host operator may choose EXCLUSIVE_PROCESS. It affects other CUDA users and workspaces. Ploinky never changes compute mode.',
];

export const AUTHORITY_HELP = 'Store files are outside agent-visible workspace mounts, but eligible workspace-capable agents may read the workspace master key and forge administrator cookie/CSRF requests. This exposure is accepted for v1. Bearer rejection and direct store isolation do not remove it.';

export function sameToken(left, right) {
    return Boolean(left && right && left.epoch === right.epoch && left.revision === right.revision);
}

export function createDraft(agent, token) {
    const limits = agent.configured || {};
    return {
        cpus: limits.cpus == null ? '' : String(limits.cpus),
        memoryPercent: limits.memoryPercent == null ? '' : String(limits.memoryPercent),
        smPercent: limits.gpu?.smPercent == null ? '' : String(limits.gpu.smPercent),
        vramPercent: limits.gpu?.vramPercent == null ? '' : String(limits.gpu.vramPercent),
        baseToken: token,
        dirty: false,
        conflict: false,
    };
}

export function draftLimits(draft) {
    const result = {};
    function number(field, min, max, integer = false) {
        const raw = String(draft[field] ?? '').trim();
        if (!raw) return undefined;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
            throw new Error(`${field} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}.`);
        }
        return value;
    }
    const cpus = number('cpus', 0.05, Number.MAX_SAFE_INTEGER);
    if (cpus !== undefined && !/^\d+(\.\d{1,2})?$/.test(String(cpus))) throw new Error('CPU cores must have at most two decimal places.');
    const memoryPercent = number('memoryPercent', 1, 100, true);
    const smPercent = number('smPercent', 1, 100, true);
    const vramPercent = number('vramPercent', 1, 100, true);
    if (cpus !== undefined) result.cpus = cpus;
    if (memoryPercent !== undefined) result.memoryPercent = memoryPercent;
    if (smPercent !== undefined || vramPercent !== undefined) {
        if (smPercent === undefined || vramPercent === undefined) throw new Error('GPU share requires both SM and VRAM percentages.');
        result.gpu = { smPercent, vramPercent };
    }
    if (!Object.keys(result).length) throw new Error('Enter at least one limit, or clear the stored override.');
    return result;
}

export function reconcileDrafts(agents, token, drafts = new Map()) {
    const next = new Map();
    for (const agent of agents || []) {
        const draft = drafts.get(agent.ref);
        next.set(agent.ref, draft?.dirty ? draft : createDraft(agent, token));
    }
    return next;
}

export function describeProblem(instance) {
    const problem = instance.problem;
    if (!problem) return '';
    const root = problem.rootCause;
    if (instance.availability === 'blocked') {
        const dependency = problem.blockedBy?.ref || problem.blockedBy?.key || 'required dependency';
        return `Blocked by ${dependency}. ${root ? `Root refusal ${root.ref || root.key || ''}. ` : ''}${root?.reason || problem.reason || ''} ${root?.fix || problem.fix || ''}`.trim();
    }
    return `${instance.availability === 'refused' ? 'Refused. ' : ''}${problem.reason || ''} ${problem.fix || ''}`.trim();
}

export function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const unit = bytes === 0 ? 0 : Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
    return `${(bytes / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

export function describeApplied(limits) {
    if (!limits) return 'Applied limits unavailable';
    const cpu = limits.cpu?.assurance === 'kernel' ? `${limits.cpu.cores} cores (kernel)` : 'no limit';
    const memory = limits.memory?.assurance === 'kernel' ? `${formatBytes(limits.memory.bytes)} (kernel)` : 'no limit';
    const gpu = limits.gpu?.assurance === 'best-effort'
        ? `${limits.gpu.smPercent}% SM / ${formatBytes(limits.gpu.vramBytes)} per CUDA process (best-effort)` : 'no GPU share';
    return `CPU ${cpu}; RAM ${memory}; GPU ${gpu}`;
}

export function describeUsage(instance) {
    const usage = instance.usage || {};
    const cpu = Number.isFinite(usage.cpuPercent) ? `${usage.cpuPercent.toFixed(1)}% of one core` : 'unknown';
    if (!instance.limits) return `CPU ${cpu}; RAM ${Number.isFinite(usage.memoryBytes) ? formatBytes(usage.memoryBytes) : 'unknown'}; applied limits unavailable`;
    const quota = instance.limits?.cpu?.assurance === 'kernel' ? ` / ${instance.limits.cpu.cores * 100}% quota` : ' / no limit';
    const memory = Number.isFinite(usage.memoryBytes) ? formatBytes(usage.memoryBytes) : 'unknown';
    const cap = instance.limits?.memory?.assurance === 'kernel' ? formatBytes(instance.limits.memory.bytes) : 'no limit';
    return `CPU ${cpu}${quota}; RAM ${memory} / ${cap}`;
}
